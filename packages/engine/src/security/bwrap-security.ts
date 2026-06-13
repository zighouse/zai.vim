// @zaivim/engine — BwrapSecurityProvider
// Linux bwrap sandbox implementation with graceful degradation.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { platform } from 'node:os';
import { resolve } from 'node:path';
import type {
  ISecurityProvider,
  SecurityDecision,
  SecurityStatus,
  FileChangeProposal,
  SafeFileHandle,
  WriteApproval,
} from '@zaivim/core';
import { HarmClassifier } from './harm-classifier.js';
import { validatePathSafe, SealedFileHandle } from './path-validator.js';

/**
 * Platform detection result
 */
type Platform = 'linux' | 'macos' | 'windows' | 'unknown';

/**
 * BwrapSecurityProvider — Linux bwrap sandbox implementation
 *
 * Provides actual sandbox enforcement on Linux using bubblewrap (bwrap).
 * Gracefully degrades on macOS/Windows with clear status reporting.
 */
export class BwrapSecurityProvider implements ISecurityProvider {
  readonly sandboxType: 'none' | 'bwrap' = 'bwrap';
  #platform: Platform;
  #bwrapAvailable: boolean;
  #bwrapPath: string = '';
  #workspaceDir: string;
  #auditLogPath: string;
  #harmClassifier: HarmClassifier;

  constructor(workspaceDir: string, auditLogPath: string) {
    this.#platform = this.#detectPlatform();
    this.#workspaceDir = resolve(workspaceDir);
    this.#auditLogPath = resolve(auditLogPath);
    this.#bwrapAvailable = this.#checkBwrapAvailable();
    this.#harmClassifier = new HarmClassifier();
  }

