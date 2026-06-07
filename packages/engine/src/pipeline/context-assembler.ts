// @zaivim/engine — Context assembler
// Loads message history from SessionStore, estimates tokens, trims if needed.

import type { Message, Session, PersonaConfig } from '@zaivim/core';

export const PIPELINE_DEFAULTS = {
  maxToolCallRounds: 20,
  maxContextTokens: 102_400, // 128k * 80% (ADR-18)
  tokenEstimateCharsPerToken: 4,
  keepRecentMessages: 500,
  toolCallTimeout: 120_000,
} as const;

/**
 * Estimate token count using character-based approximation.
 * chars / 4 heuristic — will be replaced with tiktoken later.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / PIPELINE_DEFAULTS.tokenEstimateCharsPerToken);
}

/**
 * Estimate total tokens for an array of messages.
 */
export function estimateMessagesTokens(messages: Message[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateTokens(msg.content);
    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        total += estimateTokens(tc.name);
        total += estimateTokens(JSON.stringify(tc.arguments));
      }
    }
  }
  return total;
}

/**
 * Trim messages to fit within token budget.
 * Keeps: all pinned messages (placeholder for future) + most recent N messages.
 * Returns trimmed messages and count of removed messages.
 */
export function trimContext(
  messages: Message[],
  maxTokens: number,
  keepRecent: number = PIPELINE_DEFAULTS.keepRecentMessages,
): { messages: Message[]; removed: number } {
  if (messages.length <= keepRecent) {
    return { messages, removed: 0 };
  }

  // For now, simply keep the most recent N messages
  // Future: respect pinned messages
  const trimmed = messages.slice(-keepRecent);
  return { messages: trimmed, removed: messages.length - trimmed.length };
}

export interface ContextAssemblerOptions {
  readonly maxContextTokens?: number;
  readonly keepRecentMessages?: number;
  readonly emit?: (event: string, data: Record<string, unknown>) => void;
  readonly sessionId: string;
}

/**
 * Assemble context for a Provider request.
 * - Prepends system prompt from persona
 * - Sorts messages by seq
 * - Trims if token count exceeds budget
 */
export function assembleContext(
  session: Session,
  persona?: PersonaConfig,
  options?: ContextAssemblerOptions,
): { messages: Message[]; trimmed: number } {
  const maxTokens = options?.maxContextTokens ?? PIPELINE_DEFAULTS.maxContextTokens;
  const keepRecent = options?.keepRecentMessages ?? PIPELINE_DEFAULTS.keepRecentMessages;

  // Sort by seq (stable sort preserves insertion order for equal seq)
  const sorted = [...session.messages].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));

  // Build message array with optional system prompt
  const systemMsg: Message | null = persona?.systemPrompt
    ? { id: 'system', role: 'system', content: persona.systemPrompt }
    : null;

  const allMessages = systemMsg ? [systemMsg, ...sorted] : sorted;

  // Estimate tokens and trim if needed
  const tokenEstimate = estimateMessagesTokens(allMessages);
  let trimmed = 0;

  let finalMessages = allMessages;
  if (tokenEstimate > maxTokens) {
    // Trim only history messages (not system prompt)
    const historyOnly = systemMsg ? sorted : allMessages;
    const result = trimContext(historyOnly, maxTokens, keepRecent);
    trimmed = result.removed;
    finalMessages = systemMsg ? [systemMsg, ...result.messages] : result.messages;

    if (trimmed > 0 && options?.emit) {
      options.emit('session.auto_trimmed', {
        sessionId: options.sessionId,
        removed: trimmed,
      });
    }
  }

  return { messages: finalMessages, trimmed };
}
