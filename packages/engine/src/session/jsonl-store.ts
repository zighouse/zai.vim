// @zaivim/engine — JsonlSessionStore
// JSONL file-based session persistence (ADR-4, ADR-6).
// Async fire-and-forget write queue with debounced flush.

import type {
  Session,
  Message,
  SessionStatus,
  ISessionStore,
  SessionMeta,
  ZaiConfig,
} from '@zaivim/core';
import { ZaiSessionNotFoundError } from '@zaivim/core';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

const DEFAULT_SESSIONS_DIR = path.join(os.homedir(), '.zaivim', 'sessions');
const DEFAULT_WRITE_QUEUE_MAX_SIZE = 500;
const DEFAULT_FLUSH_BATCH_SIZE = 50;
const DEFAULT_FLUSH_DEBOUNCE_MS = 5;
const JSONL_FORMAT_VERSION = 1;
const ENGINE_VERSION = '0.1.0';

interface WriteQueueEntry {
  lines: string[];
  timer: ReturnType<typeof setTimeout> | null;
}

export interface JsonlSessionStoreOptions {
  sessionsDir?: string;
  writeQueueMaxSize?: number;
  flushBatchSize?: number;
  flushDebounceMs?: number;
  engineVersion?: string;
}

export type StoreNotification =
  | { type: 'session.persistence.dropped'; sessionId: string; count: number }
  | { type: 'session.recovered'; sessionId: string; recoveredCount: number; skippedLines: number };

export class JsonlSessionStore extends EventEmitter implements ISessionStore {
  #sessions: Map<string, Session> = new Map();
  #sessionMetas: Map<string, SessionMeta> = new Map();
  readonly #sessionsDir: string;
  #writeQueues: Map<string, WriteQueueEntry> = new Map();
  readonly #writeQueueMaxSize: number;
  readonly #flushBatchSize: number;
  readonly #flushDebounceMs: number;
  readonly #engineVersion: string;
  #destroyed = false;

