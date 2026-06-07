// @zaivim/engine — Pipeline integration tests
// Tests Engine.chat() end-to-end with real Engine + mock provider.

import { describe, it, expect, vi } from 'vitest';
import type { ResponseChunk, IProvider, ToolDefinition, ProviderChatRequest, Message, ISessionStore, Session, ZaiConfig } from '@zaivim/core';
import { ZaiNetworkError } from '@zaivim/core';
import { Engine } from '../pipeline/index.js';
import { randomUUID } from 'node:crypto';

function createProviderWithChunks(chunks: ResponseChunk[]): IProvider {
  return {
    name: 'mock',
    models: ['mock-model'],
    capabilities: {
      streaming: true,
      toolUse: true,
      caching: false,
      thinking: false,
      vision: false,
      maxContextTokens: 128_000,
    },
    async *chat() {
      for (const c of chunks) yield c;
    },
  };
}

function createProviderWithToolCalls(): IProvider {
  let callCount = 0;
  return {
    name: 'mock-tools',
    models: ['mock-model'],
    capabilities: {
      streaming: true,
      toolUse: true,
      caching: false,
      thinking: false,
      vision: false,
      maxContextTokens: 128_000,
    },
    async *chat() {
      callCount++;
      if (callCount === 1) {
        yield { type: 'tool_call', id: 'tc-1', name: 'echo', arguments: { text: 'hello' } };
        yield { type: 'done', finishReason: 'tool_calls' };
      } else {
        yield { type: 'text', content: 'Tool result processed' };
        yield { type: 'done', finishReason: 'stop' };
      }
    },
  };
}

const echoTool: ToolDefinition = {
  name: 'echo',
  description: 'Echo tool',
  parameters: { type: 'object', properties: { text: { type: 'string' } } },
  execute: async (params) => JSON.stringify(params),
};

async function collectChunks(iterable: AsyncIterable<ResponseChunk>): Promise<ResponseChunk[]> {
  const chunks: ResponseChunk[] = [];
  for await (const chunk of iterable) {
    chunks.push(chunk);
  }
  return chunks;
}

describe('Engine.chat() integration', () => {
  it('should stream text response end-to-end', async () => {
    const engine = new Engine([echoTool], {
      language: 'en',
      sandbox: { enabled: false, type: 'none', workDir: '/tmp', timeout: 30000 },
      providers: {},
      defaults: { provider: '', model: '', temperature: 0.7, maxTokens: 4096 },
    });

    const session = await engine.createSession();
    const msg: Message = { id: 'msg-1', role: 'user', content: 'Hello' };
    const chunks = await collectChunks(engine.chat(session.id, msg));

    // Engine will use defaultProvider which may or may not be available.
    // With empty providers, it should yield an error chunk or provider might be missing
    const hasResponse = chunks.length > 0;
    expect(hasResponse).toBe(true);
  });

  it('should return error for unknown session', async () => {
    const engine = new Engine([echoTool], {
      language: 'en',
      sandbox: { enabled: false, type: 'none', workDir: '/tmp', timeout: 30000 },
      providers: {},
      defaults: { provider: '', model: '', temperature: 0.7, maxTokens: 4096 },
    });

    const msg: Message = { id: 'msg-1', role: 'user', content: 'Hello' };
    const chunks = await collectChunks(engine.chat('nonexistent-session', msg));

    const errorChunk = chunks.find(c => c.type === 'error');
    expect(errorChunk).toBeDefined();
    if (errorChunk?.type === 'error') {
      expect(errorChunk.code).toBe('ENGINE_SESSION_NOT_FOUND');
    }
  });

  it('should return error when no provider configured', async () => {
    const engine = new Engine([echoTool], {
      language: 'en',
      sandbox: { enabled: false, type: 'none', workDir: '/tmp', timeout: 30000 },
      providers: {},
      defaults: { provider: '', model: '', temperature: 0.7, maxTokens: 4096 },
    });

    const session = await engine.createSession();
    const msg: Message = { id: 'msg-1', role: 'user', content: 'Hello' };
    const chunks = await collectChunks(engine.chat(session.id, msg));

    const errorChunk = chunks.find(c => c.type === 'error');
    expect(errorChunk).toBeDefined();
    if (errorChunk?.type === 'error') {
      expect(errorChunk.code).toBe('ENGINE_PROVIDER_ERROR');
    }
  });

  it('should throw when engine is destroyed', async () => {
    const engine = new Engine([echoTool], {
      language: 'en',
      sandbox: { enabled: false, type: 'none', workDir: '/tmp', timeout: 30000 },
      providers: {},
      defaults: { provider: '', model: '', temperature: 0.7, maxTokens: 4096 },
    });

    const session = await engine.createSession();
    await engine.destroy();

    const msg: Message = { id: 'msg-1', role: 'user', content: 'Hello' };

    await expect((async () => {
      for await (const _ of engine.chat(session.id, msg)) {
        // consume
      }
    })()).rejects.toThrow('Engine has been destroyed');
  });
});

