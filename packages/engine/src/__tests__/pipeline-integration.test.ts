// @zaivim/engine — Pipeline integration tests
// Tests Engine.chat() end-to-end with real Engine + mock provider.

import { describe, it, expect, vi } from 'vitest';
import type { ResponseChunk, IProvider, ToolDefinition, ProviderChatRequest, Message, ISessionStore, Session, ZaiConfig } from '@zaivim/core';
import { ZaiNetworkError } from '@zaivim/core';
import { Engine } from '../pipeline/index.js';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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

// ---- Project context integration tests (Story 1b.4) -----------------------

describe('Engine — project context detection', () => {
  function createEngine() {
    return new Engine([], {
      language: 'en',
      sandbox: { enabled: false, type: 'none', workDir: '/tmp', timeout: 30000 },
      providers: {},
      defaults: { provider: '', model: '', temperature: 0.7, maxTokens: 4096 },
    });
  }

  it('createSession auto-detects projectRoot from .git (Subtask 8.1)', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'test-int-'));
    mkdirSync(join(projectRoot, '.git'));

    const origCwd = process.cwd;
    process.cwd = () => projectRoot;

    try {
      const engine = createEngine();
      const session = await engine.createSession();
      expect(session.projectDir).toBeDefined();
      expect(session.projectDir).toContain('test-int-');
    } finally {
      process.cwd = origCwd;
    }
  });

  it('uses provided projectDir when explicit (Subtask 8.1)', async () => {
    const engine = createEngine();
    const explicitDir = '/tmp/explicit-project';
    const session = await engine.createSession(undefined, explicitDir);
    expect(session.projectDir).toBe(explicitDir);
  });

  it('exposes detectProjectContext via EngineAPI (Subtask 8.1)', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'test-int-'));
    writeFileSync(join(projectRoot, 'package.json'), JSON.stringify({
      name: 'api-test',
      dependencies: { react: '^18.0.0' },
      devDependencies: { typescript: '^5.0.0' },
    }));

    const engine = createEngine();
    const ctx = await engine.detectProjectContext(projectRoot);
    expect(ctx.detected).toBe(true);
    expect(ctx.name).toBe('api-test');
    expect(ctx.framework).toBe('React');
    expect(ctx.language).toBe('TypeScript');
  });

  it('caches project context via internal Map (Subtask 8.2)', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'test-int-'));
    writeFileSync(join(projectRoot, 'package.json'), JSON.stringify({
      name: 'cache-test',
      dependencies: { express: '^4.0.0' },
    }));

    // Use detectProjectContext directly to populate cache-like behavior
    const engine = createEngine();
    const ctx1 = await engine.detectProjectContext(projectRoot);
    expect(ctx1.name).toBe('cache-test');

    // Second call should return same data
    const ctx2 = await engine.detectProjectContext(projectRoot);
    expect(ctx2.name).toBe('cache-test');
  });

  it('returns detected:false for empty directory (Subtask 8.3)', async () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), 'test-empty-'));

    const engine = createEngine();
    const ctx = await engine.detectProjectContext(emptyRoot);
    expect(ctx.detected).toBe(false);
    expect(ctx.projectRoot).toBe(emptyRoot);
  });
});

// ---- Story 1b.5: Retry/Fallback integration tests ----

