// @zaivim/engine — Mock provider factories
// Used by: pipeline.test.ts, agent-handle.test.ts

import type { IProvider, ProviderChatRequest, ResponseChunk, ProviderCapabilities } from '@zaivim/core';

export function createMockProvider(opts?: Partial<IProvider>): IProvider {
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
      protocol: 'openai-compatible',
    },
    chat: async function* (_req: ProviderChatRequest, _signal?: AbortSignal) {
      yield { type: 'text' as const, content: 'mock response' };
      yield { type: 'done' as const, finishReason: 'stop' };
    },
    ...opts,
  };
}

export async function* createMockChunks(texts: string[]): AsyncIterable<ResponseChunk> {
  for (const text of texts) {
    yield { type: 'text', content: text };
  }
  yield { type: 'done', finishReason: 'stop' };
}

export function createMockProviderWithChunks(chunks: ResponseChunk[]): IProvider {
  return {
    name: 'mock-chunks',
    models: ['mock-model'],
    capabilities: {
      streaming: true,
      toolUse: true,
      caching: false,
      thinking: false,
      vision: false,
      maxContextTokens: 128_000,
      protocol: 'openai-compatible',
    },
    chat: async function* (_req: ProviderChatRequest, _signal?: AbortSignal) {
      for (const c of chunks) yield c;
    },
  };
}