  #detectPlatform(): Platform {
    const sysPlatform = platform();
    if (sysPlatform === 'linux') return 'linux';
    if (sysPlatform === 'darwin') return 'macos';
    if (sysPlatform === 'win32') return 'windows';
    return 'unknown';
  }

  #checkBwrapAvailable(): boolean {
    if (this.#platform !== 'linux') {
      return false;
    }
    // Check if bwrap executable exists
    try {
      if (existsSync('/usr/bin/bwrap')) {
        this.#bwrapPath = '/usr/bin/bwrap';
        return true;
      }
      if (existsSync('/bin/bwrap')) {
        this.#bwrapPath = '/bin/bwrap';
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Pre-execution security check
   *
   * On Linux with bwrap: Validates command using HarmClassifier, blocks S-level
   * On other platforms: Returns degraded decision with actual harm level reported
   */
  async preExecute(
    operation: string,
    params: Record<string, unknown>,
  ): Promise<SecurityDecision> {
    // Classify shell commands using HarmClassifier
    if (operation === 'shell_exec') {
      const command = params.command as string;
      if (!command) {
        return {
          allowed: false,
          harmLevel: 'B',
          reason: 'Shell command is empty or undefined',
        };
      }

      const classification = this.#harmClassifier.classifyCommand(command);

      // Degraded mode: allow but report actual harm level
      if (!this.#bwrapAvailable) {
        return {
          allowed: true,
          harmLevel: classification.level,
          reason: `Sandbox not available on ${this.#platform} — degraded mode (classified: ${classification.level})`,
          alternatives: this.#platform === 'linux'
            ? ['Install bwrap: apt install bubblewrap', 'Use NullSecurityProvider with warnings']
            : this.#platform === 'macos'
              ? ['Use NullSecurityProvider', 'Consider Linux environment for full security']
              : ['Use WSL2 with bwrap', 'Use NullSecurityProvider'],
        };
      }

      // Bwrap mode: block S-level (non-whitelisted) commands
      if (!classification.whitelisted && classification.level === 'S') {
        return {
          allowed: false,
          harmLevel: 'S',
          reason: `Command blocked (S-level): ${classification.reason}`,
          alternatives: [
            'Use safer command with specific target',
            'Request explicit user override with acknowledgment',
            classification.whitelistReason
              ? `Whitelist this command: ${classification.whitelistReason}`
              : undefined,
          ].filter(Boolean) as string[],
        };
      }

      return {
        allowed: true,
        harmLevel: classification.level,
        reason: classification.whitelisted
          ? `Command allowed (whitelisted): ${classification.reason}`
          : `Command validated, harm level: ${classification.level}`,
      };
    }

    return {
      allowed: true,
      harmLevel: 'C',
      reason: 'Operation within security boundaries',
    };
  }

  /**
   * Post-execution audit logging
   *
   * Logs to JSONL audit file (async, non-blocking).
   * Note: Use AuditLogger for persistent JSONL audit logging.
   */
  async postExecute(
    operation: string,
    result: { success: boolean; output?: string; sessionId?: string },
  ): Promise<void> {
    const logEntry = {
      timestamp: new Date().toISOString(),
      operation,
      success: result.success,
      outputLength: result.output?.length ?? 0,
    };

    console.log(`[BwrapSecurityProvider] Audit: ${JSON.stringify(logEntry)}`);
  }

  /**
   * Get security status for user display
   */
  getStatus(): SecurityStatus {
    const isOperational = this.#bwrapAvailable && this.#platform === 'linux';

    return {
      sandboxMode: this.#bwrapAvailable ? 'bwrap' : 'degraded',
      platform: this.#platform,
      filesystemRestricted: this.#bwrapAvailable,
      networkIsolated: this.#bwrapAvailable,
      auditLogPath: this.#auditLogPath,
      isOperational,
      details: this.#bwrapAvailable
        ? [
            'Bwrap sandbox active',
            `Workspace: ${this.#workspaceDir}`,
            'Filesystem isolation: enabled',
            'Network isolation: enabled (network=none)',
          ]
        : [
            `Sandbox not available on ${this.#platform}`,
            'Using degraded security mode',
            'All operations allowed without enforcement',
            this.#platform === 'linux'
              ? 'Install bwrap: apt install bubblewrap'
              : 'Consider Linux environment for full security',
          ],
    };
  }

  /**
   * Sandbox availability check
   */
  isSandboxAvailable(): boolean {
    return this.#bwrapAvailable;
  }

  /**
   * Execute command in bwrap sandbox
   *
   * Constructs bwrap command with proper isolation:
   * - Readonly bind mounts for system directories
   * - Writable mount for workspace directory
   * - Network isolation (unshare-net)
   * - Die with parent process
   *
   * @param command - Shell command to execute
   * @param options - Execution options (cwd, env, stdin, timeout)
   * @returns Execution result with exit code, stdout, stderr
   */
  async executeInSandbox(
    command: string,
    options?: { cwd?: string; env?: Record<string, string>; stdin?: string; timeout?: number },
  ): Promise<{ exitCode: number; stdout: string; stderr: string; killed: boolean }> {
    if (!this.#bwrapAvailable) {
      throw new Error(`Bwrap not available on ${this.#platform}`);
    }

    const cwd = options?.cwd ?? this.#workspaceDir;
    const timeout = options?.timeout ?? 30000; // 30s default timeout

    // Validate stdin size before spawning (M1)
    if (options?.stdin && options.stdin.length > 1024 * 1024) {
      return Promise.resolve({
        exitCode: -1,
        stdout: '',
        stderr: 'Bwrap error: stdin exceeds maximum size (1MB)',
        killed: false,
      });
    }

    // Construct bwrap command
    const bwrapArgs = this.#buildBwrapArgs(cwd);

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let killed = false;

      const child = spawn(this.#bwrapPath, [...bwrapArgs, '/bin/sh', '-c', command], {
        cwd,
        env: options?.env ?? process.env,
        timeout,
      });

      child.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      // Handle timeout
      const timer = setTimeout(() => {
        killed = true;
        child.kill('SIGTERM');
        // Give graceful shutdown a chance, then force kill
        setTimeout(() => child.kill('SIGKILL'), 5000);
      }, timeout);

      child.on('close', (exitCode) => {
        clearTimeout(timer);
        resolve({ exitCode: exitCode ?? -1, stdout, stderr, killed });
      });

      child.on('error', (error) => {
        clearTimeout(timer);
        stderr += `Bwrap error: ${error.message}`;
        resolve({ exitCode: -1, stdout, stderr, killed: false });
      });

      // Write stdin if provided
      if (options?.stdin) {
        child.stdin?.write(options.stdin);
        child.stdin?.end();
      }
    });
  }

  /**
   * Build bwrap command arguments for proper isolation
   *
   * Constructs bwrap arguments following security best practices:
   * - Readonly system directories
   * - Writable workspace mount
   * - Device access
   * - Network isolation
   * - Process isolation
   */
  #buildBwrapArgs(workspace: string): string[] {
    const args: string[] = [];

    // Readonly bind mounts for system directories
    args.push('--ro-bind', '/usr', '/usr');
    args.push('--ro-bind', '/lib', '/lib');
    args.push('--ro-bind', '/lib64', '/lib64');
    args.push('--ro-bind', '/bin', '/bin');
    args.push('--ro-bind', '/sbin', '/sbin');

    // Device access (minimal)
    args.push('--dev', '/dev');
    args.push('--dev-bind', '/dev/null', '/dev/null');
    args.push('--dev-bind', '/dev/zero', '/dev/zero');
    args.push('--dev-bind', '/dev/random', '/dev/random');
    args.push('--dev-bind', '/dev/urandom', '/dev/urandom');

    // Writable workspace directory
    args.push('--bind', workspace, workspace);

    // Network isolation
    args.push('--unshare-net');

    // Process isolation
    args.push('--unshare-all');
    args.push('--die-with-parent');

    // Proc filesystem
    args.push('--proc', '/proc');

    return args;
  }

  /**
   * Legacy path validation
   * @deprecated Use preExecute() instead
   */
  validatePath(path: string, operation: string): boolean {
    const resolved = resolve(path);

    // Basic safety checks
    if (resolved.includes('/.git/') || resolved.endsWith('/.git')) {
      return false;
    }

    // Additional checks could be added here
    return true;
  }

  /**
   * Legacy change proposal
   * @deprecated Use preExecute() instead
   */
  async proposeChange(proposal: FileChangeProposal): Promise<boolean> {
    // MVP: Allow changes within workspace
    // Growth: Implement approval flow
    const resolvedPath = resolve(proposal.path);

    if (!resolvedPath.startsWith(this.#workspaceDir)) {
      return false;
    }

    return true;
  }

  /**
   * Open a file with TOCTOU-safe path validation (Story 3.1, C3).
   *
   * Delegates to validatePathSafe (Story 2.4) for full protection:
   * Unicode normalization, confusable/bidi detection, realpath boundary
   * check, /proc/self/fd cross-verification, timing side-channel padding.
   */
  async openFile(path: string, operation: 'read'): Promise<SafeFileHandle>;
  async openFile(path: string, operation: 'write' | 'delete'): Promise<WriteApproval>;
  async openFile(path: string, operation: 'read' | 'write' | 'delete'): Promise<SafeFileHandle | WriteApproval> {
    const result = await validatePathSafe(path, this.#workspaceDir, operation);

    if (result instanceof SealedFileHandle) {
      return {
        validatedPath: result.validatedPath,
        async read(encoding?: BufferEncoding): Promise<string> {
          return result.read(encoding);
        },
        async close(): Promise<void> {
          await result.close();
        },
      } satisfies SafeFileHandle;
    }

    if (!result.valid) {
      throw Object.assign(
        new Error('access denied'),
        { code: 'TOOLS_SECURITY_BLOCKED', reason: result.code },
      );
    }

    return {
      validatedPath: result.resolvedPath,
      resolvedPath: result.resolvedPath,
    } satisfies WriteApproval;
  }
}
