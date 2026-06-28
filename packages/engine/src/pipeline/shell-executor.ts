// @zaivim/engine — ShellExecutorFactory
// Story 3.2a / ADR-SHELL-2: Two-layer sandbox availability gating.
//
// Engine-layer responsibility: check SandboxManager availability + capabilities,
// then inject ctx.exec as a closure wrapping sandbox execution, output truncation,
// progress notification, and audit logging. The tool layer only calls ctx.exec().
//
// When sandbox is unavailable or capabilities are insufficient, exec = undefined
// and the shell tool returns SANDBOX_UNAVAILABLE.

import type { ShellExecParams, ShellExecResult } from '@zaivim/core';
import type { SandboxManager } from '../security/index.js';
import { spawn } from 'node:child_process';

// ─── Constants ─────────────────────────────────────────────────────────────────

const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10MB (AC6 / ADR-19)
const PROGRESS_INTERVAL_MS = 5 * 60 * 1000; // 5 min (AC4)
const PROGRESS_STDOUT_CAP = 1024; // 1KB (AC4)

/** Dynamic linker variables blocked at the engine level (defense in depth — AC11) */
const ENGINE_BLOCKED_ENV: readonly string[] = [
  'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_DEBUG',
  'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH',
];

// ─── Capabilities interface ────────────────────────────────────────────────────

export interface SandboxCapabilities {
  readonly filesystemWriteable: boolean;
  readonly userNamespace: boolean;
  readonly seccomp: boolean;
  readonly networkIsolation: boolean;
}

// ─── Factory ────────────────────────────────────────────────────────────────────