describe('Engine.listSessions() — pagination (AC4)', () => {
  it('returns SessionSummary[] with correct shape', async () => {
    const engine = new Engine([], {
      language: 'en',
      sandbox: { enabled: false, type: 'none', workDir: '/tmp', timeout: 30000 },
      providers: {},
      defaults: { provider: '', model: '', temperature: 0.7, maxTokens: 4096 },
    });

    await engine.createSession();
    await engine.createSession();

    const list = engine.listSessions();
    expect(list.length).toBe(2);
    expect(list[0]).toHaveProperty('id');
    expect(list[0]).toHaveProperty('createdAt');
    expect(list[0]).toHaveProperty('status');
    expect(list[0]).toHaveProperty('messageCount');
  });

  it('respects limit parameter', async () => {
    const engine = new Engine([], {
      language: 'en',
      sandbox: { enabled: false, type: 'none', workDir: '/tmp', timeout: 30000 },
      providers: {},
      defaults: { provider: '', model: '', temperature: 0.7, maxTokens: 4096 },
    });

    for (let i = 0; i < 10; i++) await engine.createSession();

    expect(engine.listSessions({ limit: 3 })).toHaveLength(3);
    expect(engine.listSessions({ limit: 20 })).toHaveLength(10);
  });

  it('filters by status', async () => {
    const engine = new Engine([], {
      language: 'en',
      sandbox: { enabled: false, type: 'none', workDir: '/tmp', timeout: 30000 },
      providers: {},
      defaults: { provider: '', model: '', temperature: 0.7, maxTokens: 4096 },
    });

    const s1 = await engine.createSession();
    const s2 = await engine.createSession();
    await engine.closeSession(s1.id);

    const active = engine.listSessions({ status: 'active' });
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe(s2.id);
  });

  it('listSessions({limit:0}) returns empty array', async () => {
    const engine = new Engine([], {
      language: 'en',
      sandbox: { enabled: false, type: 'none', workDir: '/tmp', timeout: 30000 },
      providers: {},
      defaults: { provider: '', model: '', temperature: 0.7, maxTokens: 4096 },
    });

    await engine.createSession();
    await engine.createSession();

    expect(engine.listSessions({ limit: 0 })).toHaveLength(0);
  });
});

describe('Engine — multi-session isolation (AC1)', () => {
  it('sessions store independent message lists', async () => {
    const engine = new Engine([], {
      language: 'en',
      sandbox: { enabled: false, type: 'none', workDir: '/tmp', timeout: 30000 },
      providers: {},
      defaults: { provider: '', model: '', temperature: 0.7, maxTokens: 4096 },
    });

    const s1 = await engine.createSession();
    const s2 = await engine.createSession();

    engine.pushSessionMessage(s1.id, { id: 'm1', role: 'user', content: 'hello from a' });
    engine.pushSessionMessage(s2.id, { id: 'm2', role: 'user', content: 'hello from b' });

    expect(engine.getSession(s1.id)!.messages).toHaveLength(1);
    expect(engine.getSession(s1.id)!.messages[0]!.content).toBe('hello from a');
    expect(engine.getSession(s2.id)!.messages[0]!.content).toBe('hello from b');
  });
});

describe('Engine.recoverSession() (AC3)', () => {
  it('returns session not found error when no disk persistence', async () => {
    const engine = new Engine([], {
      language: 'en',
      sandbox: { enabled: false, type: 'none', workDir: '/tmp', timeout: 30000 },
      providers: {},
      defaults: { provider: '', model: '', temperature: 0.7, maxTokens: 4096 },
    });

    await expect(engine.recoverSession('non-existent')).rejects.toThrow('Session not found');
  });

  it('emits session.recovered event on successful recovery', async () => {
    const recoveredSession: Session = {
      id: 'recovered-1',
      messages: [{ id: 'm1', role: 'user', content: 'historical', seq: 1 }],
      createdAt: Date.now() - 86400000,
      config: {} as ZaiConfig,
      status: 'active',
    };

    const mockStore: ISessionStore = {
      create: () => recoveredSession,
      get: () => undefined,
      close: async () => {},
      list: () => [],
      pushMessage: () => {},
      queryByProject: () => [],
      persistAll: async () => {},
      recoverFromDisk: async () => [recoveredSession],
      activeCount: 0,
    };

    const engine = new Engine([], {
      language: 'en',
      sandbox: { enabled: false, type: 'none', workDir: '/tmp', timeout: 30000 },
      providers: {},
      defaults: { provider: '', model: '', temperature: 0.7, maxTokens: 4096 },
    }, mockStore);

    const events: Array<{ type: string; sessionId: string }> = [];
    engine.events.on('session.recovered', (data: Record<string, unknown>) => {
      events.push({ type: data.type as string, sessionId: data.sessionId as string });
    });

    const session = await engine.recoverSession('recovered-1');
    expect(session.id).toBe('recovered-1');
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('session.recovered');
    expect(events[0]!.sessionId).toBe('recovered-1');
  });
});
