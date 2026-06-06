// @zaivim/engine — SessionLifecycleManager tests
// Tests TTL timers, reconnection race protection, message limit detection.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SessionLifecycleManager, type LifecycleNotification } from '../session/lifecycle-manager.js';
import type { ISessionStore, Session, Message } from '@zaivim/core';
import { ZaiSessionNotFoundError } from '@zaivim/core';

function createMockStore(): ISessionStore & { sessions: Map<string, Session> } {
  const sessions = new Map<string, Session>();

  return {
    sessions,
    create: (config?, projectDir?) => {
      const s: Session = {
        id: `session-${sessions.size}`,
        messages: [],
        createdAt: Date.now(),
        config: config ?? ({} as Session['config']),
        status: 'active',
        projectDir,
        seqCounter: 0,
        reconnecting: false,
      };
      sessions.set(s.id, s);
      return s;
    },
    get: (id: string) => sessions.get(id),
    close: async (id: string) => {
      const s = sessions.get(id);
      if (s) (s as { status: 'closed' }).status = 'closed';
    },
    list: () => [...sessions.values()],
    pushMessage: (id: string, msg: Message) => {
      const s = sessions.get(id);
      if (!s) throw new ZaiSessionNotFoundError(id);
      const seq = ((s as { seqCounter: number }).seqCounter ?? 0) + 1;
      (s as { seqCounter: number }).seqCounter = seq;
      (s as { messages: Message[] }).messages = [...s.messages, { ...msg, seq }];
    },
    queryByProject: () => [],
    persistAll: async () => {},
    recoverFromDisk: async () => [],
    get activeCount() { return [...sessions.values()].filter(s => s.status === 'active').length; },
  };
}

describe('SessionLifecycleManager — TTL', () => {
  let store: ReturnType<typeof createMockStore>;
  let mgr: SessionLifecycleManager;

  beforeEach(() => {
    vi.useFakeTimers();
    store = createMockStore();
    mgr = new SessionLifecycleManager(store, { reconnectWindowMs: 30 * 60 * 1000 });
  });

  afterEach(() => {
    mgr.dispose();
    vi.useRealTimers();
  });

  it('closes session after TTL expires (AC4)', async () => {
    const s = store.create();
    mgr.markDisconnected(s.id);

    expect(s.status).toBe('active');

    // Advance past TTL
    vi.advanceTimersByTime(30 * 60 * 1000 + 1);

    // Allow async close to complete
    await vi.advanceTimersByTimeAsync(0);

    expect(s.status).toBe('closed');
  });

  it('session remains active before TTL expires', () => {
    const s = store.create();
    mgr.markDisconnected(s.id);

    vi.advanceTimersByTime(29 * 60 * 1000);

    expect(s.status).toBe('active');
  });
});

describe('SessionLifecycleManager — reconnection race protection (AC5)', () => {
  let store: ReturnType<typeof createMockStore>;
  let mgr: SessionLifecycleManager;

  beforeEach(() => {
    vi.useFakeTimers();
    store = createMockStore();
    mgr = new SessionLifecycleManager(store, {
      reconnectWindowMs: 30 * 60 * 1000,
      reconnectExtensionMs: 10 * 60 * 1000,
    });
  });

  afterEach(() => {
    mgr.dispose();
    vi.useRealTimers();
  });

  it('extends TTL when reconnecting at expiry time (AC5)', async () => {
    const s = store.create();
    mgr.markDisconnected(s.id);

    // At 29min50s — begin reconnection
    vi.advanceTimersByTime(29 * 60 * 1000 + 50 * 1000);
    mgr.beginReconnect(s.id);

    // Advance past original TTL (30min total)
    vi.advanceTimersByTime(10 * 1000);
    expect(s.status).toBe('active'); // Not closed — extended!

    // Complete reconnection — cancels TTL
    mgr.completeReconnect(s.id);
    vi.advanceTimersByTime(10 * 60 * 1000 + 1);
    await vi.advanceTimersByTimeAsync(0);

    expect(s.status).toBe('active'); // Still active — timer was cancelled
  });

  it('closes session if no reconnection and TTL expired', async () => {
    const s = store.create();
    mgr.markDisconnected(s.id);

    vi.advanceTimersByTime(30 * 60 * 1000 + 1);
    await vi.advanceTimersByTimeAsync(0);

    expect(s.status).toBe('closed');
  });

  it('completeReconnect cancels TTL timer', async () => {
    const s = store.create();
    mgr.markDisconnected(s.id);

    mgr.completeReconnect(s.id);

    // Even after a long time, session stays active
    vi.advanceTimersByTime(60 * 60 * 1000);
    await vi.advanceTimersByTimeAsync(0);

    expect(s.status).toBe('active');
  });
});

describe('SessionLifecycleManager — message limit (AC6)', () => {
  let store: ReturnType<typeof createMockStore>;
  let mgr: SessionLifecycleManager;
  let notifications: LifecycleNotification[];

  beforeEach(() => {
    store = createMockStore();
    notifications = [];
    mgr = new SessionLifecycleManager(store, {
      maxSessionMessages: 100,
      trimKeepCount: 50,
      approachingThreshold: 0.9,
    });
    mgr.on('lifecycle.notification', (n: LifecycleNotification) => notifications.push(n));
  });

  afterEach(() => {
    mgr.dispose();
  });

  it('emits approaching_limit warning at 90% (AC6)', () => {
    const s = store.create();
    // Push 90 messages
    for (let i = 0; i < 90; i++) {
      store.pushMessage(s.id, { id: `m${i}`, role: 'user', content: `msg ${i}` });
      mgr.checkMessageLimit(s.id);
    }

    const warnings = notifications.filter(n => n.type === 'session.approaching_limit');
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0].current).toBeGreaterThanOrEqual(90);
    expect(warnings[0].max).toBe(100);
  });

  it('auto-trims at max and emits auto_trimmed (AC6)', () => {
    const s = store.create();
    // Push 100 messages to trigger auto-trim
    for (let i = 0; i < 100; i++) {
      store.pushMessage(s.id, { id: `m${i}`, role: 'user', content: `msg ${i}` });
      mgr.checkMessageLimit(s.id);
    }

    const trimmed = notifications.filter(n => n.type === 'session.auto_trimmed');
    expect(trimmed.length).toBeGreaterThan(0);
    expect(trimmed[0].removed).toBe(50); // 100 - 50 keep
    expect(s.messages.length).toBe(50); // trimmed to keep count
  });

  it('trimMessages keeps recent N messages', () => {
    const s = store.create();
    for (let i = 0; i < 100; i++) {
      store.pushMessage(s.id, { id: `m${i}`, role: 'user', content: `msg ${i}` });
    }
    mgr.trimMessages(s.id);

    expect(s.messages.length).toBe(50);
    // Most recent message should be last
    expect(s.messages[49].content).toBe('msg 99');
  });

  it('throws for unknown session in trimMessages', () => {
    expect(() => mgr.trimMessages('nonexistent')).toThrow('Session not found');
  });
});
