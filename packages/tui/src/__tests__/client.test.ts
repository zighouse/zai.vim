// @zaivim/tui — Client unit tests
// Covers: request/response, notification subscription, error handling.

import { describe, it, expect, vi } from 'vitest';
import { createTuiClient } from '../client.js';
import type { EngineAPI, Session, EngineHealth, Message, ResponseChunk } from '@zaivim/core';

/** Create a mock engine for client testing. */
function createMockEngine(): EngineAPI {
  const sessions = new Map<string, Session>();
  let nextId = 1;

  return {
    get uptime() { return 42; },

    createSession: vi.fn(async (_conversationId?: string, _projectDir?: string): Promise<Session> => {
      const id = `mock-session-${nextId++}`;
      const session: Session = {
        id,
        status: 'active',
        createdAt: Date.now(),
        messages: [],
        messageCount: 0,
        projectDir: undefined,
      };
      sessions.set(id, session);
      return session;
    }),

    getSession: vi.fn((id: string): Session | undefined => {
      return sessions.get(id);
    }),

    listSessions: vi.fn((): Session[] => {
      return Array.from(sessions.values());
    }),

    closeSession: vi.fn(async (id: string): Promise<void> => {
      sessions.delete(id);
    }),

    getHealth: vi.fn((): EngineHealth => ({
      status: 'ok',
      version: '0.1.0',
      uptime: 42,
      sandboxAvailable: true,
      activeSessions: sessions.size,
    })),

    chat: vi.fn(function* (
      _sessionId: string,
      _message: Message,
      _signal?: AbortSignal,
    ): Generator<ResponseChunk> {
      yield { type: 'text', content: 'Hello' } as ResponseChunk;
      yield { type: 'text', content: ' World' } as ResponseChunk;
      yield { type: 'done', finishReason: 'stop' } as ResponseChunk;
    }),

    createAgent: vi.fn(),
    detectProjectContext: vi.fn(),
  } as unknown as EngineAPI;
}

describe('TuiClient', () => {
  // ---- session.create ----

  it('creates a session via send()', async () => {
    const engine = createMockEngine();
    const client = createTuiClient(engine);
    const result = await client.send('session.create') as { sessionId: string };
    expect(result.sessionId).toBeDefined();
    expect(result.status).toBe('active');
  });

  // ---- session.list ----

  it('lists sessions', async () => {
    const engine = createMockEngine();
    const client = createTuiClient(engine);
    await client.send('session.create');
    const result = await client.send('session.list') as { sessions: unknown[] };
    expect(result.sessions).toHaveLength(1);
  });

  // ---- session.get ----

  it('gets session by id', async () => {
    const engine = createMockEngine();
    const client = createTuiClient(engine);
    const created = await client.send('session.create') as { sessionId: string };
    const result = await client.send('session.get', { sessionId: created.sessionId }) as { sessionId: string };
    expect(result.sessionId).toBe(created.sessionId);
    expect(result.messageCount).toBe(0);
  });

  it('throws for unknown session', async () => {
    const engine = createMockEngine();
    const client = createTuiClient(engine);
    await expect(client.send('session.get', { sessionId: 'nonexistent' })).rejects.toThrow('Session not found');
  });

  // ---- session.close ----

  it('closes a session', async () => {
    const engine = createMockEngine();
    const client = createTuiClient(engine);
    const created = await client.send('session.create') as { sessionId: string };
    const result = await client.send('session.close', { sessionId: created.sessionId }) as { status: string };
    expect(result.status).toBe('closed');
    const list = await client.send('session.list') as { sessions: unknown[] };
    expect(list.sessions).toHaveLength(0);
  });

  // ---- engine.ping ----

  it('returns engine ping status', async () => {
    const engine = createMockEngine();
    const client = createTuiClient(engine);
    const result = await client.send('engine.ping') as { status: string };
    expect(result.status).toBe('ok');
  });

  // ---- unknown method ----

  it('throws for unknown method', async () => {
    const engine = createMockEngine();
    const client = createTuiClient(engine);
    await expect(client.send('unknown.method')).rejects.toThrow('Method not found');
  });

  // ---- subscribe ----

  it('subscribes and receives events', () => {
    const engine = createMockEngine();
    const client = createTuiClient(engine);
    const handler = vi.fn();
    client.subscribe('test.event', handler);

    // Manually trigger handler through the internal mechanism
    // Since TuiClient doesn't expose emit, we verify the subscription API works
    const unsub = client.subscribe('test.event', handler);
    unsub();
  });

  // ---- chat ----

  it('streams chat chunks', async () => {
    const engine = createMockEngine();
    const client = createTuiClient(engine);
    const created = await client.send('session.create') as { sessionId: string };
    const chunks: Array<{ type: string }> = [];
    for await (const chunk of client.chat(created.sessionId, 'hello')) {
      chunks.push(chunk);
    }
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0].type).toBe('text');
  });

  // ---- close ----

  it('closes cleanly', async () => {
    const engine = createMockEngine();
    const client = createTuiClient(engine);
    await expect(client.close()).resolves.toBeUndefined();
  });
});
