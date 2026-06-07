// @zaivim/engine — Context assembler
// Loads message history from SessionStore, estimates tokens, trims if needed.

import type { Message, Session, PersonaConfig, FileAttachment } from '@zaivim/core';

export const PIPELINE_DEFAULTS = {
  maxToolCallRounds: 20,
  maxContextTokens: 102_400, // 128k * 80% (ADR-18)
  tokenEstimateCharsPerToken: 4,
  keepRecentMessages: 10,
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
 * Trim messages to fit within token budget using four-level priority:
 *   (1) system + skill messages → never trim (priority 1)
 *   (2) pinned messages → never trim (priority 2)
 *   (3) recent N messages → protected from budget trim (priority 3)
 *   (4) middle history → FIFO trim (priority 4)
 *
 * Enforces a total count cap: after trimming, at most `keepRecent`
 * non-system messages survive (system bypasses this cap).
 *
 * Falls back to pure FIFO if protected messages alone exceed budget.
 */
export function trimContext(
  messages: Message[],
  maxTokens: number,
  keepRecent: number = PIPELINE_DEFAULTS.keepRecentMessages,
): { messages: Message[]; removed: number } {
  // Delegate to internal impl so tests can exercise the public API
  return trimContextImpl(messages, maxTokens, keepRecent);
}

function trimContextImpl(
  messages: Message[],
  maxTokens: number,
  keepRecent: number,
): { messages: Message[]; removed: number } {
  // Step 1: Classify each message
  const systemMsgs: Message[] = [];
  const pinnedMsgs: Message[] = [];
  const recentMsgs: Message[] = [];
  const middleMsgs: Message[] = [];

  const recentThreshold = Math.max(0, messages.length - keepRecent);

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role === 'system') {
      // Priority 1: system → never trim
      systemMsgs.push(msg);
    } else if (msg.pinned) {
      // Priority 2: pinned → never trim
      pinnedMsgs.push(msg);
    } else if (i >= recentThreshold) {
      // Priority 3: recent → protected from budget trim
      recentMsgs.push(msg);
    } else {
      // Priority 4: middle → trimmable by budget + count cap
      middleMsgs.push(msg);
    }
  }

  // Count cap: system bypasses cap, pinned+recent+middle fit within keepRecent
  const pinnedAndRecentCount = pinnedMsgs.length + recentMsgs.length;
  const middleBudget = Math.max(0, keepRecent - pinnedAndRecentCount);
  const middleTrimCount = Math.max(0, middleMsgs.length - middleBudget);
  const countCapped = middleMsgs.slice(0, middleTrimCount);
  let budgetTrimmable = middleMsgs.slice(middleTrimCount);

  // Token budget: trim further from middle (newest-first)
  {
    const allProtected = [...systemMsgs, ...pinnedMsgs, ...recentMsgs, ...budgetTrimmable];
    const protectedTokens = estimateMessagesTokens(allProtected);

    // Degradation: if protected alone exceeds budget, fall back to simple FIFO
    if (protectedTokens > maxTokens) {
      let startIdx = 0;
      while (startIdx < messages.length) {
        if (estimateMessagesTokens(messages.slice(startIdx)) <= maxTokens) break;
        startIdx++;
      }
      return { messages: messages.slice(startIdx), removed: startIdx };
    }

    const budget = maxTokens - protectedTokens;
    const retained: Message[] = [];
    let remaining = budget;
    for (let i = budgetTrimmable.length - 1; i >= 0; i--) {
      const msg = budgetTrimmable[i]!;
      const cost = estimateMessagesTokens([msg]);
      if (cost > remaining) break;
      retained.unshift(msg);
      remaining -= cost;
    }
    budgetTrimmable = retained;
  }

  const result = [...systemMsgs, ...pinnedMsgs, ...budgetTrimmable, ...recentMsgs];
  const removed = messages.length - result.length;

  return { messages: result, removed };
}

export interface ContextAssemblerOptions {
  readonly maxContextTokens?: number;
  readonly keepRecentMessages?: number;
  readonly emit?: (event: string, data: Record<string, unknown>) => void;
  readonly sessionId: string;
  readonly formatAttachments?: (attachments: readonly FileAttachment[]) => string;
}

/**
 * Inject attachment content into messages that have attachments.
 */
function injectAttachments(
  messages: Message[],
  formatFn: (attachments: readonly FileAttachment[]) => string,
): Message[] {
  return messages.map(msg => {
    if (!msg.attachments || msg.attachments.length === 0) return msg;
    const attachmentText = formatFn(msg.attachments);
    return { ...msg, content: msg.content + attachmentText };
  });
}

/**
 * Assemble context for a Provider request.
 * - Prepends system prompt from persona
 * - Sorts messages by seq
 * - Injects file attachments into messages
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

  // Inject file attachments into messages
  const injected = options?.formatAttachments
    ? injectAttachments(sorted, options.formatAttachments)
    : sorted;

  // Build message array with optional system prompt
  const systemMsg: Message | null = persona?.systemPrompt
    ? { id: 'system', role: 'system', content: persona.systemPrompt }
    : null;

  const allMessages = systemMsg ? [systemMsg, ...injected] : injected;

  // Estimate tokens and trim if needed
  const tokenEstimate = estimateMessagesTokens(allMessages);
  let trimmed = 0;

  let finalMessages = allMessages;
  if (tokenEstimate > maxTokens) {
    // Trim only history messages (not system prompt)
    const historyOnly = systemMsg ? injected : allMessages;
    const result = trimContext(historyOnly, maxTokens, keepRecent);
    trimmed = result.removed;
    finalMessages = systemMsg ? [systemMsg, ...result.messages] : result.messages;

    if (trimmed > 0 && options?.emit) {
      options.emit('session.auto_trimmed', {
        sessionId: options.sessionId,
        removed: trimmed,
        retained: finalMessages.length,
      });
    }
  }

  return { messages: finalMessages, trimmed };
}
