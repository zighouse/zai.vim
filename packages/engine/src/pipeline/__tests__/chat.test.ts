import { describe, it, expect, vi } from 'vitest';
import type { Session, Message, ResponseChunk, IProvider, ToolDefinition, ZaiConfig } from '@zaivim/core';
import { ZaiNetworkError } from '@zaivim/core';
import { chat } from '../chat.js';
import type { ChatDeps } from '../chat.js';
import { NullSecurityProvider } from '../null-security.js';
import { InMemorySessionStoreFull } from '../../session/memory-store.js';

const TEST_CONFIG: Partial<ZaiConfig> = {
  language: 'en',
  sandbox: { enabled: false, type: 'none', workDir: '/tmp', timeout: 30000 },
  providers: {},
  defaults: { provider: 'mock', model: 'mock-model', temperature: 0.7, maxTokens: 4096 },
};

function makeUserMessage(content: string): Message {
  return { id: `user-${Date.now()}`, role: 'user', content };
}

function createMockProviderWithChunks(chunks: ResponseChunk[]): IProvider {
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

function createNonStreamingProvider(): IProvider {
  return {
    name: 'non-streaming',
    models: ['model-1'],
    capabilities: {
      streaming: false,
      toolUse: false,
      caching: false,
      thinking: false,
      vision: false,
      maxContextTokens: 4096,
    },
    async *chat() {
      yield { type: 'text', content: 'should not reach' };
    },
  };
}

const echoTool: ToolDefinition = {
  name: 'echo',
  description: 'Echo back arguments',
  parameters: { type: 'object', properties: { text: { type: 'string' } } },
  execute: async (params) => JSON.stringify(params),
};

function setup(overrides?: Partial<ChatDeps>): { deps: ChatDeps; sessionStore: InMemorySessionStoreFull; createSession: () => Session } {
  const sessionStore = new InMemorySessionStoreFull();
  return {
    sessionStore,
    createSession: () => sessionStore.create(TEST_CONFIG),
    deps: {
      sessionStore,
      provider: createMockProviderWithChunks([
        { type: 'text', content: 'Hello' },
        { type: 'done', finishReason: 'stop' },
      ]),
      tools: [echoTool],
      security: new NullSecurityProvider(),
      ...overrides,
    },
  };
}

async function collectChunks(iterable: AsyncIterable<ResponseChunk>): Promise<ResponseChunk[]> {
  const chunks: ResponseChunk[] = [];
  for await (const chunk of iterable) {
    chunks.push(chunk);
  }
  return chunks;
}

describe('chat() pipeline', () => {
  it('should yield text and done chunks for simple response', async () => {
    const { deps, createSession } = setup();
    const session = createSession();
    const chunks = await collectChunks(chat(session, makeUserMessage('Hi'), deps));

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.find(c => c.type === 'text')).toBeDefined();
    expect(chunks.find(c => c.type === 'done')).toBeDefined();
  });

  it('should emit perf.first_token event', async () => {
    const emit = vi.fn();
    const { deps, createSession } = setup({ emit });
    const session = createSession();
    await collectChunks(chat(session, makeUserMessage('Hi'), deps));

    expect(emit).toHaveBeenCalledWith(
      'perf.first_token',
      expect.objectContaining({ sessionId: session.id }),
    );
  });

  it('should return error chunk for non-streaming provider', async () => {
    const { deps, createSession } = setup({ provider: createNonStreamingProvider() });
    const session = createSession();
    const chunks = await collectChunks(chat(session, makeUserMessage('Hi'), deps));

    const errorChunk = chunks.find(c => c.type === 'error');
    expect(errorChunk).toBeDefined();
    if (errorChunk?.type === 'error') {
      expect(errorChunk.code).toBe('PIPELINE_PROVIDER_NOT_STREAMING');
    }
  });

  it('should handle tool call loop', async () => {
    let callCount = 0;
    const provider: IProvider = {
      name: 'mock-tool',
      models: ['model-1'],
      capabilities: {
        streaming: true, toolUse: true, caching: false, thinking: false, vision: false, maxContextTokens: 128_000,
      },
      async *chat() {
        callCount++;
        if (callCount === 1) {
          yield { type: 'tool_call', id: 'tc-1', name: 'echo', arguments: { text: 'hello' } };
          yield { type: 'done', finishReason: 'tool_calls' };
        } else {
          yield { type: 'text', content: 'Tool was executed' };
          yield { type: 'done', finishReason: 'stop' };
        }
      },
    };

    const { deps, createSession } = setup({ provider });
    const session = createSession();
    const chunks = await collectChunks(chat(session, makeUserMessage('Use tool'), deps));

    expect(chunks.some(c => c.type === 'tool_call')).toBe(true);
    expect(chunks.some(c => c.type === 'tool_result')).toBe(true);
    expect(chunks.some(c => c.type === 'text' && c.content === 'Tool was executed')).toBe(true);
    expect(callCount).toBe(2);
  });

  it('should handle max tool rounds exceeded', async () => {
    let callCount = 0;
    const provider: IProvider = {
      name: 'mock-loop',
      models: ['model-1'],
      capabilities: {
        streaming: true, toolUse: true, caching: false, thinking: false, vision: false, maxContextTokens: 128_000,
      },
      async *chat() {
        callCount++;
        yield { type: 'tool_call', id: `tc-${callCount}`, name: 'echo', arguments: { text: 'loop' } };
        yield { type: 'done', finishReason: 'tool_calls' };
      },
    };

    const { deps, createSession } = setup({ provider, config: { maxToolCallRounds: 3 } });
    const session = createSession();
    const chunks = await collectChunks(chat(session, makeUserMessage('Loop'), deps));

    const errorChunk = chunks.find(c => c.type === 'error' && c.code === 'PIPELINE_MAX_TOOL_ROUNDS_EXCEEDED');
    expect(errorChunk).toBeDefined();
  });

  it('should handle AbortSignal', async () => {
    const ac = new AbortController();
    const provider: IProvider = {
      name: 'mock-slow',
      models: ['model-1'],
      capabilities: {
        streaming: true, toolUse: true, caching: false, thinking: false, vision: false, maxContextTokens: 128_000,
      },
      async *chat(_req, signal) {
        yield { type: 'text', content: 'first' };
        await new Promise(resolve => setTimeout(resolve, 50));
        if (signal?.aborted) return;
        yield { type: 'text', content: 'second' };
        yield { type: 'done', finishReason: 'stop' };
      },
    };

    const { deps, createSession } = setup({ provider });
    const session = createSession();

    const chunks: ResponseChunk[] = [];
    setTimeout(() => ac.abort(), 30);

    for await (const chunk of chat(session, makeUserMessage('Hi'), deps, ac.signal)) {
      chunks.push(chunk);
    }

    expect(chunks.some(c => c.type === 'text')).toBe(true);
  });

  it('should handle provider error with error chunk', async () => {
    const provider: IProvider = {
      name: 'mock-error',
      models: ['model-1'],
      capabilities: {
        streaming: true, toolUse: true, caching: false, thinking: false, vision: false, maxContextTokens: 128_000,
      },
      async *chat() {
        throw new ZaiNetworkError('Connection reset', 'ENGINE_PROVIDER_ERROR', 502);
      },
    };

    const emit = vi.fn();
    const { deps, createSession } = setup({ provider, emit, config: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1, backoffFactor: 1 } });
    const session = createSession();
    const chunks = await collectChunks(chat(session, makeUserMessage('Hi'), deps));

    const errorChunk = chunks.find(c => c.type === 'error');
    expect(errorChunk).toBeDefined();
    expect(emit).toHaveBeenCalledWith('provider.status', expect.objectContaining({ status: 'degraded' }));
  });

  it('should handle stream interruption with notification', async () => {
    const provider: IProvider = {
      name: 'mock-interrupt',
      models: ['model-1'],
      capabilities: {
        streaming: true, toolUse: true, caching: false, thinking: false, vision: false, maxContextTokens: 128_000,
      },
      async *chat() {
        yield { type: 'text', content: 'partial' };
        throw new ZaiNetworkError('ECONNRESET', 'ENGINE_PROVIDER_ERROR', 502);
      },
    };

    const emit = vi.fn();
    const { deps, createSession } = setup({ provider, emit });
    const session = createSession();
    const chunks = await collectChunks(chat(session, makeUserMessage('Hi'), deps));

    expect(chunks.some(c => c.type === 'text')).toBe(true);
    expect(emit).toHaveBeenCalledWith(
      'chat.interrupted',
      expect.objectContaining({ sessionId: session.id, chunksDelivered: expect.any(Number) }),
    );
  });

  it('should reject unknown tool calls (AC13 SSE injection)', async () => {
    const provider: IProvider = {
      name: 'mock-inject',
      models: ['model-1'],
      capabilities: {
        streaming: true, toolUse: true, caching: false, thinking: false, vision: false, maxContextTokens: 128_000,
      },
      async *chat() {
        yield { type: 'tool_call', id: 'tc-1', name: 'malicious_tool', arguments: {} };
        yield { type: 'done', finishReason: 'stop' };
      },
    };

    const { deps, createSession } = setup({ provider, tools: [echoTool] });
    const session = createSession();
    const chunks = await collectChunks(chat(session, makeUserMessage('Inject'), deps));

    const errorChunk = chunks.find(c => c.type === 'error' && c.code === 'PIPELINE_TOOL_NOT_FOUND');
    expect(errorChunk).toBeDefined();
  });

  it('should persist user message and AI response', async () => {
    const { deps, sessionStore, createSession } = setup();
    const session = createSession();
    await collectChunks(chat(session, makeUserMessage('Hello'), deps));

    const updated = sessionStore.get(session.id);
    expect(updated).toBeDefined();
    expect(updated!.messages.length).toBeGreaterThanOrEqual(1);
  });

  // ---- Story 1b.5: Provider retry, fallback, and status management ----

  describe('provider retry events (AC1)', () => {
    it('should emit provider.retry events on 5xx errors', async () => {
      let call = 0;
      const provider: IProvider = {
        name: 'retry-test',
        models: ['model-1'],
        capabilities: { streaming: true, toolUse: false, caching: false, thinking: false, vision: false, maxContextTokens: 128_000 },
        async *chat() {
          call++;
          if (call <= 2) throw new ZaiNetworkError('Server error', 'ENGINE_PROVIDER_ERROR', 500);
          yield { type: 'text', content: 'recovered' };
          yield { type: 'done', finishReason: 'stop' };
        },
      };

      const emit = vi.fn();
      const { deps, createSession } = setup({
        provider,
        emit,
        config: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 1, backoffFactor: 1 },
      });
      const session = createSession();
      const chunks = await collectChunks(chat(session, makeUserMessage('Hi'), deps));

      expect(chunks.some(c => c.type === 'text' && c.content === 'recovered')).toBe(true);
      expect(emit).toHaveBeenCalledWith('provider.retry', expect.objectContaining({
        provider: 'retry-test',
        attempt: 1,
        maxAttempts: 3,
      }));
      expect(emit).toHaveBeenCalledWith('provider.retry', expect.objectContaining({
        provider: 'retry-test',
        attempt: 2,
        maxAttempts: 3,
      }));
    });
  });

  describe('auth failed notification (AC2)', () => {
    it('should emit provider.auth_failed on 401 error', async () => {
      const provider: IProvider = {
        name: 'auth-test',
        models: ['model-1'],
        capabilities: { streaming: true, toolUse: false, caching: false, thinking: false, vision: false, maxContextTokens: 128_000 },
        async *chat() {
          throw new ZaiNetworkError('Invalid API key', 'ENGINE_PROVIDER_ERROR', 401);
        },
      };

      const emit = vi.fn();
      const { deps, createSession } = setup({ provider, emit, config: { maxRetries: 0 } });
      const session = createSession();
      const chunks = await collectChunks(chat(session, makeUserMessage('Hi'), deps));

      const errorChunk = chunks.find(c => c.type === 'error');
      expect(errorChunk).toBeDefined();
      expect(emit).toHaveBeenCalledWith('provider.auth_failed', expect.objectContaining({
        provider: 'auth-test',
        hint: expect.stringContaining('apiKey'),
      }));
    });

    it('should emit provider.model_not_found on 404 error', async () => {
      const provider: IProvider = {
        name: 'model-test',
        models: ['model-1'],
        capabilities: { streaming: true, toolUse: false, caching: false, thinking: false, vision: false, maxContextTokens: 128_000 },
        async *chat() {
          throw new ZaiNetworkError('Model not found', 'ENGINE_PROVIDER_ERROR', 404);
        },
      };

      const emit = vi.fn();
      const { deps, createSession } = setup({ provider, emit, config: { maxRetries: 0 } });
      const session = createSession();
      const chunks = await collectChunks(chat(session, makeUserMessage('Hi'), deps));

      const errorChunk = chunks.find(c => c.type === 'error');
      expect(errorChunk).toBeDefined();
      expect(emit).toHaveBeenCalledWith('provider.model_not_found', expect.objectContaining({
        provider: 'model-test',
      }));
    });
  });

  describe('stream interrupted — no retry (AC9)', () => {
    it('should not retry when chunks already delivered', async () => {
      let callCount = 0;
      const provider: IProvider = {
        name: 'interrupt-test',
        models: ['model-1'],
        capabilities: { streaming: true, toolUse: false, caching: false, thinking: false, vision: false, maxContextTokens: 128_000 },
        async *chat() {
          callCount++;
          yield { type: 'text', content: 'partial' };
          throw new ZaiNetworkError('ECONNRESET', 'ENGINE_PROVIDER_ERROR', 502);
        },
      };

      const emit = vi.fn();
      const { deps, createSession } = setup({
        provider,
        emit,
        config: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 1, backoffFactor: 1 },
      });
      const session = createSession();
      const chunks = await collectChunks(chat(session, makeUserMessage('Hi'), deps));

      expect(chunks.some(c => c.type === 'text' && c.content === 'partial')).toBe(true);
      expect(callCount).toBe(1); // No retry
      expect(emit).toHaveBeenCalledWith('chat.interrupted', expect.objectContaining({
        sessionId: session.id,
      }));
    });
  });

  describe('context_length_exceeded auto-trim retry (AC10)', () => {
    it('should auto-trim on context_length_exceeded and retry successfully', async () => {
      let callCount = 0;
      const provider: IProvider = {
        name: 'ctx-trim-test',
        models: ['model-1'],
        capabilities: { streaming: true, toolUse: false, caching: false, thinking: false, vision: false, maxContextTokens: 128_000 },
        async *chat() {
          callCount++;
          if (callCount <= 1) {
            throw new ZaiNetworkError(
              'context_length_exceeded: maximum context length exceeded',
              'ENGINE_PROVIDER_ERROR',
              400,
            );
          }
          yield { type: 'text', content: 'after-trim' };
          yield { type: 'done', finishReason: 'stop' };
        },
      };

      const emit = vi.fn();
      const { deps, sessionStore, createSession } = setup({ provider, emit, config: { maxRetries: 0 } });
      const session = createSession();

      // Seed with enough messages so trim has something to remove
      for (let i = 0; i < 20; i++) {
        sessionStore.pushMessage(session.id, {
          id: `seed-${i}`,
          role: 'user',
          content: 'A'.repeat(50),
        });
      }

      const chunks = await collectChunks(chat(session, makeUserMessage('Hi'), deps));

      expect(chunks.some(c => c.type === 'text' && c.content === 'after-trim')).toBe(true);
      expect(emit).toHaveBeenCalledWith('context.auto_trimmed', expect.objectContaining({
        sessionId: session.id,
        removedCount: expect.any(Number),
      }));
    });

    it('should yield error when trim retry also fails', async () => {
      const provider: IProvider = {
        name: 'ctx-fail-test',
        models: ['model-1'],
        capabilities: { streaming: true, toolUse: false, caching: false, thinking: false, vision: false, maxContextTokens: 128_000 },
        async *chat() {
          throw new ZaiNetworkError(
            'context_length_exceeded: maximum context length exceeded',
            'ENGINE_PROVIDER_ERROR',
            400,
          );
        },
      };

      const emit = vi.fn();
      const { deps, sessionStore, createSession } = setup({ provider, emit, config: { maxRetries: 0 } });
      const session = createSession();

      for (let i = 0; i < 20; i++) {
        sessionStore.pushMessage(session.id, {
          id: `seed-${i}`,
          role: 'user',
          content: 'A'.repeat(50),
        });
      }

      const chunks = await collectChunks(chat(session, makeUserMessage('Hi'), deps));

      const errorChunk = chunks.find(c => c.type === 'error' && c.code === 'PIPELINE_CONTEXT_LENGTH_EXCEEDED');
      expect(errorChunk).toBeDefined();
    });
  });
});
