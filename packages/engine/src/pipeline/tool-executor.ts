// @zaivim/engine — Tool call executor
// Executes tool calls from AI responses with timeout, validation, and abort support.

import type { ToolDefinition, ToolContext, ResponseChunk, Message } from '@zaivim/core';
import { randomUUID } from 'node:crypto';

export interface ToolCallRequest {
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

export interface ToolExecutorOptions {
  readonly sessionId: string;
  readonly sandbox: string;
  readonly signal?: AbortSignal;
  readonly security: import('@zaivim/core').ISecurityProvider;
  readonly audit: (action: string, detail: Record<string, unknown>) => void;
  readonly timeout?: number;
  readonly emit?: (event: string, data: Record<string, unknown>) => void;
}

/**
 * Execute a single tool call with timeout and abort support.
 */
export async function executeToolCall(
  tc: ToolCallRequest,
  tools: ToolDefinition[],
  options: ToolExecutorOptions,
): Promise<{ result: string; timedOut: boolean }> {
  const toolDef = tools.find(t => t.name === tc.name);
  if (!toolDef) {
    return {
      result: JSON.stringify({ error: `Tool not found: ${tc.name}` }),
      timedOut: false,
    };
  }

  // Security enforcement: preExecute check (AC9 / ADR-5)
  const decision = await options.security.preExecute(tc.name, tc.arguments);
  if (!decision.allowed) {
    return {
      result: JSON.stringify({
        error: `Tool execution blocked by security policy`,
        harmLevel: decision.harmLevel,
        reason: decision.reason,
      }),
      timedOut: false,
    };
  }

  const timeout = options.timeout ?? 120_000;
  const start = Date.now();

  // Combine caller's AbortSignal with a timeout signal (AC14)
  const timeoutSignal = AbortSignal.timeout(timeout);
  const combinedSignal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;

  const ctx: ToolContext = {
    sessionId: options.sessionId,
    sandbox: options.sandbox,
    signal: combinedSignal,
    security: options.security,
    audit: options.audit,
  };

  try {
    const result = await toolDef.execute(tc.arguments, ctx);
    // Check if signal was aborted during execution (tool may have resolved instead of throwing)
    if (ctx.signal.aborted) {
      const elapsed = Date.now() - start;
      options.emit?.('tool.timeout', {
        toolCallId: tc.id,
        elapsed,
      });
      await options.security.postExecute(tc.name, { success: false, output: 'timed out' }).catch(() => {});
      return {
        result: `error: tool execution timed out after ${Math.round(timeout / 1000)}s`,
        timedOut: true,
      };
    }
    const output = typeof result === 'string' ? result : JSON.stringify(result);
    // Security enforcement: postExecute audit (AC9 / ADR-5)
    await options.security.postExecute(tc.name, { success: true, output }).catch(() => {});
    return { result: output, timedOut: false };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError' ||
        (err instanceof Error && err.message.includes('aborted'))) {
      const elapsed = Date.now() - start;
      options.emit?.('tool.timeout', {
        toolCallId: tc.id,
        elapsed,
      });
      await options.security.postExecute(tc.name, { success: false, output: 'timed out' }).catch(() => {});
      return {
        result: `error: tool execution timed out after ${Math.round(timeout / 1000)}s`,
        timedOut: true,
      };
    }
    await options.security.postExecute(tc.name, { success: false }).catch(() => {});
    return {
      result: `error: ${err instanceof Error ? err.message : String(err)}`,
      timedOut: false,
    };
  }
}

/**
 * Execute multiple tool calls (MVP: serial execution).
 * Returns tool result messages ready to be sent back to provider.
 */
export async function executeToolCalls(
  toolCalls: ToolCallRequest[],
  tools: ToolDefinition[],
  options: ToolExecutorOptions,
): Promise<Message[]> {
  const results: Message[] = [];

  for (const tc of toolCalls) {
    options.signal?.throwIfAborted();

    const { result } = await executeToolCall(tc, tools, options);

    const toolMsg: Message = {
      id: randomUUID(),
      role: 'tool',
      content: result,
    };
    results.push(toolMsg);
  }

  return results;
}

/**
 * Validate tool calls against registered tools.
 * Returns valid tool calls and yields error chunks for unknown tools.
 */
export function validateToolCalls(
  rawCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
  tools: ToolDefinition[],
): { valid: ToolCallRequest[]; errors: ResponseChunk[] } {
  const valid: ToolCallRequest[] = [];
  const errors: ResponseChunk[] = [];
  const registeredNames = new Set(tools.map(t => t.name));

  for (const tc of rawCalls) {
    if (!tc.id) {
      errors.push({
        type: 'error',
        code: 'PIPELINE_TOOL_NOT_FOUND',
        message: `Tool call missing id field`,
      });
      continue;
    }
    if (!registeredNames.has(tc.name)) {
      errors.push({
        type: 'error',
        code: 'PIPELINE_TOOL_NOT_FOUND',
        message: `Unknown tool: ${tc.name}`,
      });
      continue;
    }
    valid.push(tc);
  }

  return { valid, errors };
}