  constructor(options: JsonlSessionStoreOptions = {}) {
    super();
    this.#sessionsDir = options.sessionsDir ?? DEFAULT_SESSIONS_DIR;
    this.#writeQueueMaxSize = options.writeQueueMaxSize ?? DEFAULT_WRITE_QUEUE_MAX_SIZE;
    this.#flushBatchSize = options.flushBatchSize ?? DEFAULT_FLUSH_BATCH_SIZE;
    this.#flushDebounceMs = options.flushDebounceMs ?? DEFAULT_FLUSH_DEBOUNCE_MS;
    this.#engineVersion = options.engineVersion ?? ENGINE_VERSION;
    fs.mkdirSync(this.#sessionsDir, { recursive: true });
  }

  // ---- ISessionStore: create ----

  create(config?: Partial<ZaiConfig>, projectDir?: string): Session {
    const session: Session = {
      id: randomUUID(),
      messages: [],
      createdAt: Date.now(),
      config: (config ?? {}) as ZaiConfig,
      status: 'active',
      projectDir,
      version: this.#engineVersion,
      seqCounter: 0,
      reconnecting: false,
    };
    this.#sessions.set(session.id, session);
    return session;
  }

  // ---- ISessionStore: get ----

  get(id: string): Session | undefined {
    return this.#sessions.get(id);
  }

  // ---- ISessionStore: list ----

  list(filter?: { status?: SessionStatus; projectDir?: string }): Session[] {
    const sessions = [...this.#sessions.values()];
    if (!filter) return sessions;
    return sessions.filter(s => {
      if (filter.status && s.status !== filter.status) return false;
      if (filter.projectDir && s.projectDir !== filter.projectDir) return false;
      return true;
    });
  }

  // ---- ISessionStore: close ----

  async close(id: string): Promise<void> {
    const session = this.#sessions.get(id);
    if (!session) throw new ZaiSessionNotFoundError(id);

    // Flush remaining queued messages, then fsync
    await this.#flushSession(id);
    await this.#fsyncSession(id);

    (session as { status: SessionStatus }).status = 'closed';
  }

  // ---- ISessionStore: pushMessage ----

  pushMessage(id: string, msg: Message): void {
    const session = this.#sessions.get(id);
    if (!session) throw new ZaiSessionNotFoundError(id);

    // Atomically increment seqCounter
    const seq = ((session as { seqCounter: number }).seqCounter ?? 0) + 1;
    (session as { seqCounter: number }).seqCounter = seq;

    const messageWithSeq: Message = { ...msg, seq };

    // Append to in-memory messages
    (session as { messages: Message[] }).messages = [...session.messages, messageWithSeq];

    // Enqueue for async write (fire-and-forget)
    this.#enqueueWrite(id, JSON.stringify(messageWithSeq));
  }

  // ---- ISessionStore: queryByProject ----

  queryByProject(projectDir: string): Session[] {
    return [...this.#sessions.values()].filter(s => s.projectDir === projectDir);
  }

  // ---- ISessionStore: persistAll ----

  async persistAll(): Promise<void> {
    const flushPromises: Promise<void>[] = [];
    for (const sessionId of this.#writeQueues.keys()) {
      flushPromises.push(this.#flushSession(sessionId));
    }
    await Promise.all(flushPromises);

    // fsync all open sessions
    const syncPromises: Promise<void>[] = [];
    for (const id of this.#sessions.keys()) {
      syncPromises.push(this.#fsyncSession(id));
    }
    await Promise.all(syncPromises);
  }

  // ---- ISessionStore: recoverFromDisk ----

  async recoverFromDisk(): Promise<Session[]> {
    const recovered: Session[] = [];
    let files: string[];

    try {
      files = await fsp.readdir(this.#sessionsDir);
    } catch {
      return recovered;
    }

    const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));

    for (const file of jsonlFiles) {
      const filePath = path.join(this.#sessionsDir, file);
      const sessionId = path.basename(file, '.jsonl');

      try {
        const session = await this.#loadFromDisk(sessionId, filePath);
        if (session) {
          this.#sessions.set(session.id, session);
          recovered.push(session);
        }
      } catch {
        // Skip files that fail to load entirely
      }
    }

    return recovered;
  }

  // ---- ISessionStore: activeCount ----

  get activeCount(): number {
    let count = 0;
    for (const s of this.#sessions.values()) {
      if (s.status === 'active' || s.status === 'paused') count++;
    }
    return count;
  }

  // ---- Internal: load single JSONL from disk ----

  async #loadFromDisk(sessionId: string, filePath: string): Promise<Session | null> {
    let meta: SessionMeta | null = null;
    const messages: Message[] = [];
    let skippedLines = 0;
    let lineNumber = 0;

    const rl = createInterface({
      input: createReadStream(filePath, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      lineNumber++;
      if (!line.trim()) continue;

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        // Incomplete/corrupted line — skip with warning (AC12)
        skippedLines++;
        continue;
      }

      // First non-empty line: check for __meta header (AC10, AC13)
      if (lineNumber === 1 && parsed.__meta) {
        meta = parsed.__meta as unknown as SessionMeta;
        if (meta.format_version > JSONL_FORMAT_VERSION) {
          // Future version — refuse to read (AC10)
          return null;
        }
        continue;
      }

      // Message line
      if (parsed.id && parsed.role) {
        messages.push(parsed as unknown as Message);
      }
    }

    if (!meta) {
      // No header found — create minimal meta
      meta = {
        format_version: JSONL_FORMAT_VERSION,
        engine_version: this.#engineVersion,
        created_at: new Date().toISOString(),
      };
    }

    const seqCounter = messages.reduce((max, m) => Math.max(max, m.seq ?? 0), 0);

    const session: Session = {
      id: sessionId,
      messages: messages.slice(-100), // AC14: recover last 100 messages
      createdAt: meta.created_at ? new Date(meta.created_at).getTime() : Date.now(),
      config: {} as ZaiConfig,
      status: 'active',
      projectDir: meta.project_dir,
      version: meta.engine_version,
      seqCounter,
      reconnecting: false,
    };

    if (skippedLines > 0) {
      this.emit('store.notification', {
        type: 'session.recovered',
        sessionId,
        recoveredCount: messages.length,
        skippedLines,
      } as StoreNotification);
    }

    return session;
  }

  // ---- Internal: async write queue ----

  #enqueueWrite(sessionId: string, jsonLine: string): void {
    let entry = this.#writeQueues.get(sessionId);
    if (!entry) {
      entry = { lines: [], timer: null };
      this.#writeQueues.set(sessionId, entry);
    }

    entry.lines.push(jsonLine);

    // Queue overflow — drop oldest (AC11)
    if (entry.lines.length > this.#writeQueueMaxSize) {
      const dropped = entry.lines.length - this.#writeQueueMaxSize;
      entry.lines = entry.lines.slice(dropped);
      this.emit('store.notification', {
        type: 'session.persistence.dropped',
        sessionId,
        count: dropped,
      } as StoreNotification);
    }

    // Immediate flush if batch size reached
    if (entry.lines.length >= this.#flushBatchSize) {
      this.#flushSession(sessionId).catch(() => { /* fire-and-forget */ });
      return;
    }

    // Schedule debounced flush
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      this.#flushSession(sessionId).catch(() => { /* fire-and-forget */ });
    }, this.#flushDebounceMs);
  }

  async #flushSession(sessionId: string): Promise<void> {
    const entry = this.#writeQueues.get(sessionId);
    if (!entry || entry.lines.length === 0) return;

    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }

    const linesToWrite = entry.lines.splice(0);

    const filePath = this.#sessionFilePath(sessionId);
    try {
      // Ensure header exists before writing message lines
      await this.#ensureHeader(sessionId, filePath);
      await fsp.appendFile(filePath, linesToWrite.join('\n') + '\n');
    } catch {
      // Re-queue on failure (prepend back)
      entry.lines.unshift(...linesToWrite);
    }
  }

  async #ensureHeader(sessionId: string, filePath: string): Promise<void> {
    if (this.#sessionMetas.has(sessionId)) return;

    try {
      const { size } = await fsp.stat(filePath);
      if (size > 0) {
        this.#sessionMetas.set(sessionId, {} as SessionMeta);
        return;
      }
    } catch {
      // File doesn't exist yet — will create with header
    }

    const session = this.#sessions.get(sessionId);
    const meta: SessionMeta = {
      format_version: JSONL_FORMAT_VERSION,
      engine_version: this.#engineVersion,
      created_at: session ? new Date(session.createdAt).toISOString() : new Date().toISOString(),
      project_dir: session?.projectDir,
    };

    await fsp.appendFile(filePath, JSON.stringify({ __meta: meta }) + '\n');
    this.#sessionMetas.set(sessionId, meta);
  }

  async #fsyncSession(sessionId: string): Promise<void> {
    const filePath = this.#sessionFilePath(sessionId);
    try {
      const fd = await fsp.open(filePath, 'r');
      await fd.sync();
      await fd.close();
    } catch {
      // File may not exist yet — that's OK
    }
  }

  #sessionFilePath(sessionId: string): string {
    return path.join(this.#sessionsDir, `${sessionId}.jsonl`);
  }

  // ---- Cleanup ----

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    for (const entry of this.#writeQueues.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    this.#writeQueues.clear();
    this.removeAllListeners();
  }
}
