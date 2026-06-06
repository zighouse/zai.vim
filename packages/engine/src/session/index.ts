// @zaivim/engine — Session management
// In-memory session store (legacy). Growth phase: SQLite persistence.
// New code should use ISessionStore interface from @zaivim/core.

import type { Session, Message, ZaiConfig } from '@zaivim/core';
import { ZaiError } from '@zaivim/core';
import { randomUUID } from 'node:crypto';

export { JsonlSessionStore } from './jsonl-store.js';
export type { JsonlSessionStoreOptions, StoreNotification } from './jsonl-store.js';
export { SessionLifecycleManager } from './lifecycle-manager.js';
export type { SessionLifecycleManagerOptions, LifecycleNotification } from './lifecycle-manager.js';
export { InMemorySessionStoreFull } from './memory-store.js';

export interface SessionStore {
  create(config: ZaiConfig): Session;
  get(id: string): Session | undefined;
  appendMessage(id: string, msg: Message): void;
  close(id: string): void;
  list(): Session[];
}

export class InMemorySessionStore implements SessionStore {
  #sessions: Map<string, Session> = new Map();

  create(config: ZaiConfig): Session {
    const session: Session = {
      id: randomUUID(),
      messages: [],
      createdAt: Date.now(),
      config,
      status: 'active',
    };
    this.#sessions.set(session.id, session);
    return session;
  }

  get(id: string): Session | undefined {
    return this.#sessions.get(id);
  }

  appendMessage(id: string, msg: Message): void {
    const session = this.#sessions.get(id);
    if (!session) {
      throw new ZaiError(`Session not found: ${id}`, 'ENGINE_SESSION_NOT_FOUND', 404);
    }
    // Mutate session messages — in MVP single-writer context this is safe
    (session as { messages: Message[] }).messages = [...session.messages, msg];
  }

  close(id: string): void {
    const session = this.#sessions.get(id);
    if (session) {
      (session as { status: 'active' | 'paused' | 'closed' }).status = 'closed';
    }
  }

  list(): Session[] {
    return [...this.#sessions.values()];
  }

  get activeCount(): number {
    return [...this.#sessions.values()].filter(s => s.status === 'active').length;
  }
}
