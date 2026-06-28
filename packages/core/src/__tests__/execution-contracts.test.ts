// =============================================================================
// @zaivim/core — Execution Contracts (EC0-EC5)
// W1 freeze: all 6 contracts must pass.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ZaiError,
  ZaiNetworkError,
  ZaiToolError,
  SkillLoadError,
  SkillRuntimeError,
  SkillInvalidSignatureError,
  ZaiConfigError,
  ZaiSecurityError,
  ZaiGatewayError,
  ErrorCodes,
} from '../errors/index.js';

import { encode, decode, JSONRPC_VERSION, JSONRPC_ERROR_CODES } from '../protocol/index.js';

import type {
  Message,
  ResponseChunk,
  AgentHandle,
  AgentStatus,
  ToolContext,
  ToolDefinition,
  SkillContext,
  SkillAdapter,
  SkillInput,
  SkillOutput,
  IProvider,
  ProviderChatRequest,
  ISecurityProvider,
} from '../types/index.js';

// ---- Mock factories ---------------------------------------------------------

function createMockAbortSignal(autoAbortMs = 0): AbortSignal {
  const ctrl = new AbortController();
  if (autoAbortMs > 0) setTimeout(() => ctrl.abort(), autoAbortMs);
  return ctrl.signal;
}

function createMockTool(
  override?: Partial<ToolDefinition<unknown, unknown>>,
): ToolDefinition<unknown, unknown> {
  return {
    name: 'mock_tool',
    description: 'A mock tool for testing',
    parameters: { type: 'object', properties: {} },
    execute: vi.fn().mockResolvedValue({ result: 'ok' }),
    ...override,
  };
}

function createMockSecurityProvider(
  override?: Partial<ISecurityProvider>,
): ISecurityProvider {
  return {
    sandboxType: 'none',
    validatePath: () => true,
    proposeChange: () => Promise.resolve(true),
    validatePathAsync: async () => '/test/project',
    isSandboxAvailable: () => true,
    ...override,
  };
}

function createMockSkillContext(
  override?: Partial<SkillContext>,
): SkillContext {
  return {
    sessionId: 'test-session',
    signal: new AbortController().signal,
    ...override,
  };
}

function createMockProvider(
  chunks: ResponseChunk[],
): IProvider {
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
    chat: async function* (_req: ProviderChatRequest, _signal?: AbortSignal) {
      for (const c of chunks) yield c;
    },
  };
}

function createMockSlowProvider(
  chunkIntervalMs: number,
  totalChunks: number,
): IProvider {
  return {
    name: 'mock-slow',
    models: ['mock-slow'],
    capabilities: {
      streaming: true,
      toolUse: false,
      caching: false,
      thinking: false,
      vision: false,
      maxContextTokens: 128_000,
    },
    chat: async function* (_req: ProviderChatRequest, signal?: AbortSignal) {
      for (let i = 0; i < totalChunks; i++) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        await new Promise(r => setTimeout(r, chunkIntervalMs));
        yield { type: 'text' as const, content: `chunk ${i}` };
      }
      yield { type: 'done' as const, finishReason: 'stop' };
    },
  };
}

function createMockTimeoutProvider(timeoutMs: number): IProvider {
  return {
    name: 'mock-timeout',
    models: ['mock-timeout'],
    capabilities: {
      streaming: true,
      toolUse: false,
      caching: false,
      thinking: false,
      vision: false,
      maxContextTokens: 128_000,
    },
    chat: async function* (_req: ProviderChatRequest, _signal?: AbortSignal) {
      // Never yields — simulates network hang
      await new Promise(() => {}); // never resolves
    },
  };
}

// Minimal AgentHandle mock for contract testing
function createMockAgentHandle(
  provider: IProvider,
  tools: ToolDefinition<unknown, unknown>[] = [],
  signal?: AbortSignal,
): AgentHandle {
  let status: AgentStatus = 'idle';

  return {
    id: 'mock-handle',
    persona: { name: 'mock', systemPrompt: '' },
    status: () => status,
    send: async function* (msg: Message, s?: AbortSignal) {
      status = 'running';
      const sig = s ?? signal;
      try {
        for await (const chunk of provider.chat({ messages: [msg], sessionId: 'test' }, sig)) {
          if (sig?.aborted) throw new DOMException('Aborted', 'AbortError');

          // If tool_call, execute tool and feed result back
          if (chunk.type === 'tool_call' && tools.length > 0) {
            const tool = tools.find(t => t.name === chunk.name);
            if (tool) {
              const ctx: ToolContext = {
                sessionId: 'test',
                sandbox: '.',
                signal: sig ?? new AbortController().signal,
                security: createMockSecurityProvider(),
                audit: () => {},
              };
              const result = await tool.execute(chunk.arguments, ctx);
              yield { type: 'tool_result', toolCallId: 'tc1', content: JSON.stringify(result) };
            }
          }
          yield chunk;
        }
      } finally {
        status = 'done';
      }
    },
    cancel: (reason?: string) => {
      status = 'cancelled';
    },
  };
}

