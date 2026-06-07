// =============================================================================
// @zaivim/engine — E6 integration verification: AgentHandle ↔ Provider interface compat
// Story 1b.1 Task 7: SC2 — verify IProvider.chat() and AgentHandle.send() interfaces align
// =============================================================================

import { describe, it, expect } from 'vitest';
import type { AgentHandle, Message, ResponseChunk, IProvider } from '@zaivim/core';
import { createMockProvider } from '../test-utils/mock-provider.js';
import { createProviderRegistry } from '../provider/index.js';

/**
 * Minimal mock AgentHandle that delegates to an IProvider.
 * Verifies that AgentHandle.send() and IProvider.chat() are interface-compatible.
 */
function createMockAgentHandle(provider: IProvider): AgentHandle {
  let status: 'idle' | 'running' | 'done' = 'idle';

  return {
    id: `agent-${provider.name}`,
    persona: {
      name: 'test-agent',
      systemPrompt: 'You are a test agent',
    },
    status: () => status,
    send: async function* (message: Message, signal?: AbortSignal) {
      status = 'running';
      try {
        yield* provider.chat(
          {
            messages: [message],
            sessionId: 'test-session',
          },
          signal,
        );
      } finally {
        status = 'done';
      }
    },
    cancel: () => { status = 'done'; },
  };
}

describe('E6 AgentHandle ↔ Provider integration (SC2)', () => {
  it('AgentHandle.send() streams from IProvider.chat()', async () => {
    const provider = createMockProvider({ name: 'test-provider' });
    const agent = createMockAgentHandle(provider);

    const chunks: ResponseChunk[] = [];
    for await (const chunk of agent.send({
      id: 'msg-1',
      role: 'user',
      content: 'Hello',
    })) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks[0]!.type).toBe('text');
    expect(chunks[chunks.length - 1]!.type).toBe('done');
  });

  it('AgentHandle works with mock provider simulating registry flow', async () => {
    // Simulate the pattern: get provider from registry → create agent → send
    // Using mock to avoid network calls
    const mockProvider = createMockProvider({
      name: 'mock-from-registry',
      models: ['mock-model-v2'],
    });

    const agent = createMockAgentHandle(mockProvider);

    const chunks: ResponseChunk[] = [];
    for await (const chunk of agent.send({
      id: 'msg-2',
      role: 'user',
      content: 'Test',
    })) {
      chunks.push(chunk);
    }

    expect(chunks.some((c) => c.type === 'text' || c.type === 'done')).toBe(true);
  });

  it('AgentHandle status transitions correctly', async () => {
    const provider = createMockProvider();
    const agent = createMockAgentHandle(provider);

    expect(agent.status()).toBe('idle');

    const iter = agent.send({
      id: 'msg-3',
      role: 'user',
      content: 'Status test',
    });

    // Start iterating
    const first = await iter.next();
    expect(first.done).toBe(false);
    expect(agent.status()).toBe('running');

    // Consume rest
    for await (const _ of iter) { /* consume */ }
    expect(agent.status()).toBe('done');
  });
});
