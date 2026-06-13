// @zaivim/tools — Shell command execution tool
// Story 3.2a: shell_execute — safe shell command execution via ctx.exec injection.
// All sandbox isolation (bwrap+seccomp), output truncation, progress notification,
// and cascade termination are handled inside the engine-injected ctx.exec closure.
// The tool layer owns: parameter validation, env filtering, and cwd boundary check.

import type { ToolDefinition, ToolContext, ShellParams, ShellResult } from '@zaivim/core';

// ─── Constants ─────────────────────────────────────────────────────────────────

const MAX_COMMAND_LENGTH = 10_000;
const MAX_STDIN_BYTES = 1 * 1024 * 1024;      // 1MB
const MAX_TIMEOUT_MS = 300_000;                // 300s
const MIN_TIMEOUT_MS = 1;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_ENV_KEYS = 50;
const MAX_ENV_VALUE_LENGTH = 4096;

/** Dynamic linker variables blocked for security (Red Team – AC11) */
const BLOCKED_ENV = new Set([
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_DEBUG',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
]);

/** Whitelisted PATH directories inside sandbox */
const ALLOWED_PATH_DIRS = new Set(['/usr/bin', '/bin', '/usr/local/bin']);

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** Strip zero-width characters from a string (NFC-normalized prior). */
function stripZeroWidth(s: string): string {
  return s.replace(/[​-‍﻿]/g, '');
}

/** Build a safe environment object, stripping blocked keys and filtering PATH. */
function filterEnv(
  rawEnv: Record<string, string> | undefined,
): { safeEnv: Record<string, string>; strippedKeys: string[] } {
  const strippedKeys: string[] = [];
  if (!rawEnv) return { safeEnv: {}, strippedKeys };

  const safeEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawEnv)) {
    if (BLOCKED_ENV.has(k)) {
      strippedKeys.push(k);
      continue;
    }
    if (v.length > MAX_ENV_VALUE_LENGTH) {
      throw new Error(`TOOLS_INPUT_TOO_LARGE: env value for key "${k}" exceeds ${MAX_ENV_VALUE_LENGTH} chars`);
    }
    if (k === 'PATH') {
      safeEnv[k] = v
        .split(':')
        .filter(p => ALLOWED_PATH_DIRS.has(p))
        .join(':');
      continue;
    }
    safeEnv[k] = v;
  }
  return { safeEnv, strippedKeys };
}

/** Build a quick-rejection ShellResult for validation failures. */
function rejectedResult(reason: string, code: string): ShellResult {
  return {
    exitCode: -1,
    stdout: '',
    stderr: `${code}: ${reason}`,
    killed: false,
    truncated: { stdout: false, stderr: false },
    rejected: true,
    rejectionReason: reason,
  };
}

// ─── Tool Definition ──────────────────────────────────────────────────────────

export const shellTool: ToolDefinition<ShellParams, ShellResult> = {
  name: 'shell_execute',
  description:
    'Execute a shell command in a security sandbox. Commands run with network disabled by default.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to execute' },
      cwd: { type: 'string', description: 'Working directory inside the sandbox' },
      env: { type: 'object', description: 'Environment variables to pass to the command' },
      stdin: { type: 'string', description: 'Standard input to pipe to the command' },
      timeout: { type: 'number', description: 'Timeout in milliseconds (default 30000, max 300000)' },
    },
    required: ['command'],
  },
  harmLevel: 'B',
  requiresApproval: false,
  requireSandbox: true,

  async execute(params: ShellParams, ctx: ToolContext): Promise<ShellResult> {
    // ── Layer 1: Parameter validation (tool-layer responsibility — ADR-SHELL-2) ──

    // 1a. command: NFC normalize + strip zero-width chars + length cap (AC13)
    const command = stripZeroWidth(params.command.normalize('NFC'));
    if (command.length > MAX_COMMAND_LENGTH) {
      return rejectedResult(
        `command exceeds ${MAX_COMMAND_LENGTH} chars`,
        'TOOLS_INPUT_TOO_LARGE',
      );
    }

    // 1b. stdin: size cap (AC13) — only validate when provided
    if (params.stdin != null && Buffer.byteLength(params.stdin, 'utf-8') > MAX_STDIN_BYTES) {
      return rejectedResult(
        'stdin exceeds 1MB',
        'TOOLS_INPUT_TOO_LARGE',
      );
    }

    // 1c. timeout: cap + default (AC13)
    const timeout =
      params.timeout != null && params.timeout >= MIN_TIMEOUT_MS
        ? Math.min(params.timeout, MAX_TIMEOUT_MS)
        : DEFAULT_TIMEOUT_MS;

    // 1d. env: key count + value length caps (AC13)
    const envEntries = params.env ? Object.entries(params.env) : [];
    if (envEntries.length > MAX_ENV_KEYS) {
      return rejectedResult(
        `env exceeds ${MAX_ENV_KEYS} keys`,
        'TOOLS_INPUT_TOO_LARGE',
      );
    }

    // 1e. env: security filtering — strip blocked linker vars, whitelist PATH (AC11)
    let safeEnv: Record<string, string>;
    let strippedKeys: string[];
    try {
      ({ safeEnv, strippedKeys } = filterEnv(params.env));
    } catch (e) {
      return rejectedResult(
        e instanceof Error ? e.message : 'env validation failed',
        'TOOLS_INPUT_TOO_LARGE',
      );
    }
    if (strippedKeys.length > 0) {
      ctx.audit('shell.env_stripped', { command: params.command, keys: strippedKeys });
    }

    // 1f. cwd: boundary validation via ISecurityProvider (AC12)
    // HACK: using openFile('read') for cwd boundary validation — semantically imprecise.
    // TODO(Story-3.3): extend ISecurityProvider with validatePath(path): Promise<string>
    const cwd = params.cwd ?? ctx.lastCwd ?? process.cwd();
    try {
      await ctx.security.openFile(cwd, 'read');
    } catch {
      return rejectedResult(
        'cwd outside project boundary',
        'TOOLS_SECURITY_BLOCKED',
      );
    }

    // ── Layer 2: Sandbox availability gate (engine pre-validated — ADR-SHELL-2) ──
    if (!ctx.exec) {
      return rejectedResult(
        'shell execution requires sandbox',
        'SANDBOX_UNAVAILABLE',
      );
    }

    // ── Layer 3: Execute via engine-injected closure ──────────────────────────
    // ctx.exec internally handles: output truncation, progress notification,
    // cascade termination on abort, and audit logging of the execution itself.
    const result = await ctx.exec(
      {
        command,
        cwd,
        env: Object.keys(safeEnv).length > 0 ? safeEnv : undefined,
        stdin: params.stdin || undefined,
        timeout,
      },
      ctx.signal,
    );

    // exitCode is transparently passed through — AI decides what it means (AC8)
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      killed: result.killed,
      truncated: result.truncated,
    };
  },
};