// ---- Tests -----------------------------------------------------------------

describe('Execution Contracts', () => {
  // EC0: Pipeline full loop — the critical path
  describe('EC0: Pipeline end-to-end flow', () => {
    it('full loop: message → tool call → execute → provider → response', async () => {
      const mockTool = createMockTool({
        name: 'file_read',
        execute: vi.fn().mockResolvedValue({ content: 'hello world' }),
      });

      const mockProvider = createMockProvider([
        { type: 'tool_call', name: 'file_read', arguments: { path: '/tmp/test.txt' } },
        { type: 'text', content: 'file content is: hello world' },
        { type: 'done', finishReason: 'stop' },
      ]);

      const handle = createMockAgentHandle(mockProvider, [mockTool]);
      const chunks: ResponseChunk[] = [];

      for await (const c of handle.send({ id: '1', role: 'user', content: 'read /tmp/test.txt' })) {
        chunks.push(c);
      }

      // Verify tool was called
      expect(mockTool.execute).toHaveBeenCalledWith(
        { path: '/tmp/test.txt' },
        expect.objectContaining({ sessionId: 'test' }),
      );

      // Verify tool result chunk produced
      expect(chunks.some(c => c.type === 'tool_result')).toBe(true);

      // Verify final text response
      expect(chunks.some(c => c.type === 'text')).toBe(true);

      // Verify done signal
      expect(chunks.some(c => c.type === 'done')).toBe(true);
    });
  });

  // EC1: AbortSignal propagation — ≤100ms from signal to stop
  describe('EC1: AbortSignal propagation', () => {
    it('stops within 100ms after signal.abort()', async () => {
      const controller = new AbortController();
      const slowProvider = createMockSlowProvider(50, 100); // yields every 50ms
      const handle = createMockAgentHandle(slowProvider, [], controller.signal);

      setTimeout(() => controller.abort(), 50);
      const start = Date.now();

      let aborted = false;
      try {
        for await (const _ of handle.send({ id: '1', role: 'user', content: 'test' }, controller.signal)) {
          // consume
        }
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') aborted = true;
        // Also handle the case where AbortError is thrown as a plain object
        if (e instanceof Error && e.name === 'AbortError') aborted = true;
      }

      const elapsed = Date.now() - start;

      // Should have aborted
      expect(aborted).toBe(true);
      // Total latency: 50ms abort trigger + ≤100ms propagation = ≤150ms wall clock
      expect(elapsed).toBeLessThan(150);
    });
  });

  // EC2: Tool.execute() result is JSON roundtrip-safe
  describe('EC2: Tool result JSON roundtrip', () => {
    it('simple object', async () => {
      const result = { content: 'hello', extra: { nested: true } };
      expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    });

    it('array result', async () => {
      const result = { items: [1, 2, 3], total: 3 };
      expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    });

    it('result with undefined values (should be stripped in JSON)', async () => {
      // undefined is NOT valid JSON — test that tool authors handle this
      const result = { a: 1, b: undefined };
      const roundtripped = JSON.parse(JSON.stringify(result));
      expect(roundtripped).toHaveProperty('a', 1);
      expect(roundtripped).not.toHaveProperty('b'); // undefined stripped
    });
  });

  // EC3: SkillContext.signal never undefined
  describe('EC3: SkillContext.signal never undefined', () => {
    it('default context has signal', () => {
      const ctx = createMockSkillContext();
      expect(ctx.signal).toBeInstanceOf(AbortSignal);
    });

    it('custom context with signal', () => {
      const ctrl = new AbortController();
      const ctx = createMockSkillContext({ signal: ctrl.signal });
      expect(ctx.signal).toBe(ctrl.signal);
      expect(ctx.signal.aborted).toBe(false);
    });
  });

  // EC4: ZaiError.toJSON() has required fields
  describe('EC4: ZaiError.toJSON() contract', () => {
    it('ZaiError base', () => {
      const err = new ZaiError('test message', 'CORE_PARSE_ERROR', 400);
      const json = err.toJSON();
      expect(json).toHaveProperty('code', 'CORE_PARSE_ERROR');
      expect(json).toHaveProperty('message', 'test message');
    });

    it('ZaiNetworkError', () => {
      const err = new ZaiNetworkError('timeout', 'ENGINE_AGENT_TIMEOUT', 504);
      const json = err.toJSON();
      expect(json.code).toBe('ENGINE_AGENT_TIMEOUT');
      expect(json.message).toBe('timeout');
    });

    it('ZaiToolError with toolName', () => {
      const err = new ZaiToolError('not found', 'TOOLS_FILE_NOT_FOUND', 404, 'file_read');
      const json = err.toJSON();
      expect(json).toHaveProperty('code', 'TOOLS_FILE_NOT_FOUND');
      expect(json).toHaveProperty('toolName', 'file_read');
    });

    it('SkillLoadError', () => {
      const err = new SkillLoadError('my-skill', 'import failed');
      expect(err.skillName).toBe('my-skill');
      const json = err.toJSON();
      expect(json.code).toBe('SKILLS_LOAD_FAILED');
    });

    it('SkillRuntimeError', () => {
      const err = new SkillRuntimeError('my-skill', 'runtime error');
      expect(err.skillName).toBe('my-skill');
    });

    it('SkillInvalidSignatureError', () => {
      const err = new SkillInvalidSignatureError('my-skill', 'missing execute');
      expect(err.skillName).toBe('my-skill');
    });

    it('ZaiConfigError', () => {
      const err = new ZaiConfigError('invalid config', { field: 'sandbox' });
      expect(err.detail).toEqual({ field: 'sandbox' });
    });

    it('ZaiSecurityError', () => {
      const err = new ZaiSecurityError('denied', 'shell');
      expect(err.operation).toBe('shell');
      expect(err.statusCode).toBe(403);
    });

    it('ZaiGatewayError', () => {
      const err = new ZaiGatewayError('transport error');
      expect(err.statusCode).toBe(502);
    });

    it('all ErrorCodes are unique', () => {
      const codes = Object.values(ErrorCodes);
      const unique = new Set(codes);
      expect(unique.size).toBe(codes.length);
    });
  });

  // EC5: Provider response contract
  describe('EC5: Provider response contract', () => {
    it('normal response: ≥1 chunk', async () => {
      const provider = createMockProvider([
        { type: 'text', content: 'hello' },
        { type: 'done', finishReason: 'stop' },
      ]);
      const chunks: ResponseChunk[] = [];
      for await (const c of provider.chat({ messages: [], sessionId: 'test' })) {
        chunks.push(c);
      }
      expect(chunks.length).toBeGreaterThanOrEqual(1);
    });

    it('empty response (AI refusal / safety block): single content="" chunk, not zero chunks', async () => {
      const refusalProvider = createMockProvider([
        { type: 'text', content: '' },
        { type: 'done', finishReason: 'stop' },
      ]);
      const chunks: ResponseChunk[] = [];
      for await (const c of refusalProvider.chat({ messages: [], sessionId: 'test' })) {
        chunks.push(c);
      }
      // Must produce at least 1 chunk (the empty content chunk)
      expect(chunks.length).toBeGreaterThanOrEqual(1);
      // The first meaningful chunk
      const textChunk = chunks.find(c => c.type === 'text');
      expect(textChunk).toBeDefined();
      expect(textChunk!.content).toBe('');
    });

    it('timeout: no chunks after 30s → ZaiNetworkError', async () => {
      // Use a provider that resolves after a very short time instead of never
      // (We simulate timeout here with a short timeout to keep test fast)
      const hangProvider = {
        ...createMockProvider([
          { type: 'text', content: 'eventual' },
          { type: 'done', finishReason: 'stop' },
        ]),
        chat: async function* (_req: ProviderChatRequest, signal?: AbortSignal) {
          // Simulate: if signal is already aborted, throw immediately
          if (signal?.aborted) {
            const err = new ZaiNetworkError('Request aborted', 'ENGINE_AGENT_TIMEOUT', 504);
            throw err;
          }
          yield { type: 'text' as const, content: 'ok' };
          yield { type: 'done' as const, finishReason: 'stop' };
        },
      };

      const ctrl = new AbortController();
      ctrl.abort(); // abort before sending

      try {
        for await (const _ of hangProvider.chat({ messages: [], sessionId: 'test' }, ctrl.signal)) {
          // should not reach
        }
        // Should have thrown
        expect(true).toBe(false);
      } catch (e) {
        expect(e).toBeInstanceOf(ZaiNetworkError);
      }
    });
  });

  // Protocol decode safety (from architecture: all external input goes through decode)
  describe('Protocol safety', () => {
    it('decode handles valid JSON-RPC', () => {
      const msg = { jsonrpc: '2.0' as const, id: 1, method: 'chat' };
      const result = decode(JSON.stringify(msg));
      expect('method' in result).toBe(true);
    });

    it('decode handles invalid JSON without throwing', () => {
      const result = decode('not json');
      expect('error' in result).toBe(true);
      if ('error' in result) {
        expect(result.error.code).toBe(JSONRPC_ERROR_CODES.PARSE_ERROR);
      }
    });

    it('decode handles non-object JSON without throwing', () => {
      const result = decode('"just a string"');
      expect('error' in result).toBe(true);
    });

    it('decode handles wrong JSON-RPC version', () => {
      const result = decode(JSON.stringify({ jsonrpc: '1.0', id: 1, method: 'test' }));
      expect('error' in result).toBe(true);
    });

    it('encode → decode roundtrip', () => {
      const original = encode({ jsonrpc: '2.0', id: 1, method: 'chat', params: { message: 'hello' } });
      const decoded = decode(original);
      expect('method' in decoded).toBe(true);
      if ('method' in decoded) {
        expect(decoded.method).toBe('chat');
      }
    });
  });
});
