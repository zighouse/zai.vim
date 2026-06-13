// @zaivim/engine — Tool call executor
// Executes tool calls from AI responses with timeout, validation, and abort support.
// Story 3.3: tool dispatch now flows through ToolRegistry (single source of truth)
// instead of a ToolDefinition[] array. validateAndExecute provides the unified
// validation + execution + JSON roundtrip gate (AC2/AC3/AC4).

import type { ToolContext, ResponseChunk, Message, ISecurityProvider } from '@zaivim/core';
import { NullSecurityProvider } from '@zaivim/core';
import { ToolRegistry, validateAndExecute } from '@zaivim/tools';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import type { SandboxManager } from '../security/index.js';
import { ShellExecutorFactory } from './shell-executor.js';
import type { SandboxCapabilities } from './shell-executor.js';

export interface ToolCallRequest {
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

export interface ToolExecutorOptions {
  readonly sessionId: string;
  readonly sandbox: string;
  readonly signal?: AbortSignal;
  /**
   * Security provider. When omitted, a NullSecurityProvider is constructed
   * with the audit sink as its logger so degraded execution still records
   * warnings (Story 3.3 AC5).
   */
  readonly security?: ISecurityProvider;
  readonly audit: (action: string, detail: Record<string, unknown>) => void;
  readonly timeout?: number;
  readonly emit?: (event: string, data: Record<string, unknown>) => void;
  /** SandboxManager for creating ctx.exec (Story 3.2a / ADR-SHELL-2) */
  readonly sandboxManager?: SandboxManager;
  /** Override sandbox capabilities (default: minimal restrictions) */
  readonly sandboxCapabilities?: SandboxCapabilities;
}

/**
 * Execute a single tool call with timeout and abort support.
 *
 * Story 3.3: dispatch resolves the tool via `registry.get(name)`. Unknown
 * tools return a structured `{ code: 'TOOLS_NOT_FOUND', message }` error
 * so Gateways can map the code uniformly.
 */
export async function executeToolCall(
  tc: ToolCallRequest,
  registry: ToolRegistry,
  options: ToolExecutorOptions,
): Promise<{ result: string; timedOut: boolean }> {
  const toolDef = registry.get(tc.name);
  if (!toolDef) {
    return {
      result: JSON.stringify({
        code: 'TOOLS_NOT_FOUND',
        message: `Tool not found: ${tc.name}`,
      }),
      timedOut: false,
    };
  }

  // Story 3.3 AC5: when no security provider is injected (E2 degraded), fall
  // back to NullSecurityProvider but route its warnings through the audit sink
  // so degradation is observable in the JSONL log.
  const security: ISecurityProvider = options.security ?? new NullSecurityProvider({
    logger: {
      warn: (msg: string) => options.audit('security.fallback', { reason: msg, tool: tc.name }),
    },
  });

  // Security enforcement: preExecute check (AC9 / ADR-5)
  const decision = await security.preExecute(tc.name, tc.arguments);
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

  // TOCTOU protection: re-resolve file paths for file operations (Story 2.2, Task 1.8)
  if (tc.name === 'file_read' || tc.name === 'file_write' || tc.name === 'file_delete' || tc.name === 'file_modify') {
    const originalPath = tc.arguments.path as string;
    if (originalPath) {
      try {
        const reResolved = realpathSync.native(resolve(originalPath));
        // If preExecute resolved a different path, the symlink may have been swapped
        // Store the re-resolved path for the tool's use
        tc.arguments.__resolvedPath = reResolved;
      } catch {
        // Path doesn't exist yet (e.g., creating a new file) — this is expected
        // The tool will handle creation; no TOCTOU risk for non-existent paths
      }
    }
  }

  const timeout = options.timeout ?? 120_000;
  const start = Date.now();

  // Combine caller's AbortSignal with a timeout signal (AC14, AC5: signal never undefined)
  const timeoutSignal = AbortSignal.timeout(timeout);
  const combinedSignal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;

  const ctx: ToolContext = {
    sessionId: options.sessionId,
    sandbox: options.sandbox,
    signal: combinedSignal,
    security,
    audit: options.audit,
    spawn: (command, args, opts) => spawn(command, args ?? [], opts ?? {}),
    exec: options.sandboxManager && options.sandboxCapabilities
      ? ShellExecutorFactory.create(
          options.sandboxManager,
          options.sandboxCapabilities,
        )
      : undefined,
  };

  try {
    // Story 3.3 AC2/AC4: route through validateAndExecute so params shape and
    // JSON-serializability are checked at the registry layer.
    const result = await validateAndExecute(toolDef, tc.arguments, ctx);
    // Check if signal was aborted during execution (tool may have resolved instead of throwing)
    if (ctx.signal.aborted) {
      const elapsed = Date.now() - start;
      options.emit?.('tool.timeout', {
        toolCallId: tc.id,
        elapsed,
      });
      await security.postExecute(tc.name, { success: false, output: 'timed out', sessionId: options.sessionId }).catch(() => {});
      return {
        result: `error: tool execution timed out after ${Math.round(timeout / 1000)}s`,
        timedOut: true,
      };
    }
    const output = typeof result === 'string' ? result : JSON.stringify(result);
    // Security enforcement: postExecute audit (AC9 / ADR-5)
    await security.postExecute(tc.name, { success: true, output, sessionId: options.sessionId }).catch(() => {});
    return { result: output, timedOut: false };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError' ||
        (err instanceof Error && err.message.includes('aborted'))) {
      const elapsed = Date.now() - start;
      options.emit?.('tool.timeout', {
        toolCallId: tc.id,
        elapsed,
      });
      await security.postExecute(tc.name, { success: false, output: 'timed out', sessionId: options.sessionId }).catch(() => {});
      return {
        result: `error: tool execution timed out after ${Math.round(timeout / 1000)}s`,
        timedOut: true,
      };
    }
    await security.postExecute(tc.name, { success: false, sessionId: options.sessionId }).catch(() => {});
    const code = (err as { code?: string })?.code;
    const message = err instanceof Error ? err.message : String(err);
    // Preserve ZaiToolError structure when validateAndExecute throws
    // (TOOLS_INVALID_PARAMS, TOOLS_OUTPUT_NOT_SERIALIZABLE) so the AI gets a
    // structured error rather than a generic string.
    if (code === 'TOOLS_INVALID_PARAMS' || code === 'TOOLS_OUTPUT_NOT_SERIALIZABLE') {
      return {
        result: JSON.stringify({ code, message }),
        timedOut: false,
      };
    }
    return {
      result: `error: ${message}`,
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
  registry: ToolRegistry,
  options: ToolExecutorOptions,
): Promise<Message[]> {
  const results: Message[] = [];

  for (const tc of toolCalls) {
    options.signal?.throwIfAborted();

    const { result } = await executeToolCall(tc, registry, options);

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
 *
 * Story 3.3: PIPELINE_TOOL_NOT_FOUND is retained for "missing id field"
 * (call-shape protocol violation). Unknown tool *names* now emit the unified
 * TOOLS_NOT_FOUND code so Gateway mappings stay consistent with executeToolCall.
 */
export function validateToolCalls(
  rawCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
  registry: ToolRegistry,
): { valid: ToolCallRequest[]; errors: ResponseChunk[] } {
  const valid: ToolCallRequest[] = [];
  const errors: ResponseChunk[] = [];
  const registeredNames = new Set(registry.list().map(t => t.name));

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
        code: 'TOOLS_NOT_FOUND',
        message: `Unknown tool: ${tc.name}`,
      });
      continue;
    }
    valid.push(tc);
  }

  return { valid, errors };
}