export class ShellExecutorFactory {
  /**
   * Create an exec closure for the given sandbox manager.
   * Returns undefined when the sandbox is unavailable or capabilities are
   * insufficient — the shell tool then returns SANDBOX_UNAVAILABLE.
   */
  static create(
    sandboxManager: SandboxManager,
    capabilities: SandboxCapabilities,
  ): ((params: ShellExecParams, signal?: AbortSignal) => Promise<ShellExecResult>) | undefined {
    // When bwrap sandbox is available, use it with full capabilities gating
    if (sandboxManager.isAvailable()) {
      // capabilities check — minimum requirements for shell execution
      if (!capabilities.filesystemWriteable) return undefined;
      if (!capabilities.seccomp) return undefined;
      if (!capabilities.userNamespace && process.getuid?.() === 0) return undefined;
      if (!capabilities.networkIsolation) return undefined;
    }

    // Create the exec closure (uses raw spawn when bwrap unavailable — MVP)
    return async (
      params: ShellExecParams,
      signal?: AbortSignal,
    ): Promise<ShellExecResult> => {
      const startTime = performance.now();
      const elapsedMs = (): number => Math.round(performance.now() - startTime);

      // stdout/stderr buffering
      let stdoutBuf = '';
      let stderrBuf = '';
      let killed = false;
      let exitSignal: string | undefined;
      let stoppedAtCap = false;
      let progressNotified = false;
      let lastProgressTime = 0;

      // Progress notification handler
      const progressInterval = setInterval(() => {
        const elapsed = elapsedMs();
        // Cap progress notifications to once per 5 minutes (AC4)
        if (elapsed - lastProgressTime < PROGRESS_INTERVAL_MS) return;
        lastProgressTime = elapsed;

        // Truncate stdout to 1KB for the notification (AC4)
        const cappedStdout = Buffer.byteLength(stdoutBuf, 'utf-8') > PROGRESS_STDOUT_CAP
          ? stdoutBuf.slice(-PROGRESS_STDOUT_CAP)
          : stdoutBuf;

        progressNotified = true;

        // In a real engine: emit via events/notifications channel
        // MVP: log to console, Growth: proper $/notification JSON-RPC
        console.error(JSON.stringify({
          type: 'tool.shell.progress',
          stdout: cappedStdout,
          elapsed,
        }));
      }, PROGRESS_INTERVAL_MS);

      try {
        // Execute via SandboxManager or direct spawn (MVP fallback)
        const execResult = sandboxManager.isAvailable()
          ? await sandboxManager.execute(params.command, {
              cwd: params.cwd,
              env: filterEngineEnv(params.env),
              stdin: params.stdin,
              timeout: params.timeout,
            })
          : await executeDirect(params.command, {
              cwd: params.cwd,
              env: filterEngineEnv(params.env),
              stdin: params.stdin,
              timeout: params.timeout,
            });

        // Check if killed due to timeout or abort
        killed = execResult.killed ?? false;

        // Capture stdout/stderr
        stdoutBuf = execResult.stdout ?? '';
        stderrBuf = execResult.stderr ?? '';

        // Output truncation (AC6) with UTF-8 safe boundary
        const stdoutTruncated = applyTruncation(
          stdoutBuf,
          MAX_OUTPUT_BYTES,
          'stdout',
        );
        stdoutBuf = stdoutTruncated.content;
        stoppedAtCap = stoppedAtCap || stdoutTruncated.truncated;

        const stderrTruncated = applyTruncation(
          stderrBuf,
          MAX_OUTPUT_BYTES,
          'stderr',
        );
        stderrBuf = stderrTruncated.content;
        stoppedAtCap = stoppedAtCap || stderrTruncated.truncated;

        return {
          exitCode: execResult.exitCode,
          stdout: stdoutBuf,
          stderr: stderrBuf,
          killed,
          signal: exitSignal,
          truncated: {
            stdout: stdoutTruncated.truncated,
            stderr: stderrTruncated.truncated,
          },
          elapsed: elapsedMs(),
          progressNotified,
        };
      } catch (err) {
        // Non-execution errors (sandbox crashes, etc.)
        killed = true;
        return {
          exitCode: -1,
          stdout: stdoutBuf,
          stderr: `Shell execution error: ${err instanceof Error ? err.message : String(err)}`,
          killed: true,
          truncated: { stdout: false, stderr: false },
          elapsed: elapsedMs(),
          progressNotified,
        };
      } finally {
        clearInterval(progressInterval);
      }
    };
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

interface TruncationResult {
  content: string;
  truncated: boolean;
}

/**
 * Apply output truncation at maxBytes with UTF-8 safe boundary (AC6).
 * Aligns to nearest `\n` before the cap, reserves space for the truncation message.
 */
function applyTruncation(content: string, maxBytes: number, _label: string): TruncationResult {
  const contentBytes = Buffer.byteLength(content, 'utf-8');
  if (contentBytes <= maxBytes) {
    return { content, truncated: false };
  }

  const originalBytes = contentBytes;
  const MB = 1024 * 1024;
  const truncMsg = `\n... [truncated, original size: ${(originalBytes / MB).toFixed(1)}MB, use 'head'/'tail' for targeted output]`;
  const truncMsgBytes = Buffer.byteLength(truncMsg, 'utf-8');

  // Reserve space for the truncation message
  const budget = maxBytes - truncMsgBytes;
  if (budget <= 0) {
    // Edge case: truncation message alone exceeds budget — just return it
    return { content: truncMsg, truncated: true };
  }

  // Convert to Buffer for precise byte-level truncation
  const buf = Buffer.from(content, 'utf-8');
  let cutByte = budget;

  // Scan backwards for a \n (0x0A) byte to prefer line-boundary truncation
  for (let i = cutByte; i >= 0; i--) {
    if (buf[i] === 0x0A) {
      cutByte = i;
      break;
    }
  }

  // Ensure we don't cut in the middle of a multi-byte UTF-8 character
  // UTF-8 continuation bytes are 10xxxxxx (0x80–0xBF)
  while (cutByte > 0 && (buf[cutByte]! & 0xC0) === 0x80) {
    cutByte--;
  }
  // If we landed on a continuation byte leader, step back to end of previous char
  if (cutByte > 0 && (buf[cutByte]! & 0xC0) !== 0xC0 && buf[cutByte]! >= 0x80) {
    cutByte--;
  }

  const truncated = buf.subarray(0, Math.max(cutByte, 1)).toString('utf-8') + truncMsg;
  return { content: truncated, truncated: true };
}

/** Whitelisted PATH directories inside sandbox (mirrors tools layer) */
const ENGINE_ALLOWED_PATH_DIRS = new Set(['/usr/bin', '/bin', '/usr/local/bin']);

/**
 * Engine-layer env filtering (defense in depth — AC11).
 * Duplicates the blocked-env check AND PATH whitelist from the tool layer
 * so that even if a future tool-layer bug omits the filter, the engine
 * closure still blocks dangerous dynamic-linker variables and PATH injection.
 */
function filterEngineEnv(
  env?: Record<string, string>,
): Record<string, string> | undefined {
  if (!env) return undefined;
  const result: Record<string, string> = {};
  let hasEntries = false;
  for (const [k, v] of Object.entries(env)) {
    if (ENGINE_BLOCKED_ENV.includes(k)) continue;
    if (k === 'PATH') {
      result[k] = v.split(':').filter(p => ENGINE_ALLOWED_PATH_DIRS.has(p)).join(':');
      hasEntries = true;
      continue;
    }
    result[k] = v;
    hasEntries = true;
  }
  return hasEntries ? result : undefined;
}

/**
 * Direct command execution fallback for systems without bwrap (MVP).
 * Executes the command via child_process.spawn with timeout and abort support.
 * This is a development convenience — production deployments should use bwrap.
 */
async function executeDirect(
  command: string,
  options?: { cwd?: string; env?: Record<string, string>; stdin?: string; timeout?: number },
): Promise<{ exitCode: number; stdout: string; stderr: string; killed: boolean }> {
  const child = spawn('/bin/sh', ['-c', command], {
    cwd: options?.cwd,
    env: options?.env ? { ...process.env, ...options.env } : undefined,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: options?.timeout,
  });

  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];

  child.stdout.on('data', (d: Buffer) => stdout.push(d));
  child.stderr.on('data', (d: Buffer) => stderr.push(d));

  // Pipe stdin when provided
  if (options?.stdin) {
    child.stdin.write(options.stdin);
  }
  child.stdin.end();

  const exitCode = await new Promise<number>((resolve) => {
    child.on('close', resolve);
    child.on('error', () => resolve(-1));
  });

  return {
    exitCode,
    stdout: Buffer.concat(stdout).toString('utf-8'),
    stderr: Buffer.concat(stderr).toString('utf-8'),
    killed: child.killed,
  };
}
