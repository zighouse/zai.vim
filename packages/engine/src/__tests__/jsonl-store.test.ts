// @zaivim/engine — JsonlSessionStore tests
// Tests JSONL persistence, CRUD, crash recovery, async write queue.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JsonlSessionStore, type StoreNotification } from '../session/jsonl-store.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zai-jsonl-test-'));
}

function makeMessage(role: 'user' | 'assistant' | 'tool' | 'system' = 'user', content = 'hello') {
  return { id: randomUUID(), role, content, createdAt: Date.now() };
}

describe('JsonlSessionStore — CRUD', () => {
  let dir: string;
  let store: JsonlSessionStore;

  beforeEach(() => {
    dir = tempDir();
    store = new JsonlSessionStore({ sessionsDir: dir });
  });

  afterEach(() => {
    store.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('create() returns a session with unique ID and status active', () => {
    const s = store.create();
    expect(s.id).toBeTruthy();
    expect(s.status).toBe('active');
    expect(s.messages).toHaveLength(0);
    expect(s.seqCounter).toBe(0);
  });

  it('create() accepts projectDir', () => {
    const s = store.create(undefined, '/tmp/myproject');
    expect(s.projectDir).toBe('/tmp/myproject');
  });

  it('get() returns created session', () => {
    const s = store.create();
    expect(store.get(s.id)).toBe(s);
  });

  it('get() returns undefined for unknown ID', () => {
    expect(store.get('nonexistent')).toBeUndefined();
  });

  it('list() returns all sessions', () => {
    store.create();
    store.create();
    expect(store.list()).toHaveLength(2);
  });

  it('list() filters by status', async () => {
    const s1 = store.create();
    const s2 = store.create();
    await store.close(s1.id);
    const active = store.list({ status: 'active' });
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(s2.id);
  });

  it('list() filters by projectDir', () => {
    store.create(undefined, '/proj/a');
    store.create(undefined, '/proj/b');
    store.create(undefined, '/proj/a');
    expect(store.list({ projectDir: '/proj/a' })).toHaveLength(2);
  });

  it('close() sets status to closed', async () => {
    const s = store.create();
    await store.close(s.id);
    expect(s.status).toBe('closed');
  });

  it('close() throws for unknown session', async () => {
    await expect(store.close('nonexistent')).rejects.toThrow('Session not found');
  });

  it('activeCount tracks active sessions', async () => {
    expect(store.activeCount).toBe(0);
    store.create();
    expect(store.activeCount).toBe(1);
    const s2 = store.create();
    expect(store.activeCount).toBe(2);
    await store.close(s2.id);
    expect(store.activeCount).toBe(1);
  });

  it('queryByProject returns sessions for a project', () => {
    store.create(undefined, '/proj/a');
    store.create(undefined, '/proj/b');
    store.create(undefined, '/proj/a');
    expect(store.queryByProject('/proj/a')).toHaveLength(2);
    expect(store.queryByProject('/proj/c')).toHaveLength(0);
  });
});

describe('JsonlSessionStore — pushMessage and seq', () => {
  let dir: string;
  let store: JsonlSessionStore;

  beforeEach(() => {
    dir = tempDir();
    store = new JsonlSessionStore({ sessionsDir: dir });
  });

  afterEach(() => {
    store.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('pushMessage() appends message with seq counter', async () => {
    const s = store.create();
    store.pushMessage(s.id, makeMessage());
    store.pushMessage(s.id, makeMessage());
    store.pushMessage(s.id, makeMessage());

    // Flush to ensure write completes
    await store.persistAll();

    expect(s.messages).toHaveLength(3);
    expect(s.messages[0].seq).toBe(1);
    expect(s.messages[1].seq).toBe(2);
    expect(s.messages[2].seq).toBe(3);
    expect(s.seqCounter).toBe(3);
  });

  it('pushMessage() throws for unknown session', () => {
    expect(() => store.pushMessage('nonexistent', makeMessage())).toThrow('Session not found');
  });
});

describe('JsonlSessionStore — JSONL persistence', () => {
  let dir: string;
  let store: JsonlSessionStore;

  beforeEach(() => {
    dir = tempDir();
    store = new JsonlSessionStore({ sessionsDir: dir });
  });

  afterEach(() => {
    store.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes JSONL file with header on first pushMessage', async () => {
    const s = store.create(undefined, '/my/project');
    store.pushMessage(s.id, makeMessage());
    await store.persistAll();

    const filePath = path.join(dir, `${s.id}.jsonl`);
    expect(fs.existsSync(filePath)).toBe(true);

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines.length).toBe(2); // header + 1 message

    const header = JSON.parse(lines[0]);
    expect(header.__meta.format_version).toBe(1);
    expect(header.__meta.project_dir).toBe('/my/project');

    const msg = JSON.parse(lines[1]);
    expect(msg.seq).toBe(1);
    expect(msg.role).toBe('user');
  });

  it('header auto-initialized on first pushMessage (AC13)', async () => {
    const s = store.create();
    store.pushMessage(s.id, makeMessage());
    await store.persistAll();

    const content = fs.readFileSync(path.join(dir, `${s.id}.jsonl`), 'utf-8');
    const firstLine = content.split('\n')[0];
    const header = JSON.parse(firstLine);
    expect(header.__meta).toBeDefined();
    expect(header.__meta.format_version).toBe(1);
    expect(header.__meta.engine_version).toBe('0.1.0');
    expect(header.__meta.created_at).toBeTruthy();
  });

  it('format_version check: refuses future versions (AC10)', async () => {
    const filePath = path.join(dir, 'future-session.jsonl');
    fs.writeFileSync(filePath, '{"__meta":{"format_version":99,"engine_version":"9.0.0","created_at":"2026-01-01T00:00:00Z"}}\n');

    const store2 = new JsonlSessionStore({ sessionsDir: dir });
    const recovered = await store2.recoverFromDisk();
    expect(recovered).toHaveLength(0);
    store2.destroy();
  });

  it('silently ignores unknown fields in JSONL (AC10)', async () => {
    const sessionId = 'test-unknown-fields';
    const filePath = path.join(dir, `${sessionId}.jsonl`);
    fs.writeFileSync(filePath, [
      '{"__meta":{"format_version":1,"engine_version":"0.1.0","created_at":"2026-06-06T00:00:00Z"}}',
      '{"id":"m1","role":"user","content":"hi","seq":1,"future_field":"ignored"}',
    ].join('\n') + '\n');

    const store2 = new JsonlSessionStore({ sessionsDir: dir });
    const recovered = await store2.recoverFromDisk();
    expect(recovered).toHaveLength(1);
    expect(recovered[0].messages[0].content).toBe('hi');
    store2.destroy();
  });
});

describe('JsonlSessionStore — crash recovery (AC12)', () => {
  let dir: string;

  beforeEach(() => {
    dir = tempDir();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('skips incomplete last line on recovery', async () => {
    const sessionId = 'crash-test';
    const filePath = path.join(dir, `${sessionId}.jsonl`);
    // Write header + valid message + incomplete line (simulating SIGKILL)
    const content = [
      '{"__meta":{"format_version":1,"engine_version":"0.1.0","created_at":"2026-06-06T00:00:00Z"}}',
      '{"id":"m1","role":"user","content":"complete message","seq":1}',
      '{"id":"m2","role":"user","content":"incomplete m', // truncated
    ].join('\n') + '\n';
    fs.writeFileSync(filePath, content);

    const store = new JsonlSessionStore({ sessionsDir: dir });
    const notifications: StoreNotification[] = [];
    store.on('store.notification', (n: StoreNotification) => notifications.push(n));

    const recovered = await store.recoverFromDisk();
    expect(recovered).toHaveLength(1);
    expect(recovered[0].messages).toHaveLength(1);
    expect(recovered[0].messages[0].content).toBe('complete message');

    // Should emit notification about skipped lines
    expect(notifications).toHaveLength(1);
    expect(notifications[0].type).toBe('session.recovered');
    expect(notifications[0].skippedLines).toBe(1);

    store.destroy();
  });
});

describe('JsonlSessionStore — recover from disk (AC14)', () => {
  let dir: string;

  beforeEach(() => {
    dir = tempDir();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('recovers active sessions on startup', async () => {
    // Pre-create a JSONL file
    const sessionId = 'recovered-session';
    const filePath = path.join(dir, `${sessionId}.jsonl`);
    const messages = Array.from({ length: 150 }, (_, i) =>
      `{"id":"m${i}","role":"user","content":"msg ${i}","seq":${i + 1}}`
    ).join('\n');
    fs.writeFileSync(filePath, [
      '{"__meta":{"format_version":1,"engine_version":"0.1.0","created_at":"2026-06-06T00:00:00Z"}}',
      messages,
    ].join('\n') + '\n');

    const store = new JsonlSessionStore({ sessionsDir: dir });
    const recovered = await store.recoverFromDisk();

    expect(recovered).toHaveLength(1);
    expect(recovered[0].id).toBe(sessionId);
    // AC14: recover last 100 messages
    expect(recovered[0].messages).toHaveLength(100);
    expect(recovered[0].seqCounter).toBe(150);
    expect(store.activeCount).toBe(1);

    store.destroy();
  });

  it('returns empty when no JSONL files exist', async () => {
    const store = new JsonlSessionStore({ sessionsDir: dir });
    const recovered = await store.recoverFromDisk();
    expect(recovered).toHaveLength(0);
    store.destroy();
  });
});

describe('JsonlSessionStore — write queue overflow (AC11)', () => {
  let dir: string;
  let store: JsonlSessionStore;

  beforeEach(() => {
    dir = tempDir();
    // Small queue to trigger overflow easily
    store = new JsonlSessionStore({ sessionsDir: dir, writeQueueMaxSize: 5, flushBatchSize: 100, flushDebounceMs: 60000 });
  });

  afterEach(() => {
    store.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('emits persistence.dropped when queue overflows', () => {
    const notifications: StoreNotification[] = [];
    store.on('store.notification', (n: StoreNotification) => notifications.push(n));

    const s = store.create();
    // Push more than queue max
    for (let i = 0; i < 10; i++) {
      store.pushMessage(s.id, makeMessage());
    }

    const dropped = notifications.filter(n => n.type === 'session.persistence.dropped');
    expect(dropped.length).toBeGreaterThan(0);
    expect(dropped[0].sessionId).toBe(s.id);
    expect(dropped[0].count).toBeGreaterThan(0);
  });
});