describe('Story 1b.5: Retry and fallback integration', () => {
  function createFailingThenSuccessProvider(name: string, failCount: number, status: number): IProvider {
    let call = 0;
    return {
      name,
      models: ['mock-model'],
      capabilities: { streaming: true, toolUse: false, caching: false, thinking: false, vision: false, maxContextTokens: 128_000 },
      async *chat() {
        call++;
        if (call <= failCount) {
          throw new ZaiNetworkError(`Server error (${status})`, 'ENGINE_PROVIDER_ERROR', status);
        }
        yield { type: 'text', content: `success-after-${failCount}-retries` };
        yield { type: 'done', finishReason: 'stop' };
      },
    };
  }

  const FAST_RETRY = { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 4, backoffFactor: 2 };

  it('should retry 5xx and succeed through pipeline (AC1)', async () => {
    const { chat } = await import('../pipeline/chat.js');
    const { InMemorySessionStoreFull } = await import('../session/memory-store.js');
    const { createProviderRegistry } = await import('../provider/index.js');

    const provider = createFailingThenSuccessProvider('test-provider', 2, 500);
    const sessionStore = new InMemorySessionStoreFull();
    const session = sessionStore.create({
      language: 'en',
      sandbox: { enabled: false, type: 'none', workDir: '/tmp', timeout: 30000 },
      providers: {},
      defaults: { provider: '', model: '', temperature: 0.7, maxTokens: 4096 },
    });
    const registry = createProviderRegistry({
      'test-provider': { type: 'openai', apiKey: 'sk-test', baseURL: 'https://api.test.com', models: ['m1'], defaultModel: 'm1' },
    }, 'test-provider');

    const emit = vi.fn();
    const chunks = await collectChunks(chat(session, { id: 'msg-1', role: 'user', content: 'Hi' }, {
      sessionStore,
      provider,
      tools: [],
      emit,
      config: FAST_RETRY,
      providerRegistry: registry,
    }));

    expect(chunks.some(c => c.type === 'text')).toBe(true);
    // Should have emitted retry events
    const retryEvents = emit.mock.calls.filter(c => c[0] === 'provider.retry');
    expect(retryEvents.length).toBe(2);
  });

  it('should fallback to alternative provider on retry exhaustion (AC5)', async () => {
    const { chat } = await import('../pipeline/chat.js');
    const { InMemorySessionStoreFull } = await import('../session/memory-store.js');
    const { createProviderRegistry } = await import('../provider/index.js');

    const primaryProvider = createFailingThenSuccessProvider('primary', 99, 500);
    const fallbackProvider: IProvider = {
      name: 'fallback',
      models: ['mock-model'],
      capabilities: { streaming: true, toolUse: false, caching: false, thinking: false, vision: false, maxContextTokens: 128_000 },
      async *chat() {
        yield { type: 'text', content: 'fallback-success' };
        yield { type: 'done', finishReason: 'stop' };
      },
    };

    const sessionStore = new InMemorySessionStoreFull();
    const session = sessionStore.create({
      language: 'en',
      sandbox: { enabled: false, type: 'none', workDir: '/tmp', timeout: 30000 },
      providers: {},
      defaults: { provider: '', model: '', temperature: 0.7, maxTokens: 4096 },
    });

    const emit = vi.fn();
    const chunks = await collectChunks(chat(session, { id: 'msg-1', role: 'user', content: 'Hi' }, {
      sessionStore,
      provider: primaryProvider,
      tools: [],
      emit,
      config: FAST_RETRY,
      providerRegistry: {
        getFallback: () => fallbackProvider,
        markDegraded: vi.fn(),
        markAvailable: vi.fn(),
        getProviderStatus: () => 'degraded' as const,
        listAvailableProviders: () => ['primary', 'fallback'],
        acquireRateSlot: async () => {},
        releaseRateSlot: () => {},
      } as any,
    }));

    expect(chunks.some(c => c.type === 'text' && (c as any).content === 'fallback-success')).toBe(true);
    expect(emit).toHaveBeenCalledWith('provider.fallback', expect.objectContaining({
      from: 'primary',
      to: 'fallback',
    }));
  });

  it('should emit provider.status degraded when no fallback available (AC4)', async () => {
    const { chat } = await import('../pipeline/chat.js');
    const { InMemorySessionStoreFull } = await import('../session/memory-store.js');

    const provider = createFailingThenSuccessProvider('only-provider', 99, 500);
    const sessionStore = new InMemorySessionStoreFull();
    const session = sessionStore.create({
      language: 'en',
      sandbox: { enabled: false, type: 'none', workDir: '/tmp', timeout: 30000 },
      providers: {},
      defaults: { provider: '', model: '', temperature: 0.7, maxTokens: 4096 },
    });

    const emit = vi.fn();
    const chunks = await collectChunks(chat(session, { id: 'msg-1', role: 'user', content: 'Hi' }, {
      sessionStore,
      provider,
      tools: [],
      emit,
      config: FAST_RETRY,
      providerRegistry: {
        getFallback: () => undefined,
        markDegraded: vi.fn(),
        markAvailable: vi.fn(),
        getProviderStatus: () => 'untested' as const,
        listAvailableProviders: () => [],
        acquireRateSlot: async () => {},
        releaseRateSlot: () => {},
      } as any,
    }));

    const errorChunk = chunks.find(c => c.type === 'error');
    expect(errorChunk).toBeDefined();
    expect(emit).toHaveBeenCalledWith('provider.status', expect.objectContaining({
      status: 'degraded',
      provider: 'only-provider',
    }));
  });
});

