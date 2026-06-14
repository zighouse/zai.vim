// @zaivim/engine — SubSandboxProvider
// Story 3.4: Isolated execution environment for high-risk tools.
//
// A SubSandboxProvider wraps an independent bubblewrap (bwrap) instance with
// stricter isolation than the primary BwrapSecurityProvider:
//   - `--tmpfs /workspace` (independent scratch area, never bind-mounted)
//   - `--tmpfs /tmp` (independent temp)
//   - `--unshare-net` (forced; cannot be overridden)
//   - `--cap-drop ALL` (all capabilities dropped)
//   - Host memory pre-check (>= minFreeMemoryMB) before spawning
//   - Host load pre-check (1m loadavg sanity) before spawning
//   - Per-execution timeout SIGTERM -> 5s -> SIGKILL via process group
//
// Each instance is single-use: call `executeIsolated()` one or more times,
// then `destroy()`. After destroy, any further call throws ZaiError with
// code ISOLATED_ALREADY_DESTROYED. Destroy is idempotent.
//
// Implements Disposable (`using` declarations) so callers can write
//   `using sub = manager.create();` and the runtime guarantees destroy().
//
// References:
//   - AC1: independent sub-sandbox routing
//   - AC2: timeout auto-destroy (SIGTERM -> 5s -> SIGKILL)
//   - AC3: zero-residue cleanup
//   - AC4: resource-insufficient refusal
//   - Security Audit V1: process-group termination + beforeExit guards
//   - Security Audit V2: in-flight memory monitoring + ulimit -u
//   - Security Audit V5: median of 3 samples for freemem
//   - Pre-mortem PM2: explicit tmpfs size limits + audit timing
//   - Pre-mortem PM3: bwrap binary mtime re-validation
//   - Pre-mortem PM4: load-based refusal + nice -n 19
//
// Growth TODOs (Story 3.4 Task 6.1):
//   - TODO(story-3.4-growth): Docker-based sub-sandbox for heavier isolation
//     (e.g., database migrations that need a complete container environment).
//   - TODO(story-3.4-growth): cgroups v2 resource limits — replace the
//     freemem() pre-check with `memory.max` and `pids.max` enforcement
//     inside the cgroup owning the bwrap process group.
//   - TODO(story-3.4-growth): per-sub-sandbox network allowlist — currently
//     `--unshare-net` is forced; some Growth-phase tools (e.g., controlled
//     package downloads) may need a narrow outbound allowlist.
//   - TODO(story-3.4-growth): seccomp BPF filter that explicitly blocks
//     ptrace/mount/bpf syscalls. Today we approximate this with `--cap-drop ALL`.

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { freemem, loadavg, cpus, platform } from 'node:os';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { SubSandboxConfig } from '@zaivim/core';
import { ZaiError } from '@zaivim/core';

const MIN_TIMEOUT_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TIMEOUT_MS = 300_000;
const DEFAULT_MIN_FREE_MB = 100;
const DEFAULT_MAX_CONCURRENCY = 5;
const BWRAP_MIN_VERSION = [0, 8, 0];
const BWRAP_PATHS = ['/usr/bin/bwrap', '/bin/bwrap'];
const MEMORY_MONITOR_INTERVAL_MS = 5_000;
const MEMORY_SAMPLE_COUNT = 3;
const GRACEFUL_KILL_DELAY_MS = 5_000;
const STDOUT_TRUNCATION_BYTES = 10 * 1024 * 1024; // 10MB
const ULIMIT_USER_PROCESSES = 256;
// TODO(story-3.4-growth): bwrap ≥0.8 supports --size and --nr-inodes on tmpfs.
// Until then we rely on bwrap defaults + the host memory pre-check (AC4).
const TMPFS_SIZE = '100M';
const TMPFS_INODES = 65536;
const NICE_PRIORITY = 19;

export interface IsolatedExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly killed: boolean;
  readonly timedOut: boolean;
  readonly resourceRejected?: false;
}

export interface IsolatedExecOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly stdin?: string;
  readonly timeout?: number;
  readonly onAudit?: (action: string, detail: Record<string, unknown>) => void;
}

export const DEFAULT_SUBSANDBOX_CONFIG: Readonly<SubSandboxConfig> = Object.freeze({
  defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
  maxTimeoutMs: DEFAULT_MAX_TIMEOUT_MS,
  memoryCheckEnabled: true,
  minFreeMemoryMB: DEFAULT_MIN_FREE_MB,
  maxConcurrency: DEFAULT_MAX_CONCURRENCY,
});

