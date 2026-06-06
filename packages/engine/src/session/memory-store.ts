// @zaivim/engine — InMemorySessionStore with full ISessionStore interface
// No persistence — used for testing and embedded mode.
// Implements ISessionStore from @zaivim/core (ADR-6).

import type { Session, Message, SessionStatus, ISessionStore, ZaiConfig } from '@zaivim/core';
import { ZaiSessionNotFoundError } from '@zaivim/core';
import { randomUUID } from 'node:crypto';

export class InMemorySessionStoreFull implements ISessionStore {
  #sessions: Map<string, Session> = new Map();

  create(config?: Partial<ZaiConfig>, projectDir?: string): Session {
    const session: Session = {
      id: randomUUID(),
      messages: [],
      createdAt: Date.now(),
      config: (config ?? {}) as ZaiConfig,
      status: 'active',
      projectDir,
      seqCounter: 0,
      reconnecting: false,
    };
    this.#sessions.set(session.id, session);
    return session;
  }

  get(id: string): Session | undefined {
    return this.#sessions.get(id);
  }

  async close(id: string): Promise<void> {
    const session = this.#sessions.get(id);
    if (!session) throw new ZaiSessionNotFoundError(id);
    (session as { status: SessionStatus }).status = 'closed';
  }

  list(filter?: { status?: SessionStatus; projectDir?: string }): Session[] {
    const sessions = [...this.#sessions.values()];
    if (!filter) return sessions;
    return sessions.filter(s => {
      if (filter.status && s.status !== filter.status) return false;
      if (filter.projectDir && s.projectDir !== filter.projectDir) return false;
      return true;
    });
  }

  pushMessage(id: string, msg: Message): void {
    const session = this.#sessions.get(id);
    if (!session) throw new ZaiSessionNotFoundError(id);

    const seq = ((session as { seqCounter: number }).seqCounter ?? 0) + 1;
    (session as { seqCounter: number }).seqCounter = seq;

    const messageWithSeq: Message = { ...msg, seq };
    (session as { messages: Message[] }).messages = [...session.messages, messageWithSeq];
  }

  queryByProject(projectDir: string): Session[] {
    return [...this.#sessions.values()].filter(s => s.projectDir === projectDir);
  }

  async persistAll(): Promise<void> {
    // No-op for in-memory store
  }

  async recoverFromDisk(): Promise<Session[]> {
    return [];
  }

  get activeCount(): number {
    let count = 0;
    for (const s of this.#sessions.values()) {
      if (s.status === 'active' || s.status === 'paused') count++;
    }
    return count;
  }
}
