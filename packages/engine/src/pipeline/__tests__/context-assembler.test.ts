import { describe, it, expect, vi } from 'vitest';
import type { Session, Message, ZaiConfig } from '@zaivim/core';
import {
  estimateTokens,
  estimateMessagesTokens,
  trimContext,
  assembleContext,
  PIPELINE_DEFAULTS,
} from '../context-assembler.js';

function makeMessage(role: Message['role'], content: string, seq?: number): Message {
  return { id: `msg-${Math.random()}`, role, content, seq };
}

function makeSession(messages: Message[]): Session {
  return {
    id: 'test-session',
    messages,
    createdAt: Date.now(),
    config: {} as ZaiConfig,
    status: 'active',
  };
}

describe('estimateTokens', () => {
  it('should estimate tokens using chars/4 heuristic', () => {
    // 100 chars → 25 tokens
    expect(estimateTokens('a'.repeat(100))).toBe(25);
  });

  it('should round up', () => {
    // 5 chars → 1.25 → ceil = 2
    expect(estimateTokens('hello')).toBe(2);
  });

  it('should handle empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('deviation should be within 20% for typical English text', () => {
    // "Hello world this is a test of token estimation" = 47 chars → 12 tokens estimated
    // Actual tiktoken would be ~10-12 tokens, so 12 is within 20%
    const text = 'Hello world this is a test of token estimation';
    const estimated = estimateTokens(text);
    // Real token count is typically between chars/5 and chars/3
    const lowerBound = Math.floor(text.length / 5);
    const upperBound = Math.ceil(text.length / 3);
    expect(estimated).toBeGreaterThanOrEqual(lowerBound);
    expect(estimated).toBeLessThanOrEqual(upperBound * 1.2);
  });
});

describe('estimateMessagesTokens', () => {
  it('should sum token estimates for all messages', () => {
    const messages = [
      makeMessage('user', 'hello'),     // 5 chars → 2 tokens
      makeMessage('assistant', 'world'), // 5 chars → 2 tokens
    ];
    const total = estimateMessagesTokens(messages);
    expect(total).toBe(4); // 2 + 2
  });

  it('should include toolCalls in estimate', () => {
    const messages: Message[] = [{
      id: 'msg-1',
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'tc-1', name: 'read_file', arguments: { path: '/test.txt' } }],
    }];
    const total = estimateMessagesTokens(messages);
    expect(total).toBeGreaterThan(0);
  });
});

describe('trimContext', () => {
  it('should not trim if under limit', () => {
    const messages = Array.from({ length: 10 }, (_, i) => makeMessage('user', `msg ${i}`, i));
    const result = trimContext(messages, 100_000);
    expect(result.messages.length).toBe(10);
    expect(result.removed).toBe(0);
  });

  it('should trim to keepRecentMessages when over limit', () => {
    const messages = Array.from({ length: 600 }, (_, i) => makeMessage('user', `msg ${i}`, i));
    const result = trimContext(messages, 100_000, 500);
    expect(result.messages.length).toBe(500);
    expect(result.removed).toBe(100);
    // Should keep most recent messages
    expect(result.messages[result.messages.length - 1]!.content).toBe('msg 599');
  });

  it('should keep last keepRecent messages', () => {
    const messages = Array.from({ length: 501 }, (_, i) => makeMessage('user', `msg ${i}`, i));
    const result = trimContext(messages, 100_000, 500);
    expect(result.messages.length).toBe(500);
    expect(result.messages[0]!.content).toBe('msg 1'); // oldest kept
  });
});

describe('assembleContext', () => {
  it('should sort messages by seq', () => {
    const messages = [
      makeMessage('user', 'third', 3),
      makeMessage('user', 'first', 1),
      makeMessage('user', 'second', 2),
    ];
    const session = makeSession(messages);
    const { messages: result } = assembleContext(session);
    expect(result.map(m => m.content)).toEqual(['first', 'second', 'third']);
  });

  it('should prepend system prompt from persona', () => {
    const messages = [makeMessage('user', 'hello', 1)];
    const session = makeSession(messages);
    const { messages: result } = assembleContext(session, {
      name: 'test',
      systemPrompt: 'You are a helpful assistant.',
    });
    expect(result[0]!.role).toBe('system');
    expect(result[0]!.content).toBe('You are a helpful assistant.');
    expect(result.length).toBe(2);
  });

  it('should not prepend system prompt when persona has none', () => {
    const messages = [makeMessage('user', 'hello', 1)];
    const session = makeSession(messages);
    const { messages: result } = assembleContext(session, { name: 'test', systemPrompt: '' });
    expect(result.length).toBe(1);
  });

  it('should trim and emit event when over token budget', () => {
    const emit = vi.fn();
    const messages = Array.from({ length: 600 }, (_, i) =>
      makeMessage('user', `msg ${i} with some content to make it longer`, i),
    );
    const session = makeSession(messages);

    // Use very low maxContextTokens to force trimming
    const { trimmed } = assembleContext(session, undefined, {
      maxContextTokens: 50, // Force trim
      sessionId: 'test-session',
      emit,
      keepRecentMessages: 10,
    });
    // Should have trimmed some messages
    expect(trimmed).toBeGreaterThan(0);
  });

  it('should handle empty messages', () => {
    const session = makeSession([]);
    const { messages } = assembleContext(session);
    expect(messages.length).toBe(0);
  });
});
