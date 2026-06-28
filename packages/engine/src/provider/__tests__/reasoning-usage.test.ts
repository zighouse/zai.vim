// @zaivim/engine — Provider reasoning_content + usage parsing tests
// Story 5.5: AC5 (thinking chunks from reasoner models) and AC6 (stats from usage field)

import { describe, it, expect, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import { OpenAICompatibleProvider } from '../index.js';
import type { ProviderConfig } from '../index.js';
import type { ResponseChunk } from '@zaivim/core';

const BASE_CONFIG: ProviderConfig = {
  name: 'test',
  type: 'openai',
  apiKey: 'sk-test',
  baseURL: 'https://api.test.com',
  models: ['test-model'],
  defaultModel: 'test-model',
};

/** Build a mock SSE response body containing the given lines as data: events. */
function mockSSE(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const chunks = lines.map(l => encoder.encode(l + '\n'));
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

function mockFetch(body: ReadableStream<Uint8Array>): typeof globalThis.fetch {
  return async () =>
    new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
}

async function collect(chunks: AsyncIterable<ResponseChunk>): Promise<ResponseChunk[]> {
  const result: ResponseChunk[] = [];
  for await (const c of chunks) result.push(c);
  return result;
}

describe('reasoning_content parsing (AC5)', () => {
  let provider: OpenAICompatibleProvider;

  beforeEach(() => {
    provider = new OpenAICompatibleProvider(BASE_CONFIG, undefined, mockFetch(mockSSE([])));
  });

  it('emits thinking:start → thinking:delta → thinking:end → phase:response for reasoning_content', async () => {
    const sseLines = [
      'data: {"choices":[{"delta":{"content":"","reasoning_content":"Let me think"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{"content":"","reasoning_content":" about this"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{"content":"Here is the answer"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    ];
    const provider2 = new OpenAICompatibleProvider(BASE_CONFIG, undefined, mockFetch(mockSSE(sseLines)));
    const chunks = await collect(provider2.chat({ messages: [], sessionId: 'test' }));

    const types = chunks.map(c => c.type);
    // phase:thinking → thinking:start → thinking:delta → thinking:delta → thinking:end → phase:response → text → done
    expect(types[0]).toBe('phase');
    expect((chunks[0] as any).phase).toBe('thinking');
    expect(types[1]).toBe('thinking');
    expect((chunks[1] as any).phase).toBe('start');
    expect(types[2]).toBe('thinking');
    expect((chunks[2] as any).phase).toBe('delta');
    expect((chunks[2] as any).content).toBe('Let me think');
    expect(types[3]).toBe('thinking');
    expect((chunks[3] as any).phase).toBe('delta');
    expect((chunks[3] as any).content).toBe(' about this');
    expect(types[4]).toBe('thinking');
    expect((chunks[4] as any).phase).toBe('end');
    expect(types[5]).toBe('phase');
    expect((chunks[5] as any).phase).toBe('response');
    expect(types[6]).toBe('text');
    expect((chunks[6] as any).content).toBe('Here is the answer');
    expect(types[types.length - 1]).toBe('done');
  });

  it('emits thinking:end + phase:response when stream ends mid-thinking', async () => {
    const sseLines = [
      'data: {"choices":[{"delta":{"content":"","reasoning_content":"Incomplete reasoning"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    ];
    const provider2 = new OpenAICompatibleProvider(BASE_CONFIG, undefined, mockFetch(mockSSE(sseLines)));
    const chunks = await collect(provider2.chat({ messages: [], sessionId: 'test' }));

    const types = chunks.map(c => c.type);
    expect(types).toContain('thinking');
    expect(types).toContain('phase');
    // Last phase before done should be 'response' (AC7 + M1 fix)
    const phases = chunks.filter(c => c.type === 'phase') as Array<{ type: 'phase'; phase: string }>;
    expect(phases[phases.length - 1].phase).toBe('response');
  });

  it('does not emit thinking chunks for text-only responses', async () => {
    const sseLines = [
      'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    ];
    const provider2 = new OpenAICompatibleProvider(BASE_CONFIG, undefined, mockFetch(mockSSE(sseLines)));
    const chunks = await collect(provider2.chat({ messages: [], sessionId: 'test' }));

    const thinkingChunks = chunks.filter(c => c.type === 'thinking');
    expect(thinkingChunks).toHaveLength(0);
  });
});

describe('usage parsing (AC6)', () => {
  it('emits stats chunk when usage is present in final chunk', async () => {
    const sseLines = [
      'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":10,"completion_tokens":25}}',
    ];
    const provider = new OpenAICompatibleProvider(BASE_CONFIG, undefined, mockFetch(mockSSE(sseLines)));
    const chunks = await collect(provider.chat({ messages: [], sessionId: 'test' }));

    const statsChunks = chunks.filter(c => c.type === 'stats');
    expect(statsChunks).toHaveLength(1);
    const stats = statsChunks[0] as any;
    expect(stats.tokensIn).toBe(10);
    expect(stats.tokensOut).toBe(25);
    expect(typeof stats.elapsedMs).toBe('number');
    expect(typeof stats.speed).toBe('number');
  });

  it('does not emit stats when usage is missing', async () => {
    const sseLines = [
      'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    ];
    const provider = new OpenAICompatibleProvider(BASE_CONFIG, undefined, mockFetch(mockSSE(sseLines)));
    const chunks = await collect(provider.chat({ messages: [], sessionId: 'test' }));

    const statsChunks = chunks.filter(c => c.type === 'stats');
    expect(statsChunks).toHaveLength(0);
  });
});

describe('reasoning_content round-trip (outgoing)', () => {
  it('serializes reasoning_content on assistant messages into the request body', async () => {
    const sseLines = [
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    ];
    let capturedBody: { messages: Array<Record<string, unknown>> } | undefined;
    const capturingFetch = (async (_url: unknown, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string) as { messages: Array<Record<string, unknown>> };
      return new Response(mockSSE(sseLines), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }) as typeof globalThis.fetch;

    const provider = new OpenAICompatibleProvider(BASE_CONFIG, undefined, capturingFetch);
    await collect(provider.chat({
      messages: [
        { id: 'u1', role: 'user', content: 'hi' },
        { id: 'a1', role: 'assistant', content: '', toolCalls: [{ id: 'tc-1', name: 'echo', arguments: {} }], reasoningContent: 'I should think first' },
        { id: 't1', role: 'tool', content: 'result', toolCallId: 'tc-1' },
      ],
      sessionId: 'test',
    }));

    expect(capturedBody).toBeDefined();
    const assistant = capturedBody!.messages.find(m => m.role === 'assistant');
    expect(assistant).toBeDefined();
    expect(assistant!.reasoning_content).toBe('I should think first');
  });

  it('omits reasoning_content when the assistant message has none', async () => {
    const sseLines = [
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    ];
    let capturedBody: { messages: Array<Record<string, unknown>> } | undefined;
    const capturingFetch = (async (_url: unknown, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string) as { messages: Array<Record<string, unknown>> };
      return new Response(mockSSE(sseLines), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }) as typeof globalThis.fetch;

    const provider = new OpenAICompatibleProvider(BASE_CONFIG, undefined, capturingFetch);
    await collect(provider.chat({
      messages: [
        { id: 'u1', role: 'user', content: 'hi' },
        { id: 'a1', role: 'assistant', content: 'plain answer' },
      ],
      sessionId: 'test',
    }));

    const assistant = capturedBody!.messages.find(m => m.role === 'assistant');
    expect(assistant).toBeDefined();
    expect(assistant).not.toHaveProperty('reasoning_content');
  });
});