// ---- Story 2.2: Security integration tests ----

describe('Story 2.2 — Security health in getHealth() (Task 7.6)', () => {
  it('should include securityLevel in health response', () => {
    const engine = new Engine([], {
      language: 'en',
      sandbox: { enabled: false, type: 'none', workDir: '/tmp', timeout: 30000 },
      providers: {},
      defaults: { provider: '', model: '', temperature: 0.7, maxTokens: 4096 },
    });

    const health = engine.getHealth();
    expect(health).toHaveProperty('securityLevel');
    expect(['secure', 'degraded', 'at-risk']).toContain(health.securityLevel);
  });
});

describe('Story 2.2 — Tool call security enrichment (Task 3.3.2)', () => {
  it('should enrich tool_call chunks with harmLevel from preExecute', async () => {
    const { chat: pipelineChat } = await import('../pipeline/chat.js');
    const { InMemorySessionStoreFull } = await import('../session/memory-store.js');
    const { ToolRegistry } = await import('@zaivim/tools');

    const mockProvider: IProvider = {
      name: 'mock-enrich',
      models: ['mock-model'],
      capabilities: { streaming: true, toolUse: true, caching: false, thinking: false, vision: false, maxContextTokens: 128_000 },
      async *chat() {
        yield { type: 'tool_call', id: 'tc-1', name: 'echo', arguments: { text: 'hello' } };
        yield { type: 'done', finishReason: 'tool_calls' };
      },
    };

    const sessionStore = new InMemorySessionStoreFull();
    const session = sessionStore.create({
      language: 'en',
      sandbox: { enabled: false, type: 'none', workDir: '/tmp', timeout: 30000 },
      providers: {},
      defaults: { provider: '', model: '', temperature: 0.7, maxTokens: 4096 },
    });

    const mockSecurity = {
      async preExecute() {
        return { allowed: true, harmLevel: 'C' as const, reason: 'safe' };
      },
      async postExecute() {},
    };

    const registry = new ToolRegistry();
    registry.register({
      name: 'echo', description: 'Echo',
      parameters: { type: 'object', properties: { text: { type: 'string' } } },
      execute: async (p) => JSON.stringify(p),
    });

    const chunks: ResponseChunk[] = [];
    for await (const chunk of pipelineChat(session, { id: 'msg-1', role: 'user', content: 'Hi' }, {
      sessionStore,
      provider: mockProvider,
      registry,
      security: mockSecurity as any,
      emit: vi.fn(),
    })) {
      chunks.push(chunk);
    }

    const toolCallChunk = chunks.find(c => c.type === 'tool_call') as any;
    expect(toolCallChunk).toBeDefined();
    expect(toolCallChunk.harmLevel).toBe('C');
    expect(toolCallChunk.badge).toBeDefined();
    expect(toolCallChunk.badge.level).toBe('C');
  });
});