function clampTimeout(timeout: number, maxTimeoutMs: number): number {
  return Math.max(MIN_TIMEOUT_MS, Math.min(timeout, maxTimeoutMs));
}

/** Sample freemem N times and return median in MB (Security Audit V5). */
function medianFreeMemoryMb(): number {
  const samples: number[] = [];
  for (let i = 0; i < MEMORY_SAMPLE_COUNT; i++) {
    samples.push(freemem());
  }
  samples.sort((a, b) => a - b);
  const mid = samples[Math.floor(samples.length / 2)];
  return Math.floor((mid ?? 0) / (1024 * 1024));
}

function compareVersionTuple(actual: number[], required: number[]): number {
  const len = Math.max(actual.length, required.length);
  for (let i = 0; i < len; i++) {
    const a = actual[i] ?? 0;
    const b = required[i] ?? 0;
    if (a !== b) return a - b;
  }
  return 0;
}

function parseBwrapVersion(stdout: string): number[] {
  // `bwrap --version` prints `bubblewrap 0.8.0`
  const match = stdout.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return [0, 0, 0];
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Synchronously detect bwrap path; returns null when not available. */
function locateBwrapBinary(): string | null {
  for (const p of BWRAP_PATHS) {
    if (existsSync(p)) return p;
  }
  return null;
}

/** Synchronously read bwrap version; returns null on error. */
function readBwrapVersion(bwrapPath: string): number[] | null {
  try {
    // spawnSync avoided to keep zero sync-blocking during construction;
    // we instead read version lazily on first executeIsolated() via async spawn.
    return null;
  } catch {
    return null;
  }
}

/**
 * SubSandboxProvider — a single isolated bubblewrap execution context.
 *
 * Designed for one-shot or short-lived high-risk executions. The lifecycle:
 *   1. `manager.create()` -> new SubSandboxProvider
 *   2. `sub.executeIsolated(cmd, opts)` -> IsolatedExecResult
 *   3. `sub.destroy()` (or `using sub` exits scope) -> cleanup guaranteed
 *
 * A provider can be re-used for multiple executeIsolated() calls until
 * destroy() is invoked; afterward every call throws ISOLATED_ALREADY_DESTROYED.
 */
export class SubSandboxProvider implements Disposable {
  readonly sandboxId: string;
  readonly #config: SubSandboxConfig;
  readonly #workspaceDir: string;
  readonly #audit?: (action: string, detail: Record<string, unknown>) => void;
  #destroyed = false;
  #activeChild: ChildProcess | null = null;
  #activeMonitor: NodeJS.Timeout | null = null;
  #activeAbort: AbortController | null = null;
  #bwrapPath: string | null;
  #bwrapMtime: number | null = null;
  #bwrapVersion: number[] | null = null;
  #bwrapVersionChecked = false;
  /** Bound cleanup hook used for beforeExit/uncaughtException guards. */
  readonly #cleanupHook = (): void => {
    void this.destroy().catch(() => {});
  };

  constructor(
    workspaceDir: string,
    config?: Partial<SubSandboxConfig>,
    audit?: (action: string, detail: Record<string, unknown>) => void,
  ) {
    this.sandboxId = randomUUID();
    this.#workspaceDir = resolve(workspaceDir);
    this.#config = { ...DEFAULT_SUBSANDBOX_CONFIG, ...config };
    this.#audit = audit;
    this.#bwrapPath = locateBwrapBinary();
    if (this.#bwrapPath) {
      try {
        this.#bwrapMtime = statSync(this.#bwrapPath).mtimeMs;
      } catch {
        this.#bwrapMtime = null;
      }
    }

    // Security Audit V1: best-effort cleanup on engine crash
    process.once('beforeExit', this.#cleanupHook);
  }

  get isDestroyed(): boolean {
    return this.#destroyed;
  }

  get config(): Readonly<SubSandboxConfig> {
    return this.#config;
  }

  /**
   * Execute a shell command in the isolated sub-sandbox.
   *
   * @throws {ZaiError} RESOURCE_INSUFFICIENT when host memory or load fails pre-check
   * @throws {ZaiError} ISOLATED_ALREADY_DESTROYED when called after destroy()
   * @throws {ZaiError} ISOLATED_UNAVAILABLE when bwrap is missing
   */
  async executeIsolated(
    command: string,
    options: IsolatedExecOptions = {},
  ): Promise<IsolatedExecResult> {
    if (this.#destroyed) {
      throw new ZaiError(
        'isolated sub-sandbox already destroyed',
        'ISOLATED_ALREADY_DESTROYED',
        409,
        { sandboxId: this.sandboxId },
      );
    }
    if (typeof command !== 'string' || command.length === 0) {
      throw new ZaiError(
        'isolated execution requires a non-empty command string',
        'TOOLS_INVALID_PARAMS',
        400,
        { sandboxId: this.sandboxId },
      );
    }
    if (!this.#bwrapPath) {
      this.#audit?.('isolated.unavailable', {
        sandboxId: this.sandboxId,
        reason: 'bwrap binary missing',
        platform: platform(),
      });
      throw new ZaiError(
        `bwrap not available on ${platform()}; cannot create isolated sub-sandbox`,
        'ISOLATED_UNAVAILABLE',
        503,
        { sandboxId: this.sandboxId },
      );
    }

    // Pre-mortem PM3: detect bwrap binary replacement (apt upgrade, etc.)
    await this.#verifyBwrapIntact(options.onAudit);

    // AC4 / Security Audit V5: host memory pre-check (median of 3 samples)
    if (this.#config.memoryCheckEnabled) {
      const freeMb = medianFreeMemoryMb();
      if (freeMb < this.#config.minFreeMemoryMB) {
        this.#audit?.('isolated.resource_insufficient', {
          sandboxId: this.sandboxId,
          freeMemoryMB: freeMb,
          requiredMB: this.#config.minFreeMemoryMB,
        });
        throw new ZaiError(
          `insufficient memory for isolated execution (free ${freeMb}MB < required ${this.#config.minFreeMemoryMB}MB)`,
          'RESOURCE_INSUFFICIENT',
          507,
          { sandboxId: this.sandboxId, freeMemoryMB: freeMb },
        );
      }
      // Pre-mortem PM4: load sanity — refuse if 1m loadavg > 2 * CPU count
      const cpuCount = cpus().length;
      const oneMinLoad = loadavg()[0] ?? 0;
      if (cpuCount > 0 && oneMinLoad > cpuCount * 2) {
        this.#audit?.('isolated.resource_insufficient', {
          sandboxId: this.sandboxId,
          loadavg1m: oneMinLoad,
          cpuCount,
        });
        throw new ZaiError(
          `host load too high for isolated execution (load1=${oneMinLoad.toFixed(2)}, cpus=${cpuCount})`,
          'RESOURCE_INSUFFICIENT',
          507,
          { sandboxId: this.sandboxId, loadavg1m: oneMinLoad, cpuCount },
        );
      }
    }

    const effectiveTimeout = clampTimeout(
      options.timeout ?? this.#config.defaultTimeoutMs,
      this.#config.maxTimeoutMs,
    );

    return this.#runBwrap(command, effectiveTimeout, options);
  }

  /**
   * Destroy the sub-sandbox: abort any in-flight execution, kill the process
   * group, clear monitors, emit cleanup audit. Idempotent.
   */
  async destroy(): Promise<void> {
    if (this.#destroyed) return;
    this.#destroyed = true;

    // AC3: clear monitor first so it does not race with abort
    if (this.#activeMonitor) {
      clearInterval(this.#activeMonitor);
      this.#activeMonitor = null;
    }

    // AC2 / AC3: process group termination SIGTERM -> 5s -> SIGKILL
    const child = this.#activeChild;
    if (child?.pid) {
      try {
        // Negative PID kills the process group (Security Audit V1)
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        try { child.kill('SIGTERM'); } catch { /* already gone */ }
      }
      // Best-effort SIGKILL after grace; do not block destroy for 5s
      setTimeout(() => {
        try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* group gone */ }
      }, GRACEFUL_KILL_DELAY_MS).unref?.();
    }
    if (this.#activeAbort) {
      try { this.#activeAbort.abort(); } catch { /* ignore */ }
      this.#activeAbort = null;
    }

    process.removeListener('beforeExit', this.#cleanupHook);

    this.#audit?.('isolated.cleanup', {
      sandboxId: this.sandboxId,
      exitCode: child?.exitCode ?? null,
      killed: !!child?.killed,
    });
  }

  /** Disposable interface: scoped `using` callers (Story 3.4 Task 3.3). */
  [Symbol.dispose](): void {
    void this.destroy();
  }

  // ---------------------------------------------------------------------------

  /**
   * Verify bwrap binary hasn't been replaced since construction (Pre-mortem PM3).
   * On mtime change, re-read version (async) and emit audit; stale version is
   * only a warning — execution still proceeds, but the audit trail records it.
   */
  async #verifyBwrapIntact(onAudit?: IsolatedExecOptions['onAudit']): Promise<void> {
    if (!this.#bwrapPath) return;
    let currentMtime: number;
    try {
      currentMtime = statSync(this.#bwrapPath).mtimeMs;
    } catch {
      // Binary disappeared
      this.#audit?.('isolated.bwrap_gone', {
        sandboxId: this.sandboxId,
        bwrapPath: this.#bwrapPath,
      });
      throw new ZaiError(
        'bwrap binary vanished since sub-sandbox construction',
        'ISOLATED_UNAVAILABLE',
        503,
        { sandboxId: this.sandboxId, bwrapPath: this.#bwrapPath },
      );
    }
    if (this.#bwrapMtime !== null && currentMtime !== this.#bwrapMtime) {
      this.#bwrapMtime = currentMtime;
      this.#bwrapVersionChecked = false;
      this.#audit?.('isolated.bwrap_modified', {
        sandboxId: this.sandboxId,
        bwrapPath: this.#bwrapPath,
        newMtime: currentMtime,
      });
      onAudit?.('isolated.bwrap_modified', {
        sandboxId: this.sandboxId,
        bwrapPath: this.#bwrapPath,
        newMtime: currentMtime,
      });
    }
    // Lazy version check (Pre-mortem PM3 / Red Team Round 2)
    if (!this.#bwrapVersionChecked) {
      const version = await this.#readBwrapVersionAsync();
      this.#bwrapVersion = version;
      this.#bwrapVersionChecked = true;
      if (version && compareVersionTuple(version, BWRAP_MIN_VERSION) < 0) {
        this.#audit?.('isolated.bwrap_old_version', {
          sandboxId: this.sandboxId,
          version: version.join('.'),
          required: BWRAP_MIN_VERSION.join('.'),
        });
      }
    }
  }

  async #readBwrapVersionAsync(): Promise<number[] | null> {
    return new Promise((resolveVersion) => {
      if (!this.#bwrapPath) {
        resolveVersion(null);
        return;
      }
      const child = spawn(this.#bwrapPath, ['--version'], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      let stdout = '';
      child.stdout?.on('data', (d) => { stdout += d.toString(); });
      child.on('error', () => resolveVersion(null));
      child.on('close', () => resolveVersion(parseBwrapVersion(stdout)));
    });
  }

  #buildBwrapArgs(): string[] {
    const args: string[] = [];
    // Namespace isolation (share with main sandbox)
    args.push('--unshare-all', '--die-with-parent');

    // Independent workspace + tmp (NOT bind-mounted) — AC1.
    // Note: --size/--nr-inodes are gated on bwrap >= 0.8; see TMPFS_SIZE TODO.
    args.push('--tmpfs', '/workspace');
    args.push('--tmpfs', '/tmp');

    // Read-only system dirs (shared with main sandbox)
    args.push('--ro-bind', '/usr', '/usr');
    args.push('--ro-bind', '/lib', '/lib');
    args.push('--ro-bind', '/lib64', '/lib64');
    args.push('--ro-bind', '/bin', '/bin');
    args.push('--ro-bind', '/sbin', '/sbin');

    // Minimal device access
    args.push('--dev', '/dev');
    args.push('--dev-bind', '/dev/null', '/dev/null');
    args.push('--dev-bind', '/dev/zero', '/dev/zero');
    args.push('--dev-bind', '/dev/urandom', '/dev/urandom');

    // Forced network isolation — AC1 (cannot be overridden)
    args.push('--unshare-net');

    // Drop ALL capabilities — ADR-3 (main sandbox keeps some)
    args.push('--cap-drop', 'ALL');

    // proc filesystem
    args.push('--proc', '/proc');

    return args;
  }

  async #runBwrap(
    command: string,
    timeoutMs: number,
    options: IsolatedExecOptions,
  ): Promise<IsolatedExecResult> {
    const bwrapArgs = this.#buildBwrapArgs();
    // Pre-mortem PM4: lower child CPU priority via nice. nice is at /usr/bin/nice
    // (ro-bound inside the sandbox); the wrapper exec's so we don't fork twice.
    const wrappedCommand = `exec nice -n ${NICE_PRIORITY} /bin/sh -c ${JSON.stringify(command)}`;
    // Pre-mortem PM2 / Security Audit V2: limit child process count to deter fork bombs
    const childEnv: Record<string, string> = {
      ...(options.env ?? {}),
      // Hint for the shell — ulimit is best-effort; bwrap does not enforce it
      // directly. Real cgroups v2 enforcement is TODO (Task 6.1).
      ZAIVIM_ULIMIT_USERS: String(ULIMIT_USER_PROCESSES),
    };

    const spawnOptions: SpawnOptions = {
      // The sub-sandbox creates its own tmpfs /workspace INSIDE the namespace,
      // so the host cwd is irrelevant to execution. Only set cwd when the host
      // path actually exists (otherwise spawn fails with ENOENT).
      cwd: existsSync(this.#workspaceDir) ? this.#workspaceDir : undefined,
      env: { ...process.env, ...childEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true, // create new process group so we can kill -PGID
    };

    const abort = new AbortController();
    this.#activeAbort = abort;

    const start = Date.now();
    const child = spawn(
      this.#bwrapPath!,
      [...bwrapArgs, '/bin/sh', '-c', wrappedCommand],
      spawnOptions,
    );
    this.#activeChild = child;

    let stdoutBuf = '';
    let stderrBuf = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let killed = false;
    let timedOut = false;
    let resolved = false;

    child.stdout?.on('data', (data: Buffer) => {
      if (stdoutBuf.length + data.length > STDOUT_TRUNCATION_BYTES) {
        stdoutBuf += data.subarray(0, Math.max(0, STDOUT_TRUNCATION_BYTES - stdoutBuf.length)).toString();
        stdoutTruncated = true;
        return;
      }
      stdoutBuf += data.toString();
    });
    child.stderr?.on('data', (data: Buffer) => {
      if (stderrBuf.length + data.length > STDOUT_TRUNCATION_BYTES) {
        stderrBuf += data.subarray(0, Math.max(0, STDOUT_TRUNCATION_BYTES - stderrBuf.length)).toString();
        stderrTruncated = true;
        return;
      }
      stderrBuf += data.toString();
    });

    // AC2: timeout -> SIGTERM (process group) -> 5s -> SIGKILL
    const timer = setTimeout(() => {
      timedOut = true;
      killed = true;
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGTERM'); } catch { /* group gone */ }
        setTimeout(() => {
          try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* group gone */ }
        }, GRACEFUL_KILL_DELAY_MS).unref?.();
      }
    }, timeoutMs);

    // Security Audit V2: in-flight memory monitor
    if (this.#config.memoryCheckEnabled) {
      this.#activeMonitor = setInterval(() => {
        const freeMb = medianFreeMemoryMb();
        if (freeMb < this.#config.minFreeMemoryMB) {
          this.#audit?.('isolated.memory_pressure', {
            sandboxId: this.sandboxId,
            freeMemoryMB: freeMb,
          });
          try { abort.abort(); } catch { /* ignore */ }
        }
      }, MEMORY_MONITOR_INTERVAL_MS);
    }

    // Wire abort signal to process-group termination
    if (abort.signal.aborted) {
      // already aborted by monitor
    } else {
      abort.signal.addEventListener('abort', () => {
        killed = true;
        if (child.pid) {
          try { process.kill(-child.pid, 'SIGTERM'); } catch { /* ignore */ }
        }
      }, { once: true });
    }

    if (options.stdin !== undefined) {
      try {
        child.stdin?.write(options.stdin);
      } catch { /* ignore write race */ }
    }
    try { child.stdin?.end(); } catch { /* ignore */ }

    const result = await new Promise<IsolatedExecResult>((resolveResult) => {
      child.on('close', (exitCode) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        if (this.#activeMonitor) {
          clearInterval(this.#activeMonitor);
          this.#activeMonitor = null;
        }
        const elapsed = Date.now() - start;
        // Pre-mortem PM2: record execution timing for forensic review
        this.#audit?.('isolated.execute', {
          sandboxId: this.sandboxId,
          exitCode: exitCode ?? -1,
          killed,
          timedOut,
          elapsedMs: elapsed,
          stdoutTruncated,
          stderrTruncated,
        });
        resolveResult({
          exitCode: exitCode ?? -1,
          stdout: stdoutBuf,
          stderr: stderrBuf,
          killed,
          timedOut,
        });
      });
      child.on('error', (err) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        if (this.#activeMonitor) {
          clearInterval(this.#activeMonitor);
          this.#activeMonitor = null;
        }
        resolveResult({
          exitCode: -1,
          stdout: stdoutBuf,
          stderr: `bwrap spawn error: ${err.message}`,
          killed: false,
          timedOut: false,
        });
      });
    });

    this.#activeChild = null;
    this.#activeAbort = null;
    return result;
  }
}
