// @zaivim/engine — Tool call executor
// Executes tool calls from AI responses with timeout, validation, and abort support.
// Story 3.3: tool dispatch now flows through ToolRegistry (single source of truth)
// instead of a ToolDefinition[] array. validateAndExecute provides the unified
// validation + execution + JSON roundtrip gate (AC2/AC3/AC4).
// Story 3.4: high-risk tools (toolDef.highRisk === true) are routed to a
// SubSandboxProvider before security.preExecute so they never touch the
// primary BwrapSecurityProvider sandbox (AC1).

import type { ToolContext, ResponseChunk, Message, ISecurityProvider, SubSandboxConfig } from '@zaivim/core';
import { NullSecurityProvider } from '@zaivim/core';
import { ToolRegistry, validateAndExecute } from '@zaivim/tools';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import type { SandboxManager, SubSandboxManager } from '../security/index.js';
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
  /**
   * Story 3.4: when present, tools with `toolDef.highRisk === true` are routed
   * to a SubSandboxProvider for isolated execution. When absent, high-risk
   * execution degrades gracefully to an ISOLATED_UNAVAILABLE response.
   */
  readonly subSandboxManager?: SubSandboxManager;
  /**
   * Story 3.4: optional sub-sandbox config override (timeout clamp, memory
   * check). When omitted, the manager's built-in config is used.
   */
  readonly subSandboxConfig?: Partial<SubSandboxConfig>;
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

  // Story 3.4 (AC1): high-risk tools bypass the primary sandbox path entirely.
  // Routed before security.preExecute so no high-risk command ever touches the
  // primary BwrapSecurityProvider. The high-risk check is general — it keys
  // off toolDef.highRisk rather than tc.name — so future tools (database_execute)
  // can opt in without executor changes.
  if (toolDef.highRisk === true) {
    return executeHighRiskTool(tc, toolDef, options);
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

// ─── Story 3.4: High-risk tool dispatch (AC1, AC2, AC4, AC5) ────────────────

const HIGHRISK_MIN_TIMEOUT_MS = 5_000;

/**
 * Execute a high-risk tool in an isolated SubSandboxProvider.
 *
 * Currently the only high-risk surface is `shell_execute`-style command
 * execution: we read `tc.arguments.command` and run it in the sub-sandbox.
 * The check is keyed on `toolDef.highRisk` rather than `tc.name` so future
 * tools (database_execute) can opt in without changes here.
 *
 * Lifecycle (AC3): the SubSandboxProvider is bound via `using` so its
 * `[Symbol.dispose]` runs destroy() at scope exit (return or throw) — no
 * residue even on abort/timeout.
 */
async function executeHighRiskTool(
  tc: ToolCallRequest,
  _toolDef: import('@zaivim/core').ToolDefinition,
  options: ToolExecutorOptions,
): Promise<{ result: string; timedOut: boolean }> {
  // Manager not configured → graceful degradation (Pre-mortem edge case table)
  if (!options.subSandboxManager) {
    options.audit('isolated.unavailable', {
      tool: tc.name,
      reason: 'SubSandboxManager not configured',
      sessionId: options.sessionId,
    });
    return {
      result: JSON.stringify({
        code: 'ISOLATED_UNAVAILABLE',
        message: 'SubSandboxManager not configured',
      }),
      timedOut: false,
    };
  }

  // Pull command + optional execution metadata from the tool call.
  const command = tc.arguments.command;
  if (typeof command !== 'string' || command.length === 0) {
    options.audit('isolated.invalid_command', {
      tool: tc.name,
      sessionId: options.sessionId,
    });
    return {
      result: JSON.stringify({
        code: 'TOOLS_INVALID_PARAMS',
        message: 'high-risk execution requires a non-empty string `command` argument',
      }),
      timedOut: false,
    };
  }

  // Construct NullSecurityProvider for postExecute audit chain parity (Story 3.3 AC5)
  const security: ISecurityProvider = options.security ?? new NullSecurityProvider({
    logger: {
      warn: (msg: string) => options.audit('security.fallback', { reason: msg, tool: tc.name }),
    },
  });

  // Effective timeout: tc.arguments.timeout ?? default ?? 30s, clamped to >=5s
  const requestedTimeout = typeof tc.arguments.timeout === 'number'
    ? tc.arguments.timeout
    : options.subSandboxConfig?.defaultTimeoutMs ?? 30_000;
  const effectiveTimeout = Math.max(
    HIGHRISK_MIN_TIMEOUT_MS,
    Math.min(requestedTimeout, options.subSandboxConfig?.maxTimeoutMs ?? 300_000),
  );

  const start = Date.now();
  let sandboxId: string | undefined;
  try {
    // AC5: create() may throw ISOLATED_CONCURRENCY_LIMIT — surface as structured error
    using subSandbox = options.subSandboxManager.create();
    sandboxId = subSandbox.sandboxId;
    options.audit('isolated.dispatch', {
      tool: tc.name,
      sandboxId,
      sessionId: options.sessionId,
      timeoutMs: effectiveTimeout,
      commandLength: command.length,
    });

    const isolated = await subSandbox.executeIsolated(command, {
      cwd: typeof tc.arguments.cwd === 'string' ? tc.arguments.cwd : undefined,
      env: tc.arguments.env && typeof tc.arguments.env === 'object'
        ? tc.arguments.env as Record<string, string>
        : undefined,
      stdin: typeof tc.arguments.stdin === 'string' ? tc.arguments.stdin : undefined,
      timeout: effectiveTimeout,
      onAudit: (action, detail) => options.audit(action, { ...detail, tool: tc.name }),
    });

    const elapsed = Date.now() - start;
    // AC2: timedOut → ISOLATED_TIMEOUT structured response
    if (isolated.timedOut) {
      options.emit?.('tool.timeout', { toolCallId: tc.id, elapsed });
      await security.postExecute(tc.name, {
        success: false,
        output: 'isolated execution timed out',
        sessionId: options.sessionId,
      }).catch(() => {});
      const timeoutSeconds = Math.round(effectiveTimeout / 1000);
      return {
        result: JSON.stringify({
          code: 'ISOLATED_TIMEOUT',
          message: `isolated execution timed out after ${timeoutSeconds}s`,
          sandboxId,
          exitCode: isolated.exitCode,
          killed: isolated.killed,
        }),
        timedOut: true,
      };
    }

    // Map isolated result to ShellResult-compatible JSON so callers
    // (provider/AI) get a uniform shape regardless of execution path.
    const payload = {
      exitCode: isolated.exitCode,
      stdout: isolated.stdout,
      stderr: isolated.stderr,
      killed: isolated.killed,
      truncated: { stdout: false, stderr: false },
      isolated: true,
      sandboxId,
    };
    await security.postExecute(tc.name, {
      success: isolated.exitCode === 0,
      output: isolated.stdout,
      sessionId: options.sessionId,
    }).catch(() => {});
    return { result: JSON.stringify(payload), timedOut: false };
  } catch (err) {
    const elapsed = Date.now() - start;
    const code = (err as { code?: string })?.code;
    const message = err instanceof Error ? err.message : String(err);

    // AC4: RESOURCE_INSUFFICIENT → structured error
    if (code === 'RESOURCE_INSUFFICIENT') {
      await security.postExecute(tc.name, {
        success: false,
        output: 'resource insufficient',
        sessionId: options.sessionId,
      }).catch(() => {});
      return {
        result: JSON.stringify({
          code: 'RESOURCE_INSUFFICIENT',
          message: 'insufficient memory for isolated execution',
          sandboxId,
        }),
        timedOut: false,
      };
    }

    // AC5: ISOLATED_CONCURRENCY_LIMIT → structured error (does not block other tools)
    if (code === 'ISOLATED_CONCURRENCY_LIMIT') {
      options.emit?.('tool.concurrency_limited', { toolCallId: tc.id, elapsed });
      await security.postExecute(tc.name, {
        success: false,
        output: 'concurrency limit reached',
        sessionId: options.sessionId,
      }).catch(() => {});
      return {
        result: JSON.stringify({
          code: 'ISOLATED_CONCURRENCY_LIMIT',
          message,
          sandboxId,
        }),
        timedOut: false,
      };
    }

    // ISOLATED_UNAVAILABLE → bwrap missing/non-Linux
    if (code === 'ISOLATED_UNAVAILABLE') {
      await security.postExecute(tc.name, {
        success: false,
        output: 'isolated sandbox unavailable',
        sessionId: options.sessionId,
      }).catch(() => {});
      return {
        result: JSON.stringify({
          code: 'ISOLATED_UNAVAILABLE',
          message,
          sandboxId,
        }),
        timedOut: false,
      };
    }

    // Unexpected error — propagate as generic message so AI can react
    await security.postExecute(tc.name, {
      success: false,
      sessionId: options.sessionId,
    }).catch(() => {});
    return {
      result: JSON.stringify({
        code: code ?? 'TOOLS_EXECUTION_FAILED',
        message,
        sandboxId,
      }),
      timedOut: false,
    };
  }
}
