// @zaivim/engine — NullSecurityProvider
// Fallback security provider for platforms without bwrap support.
// Used when graceful degradation is required (macOS, Windows).

import { resolve } from 'node:path';
import type {
  ISecurityProvider,
  SecurityDecision,
  SecurityStatus,
  FileChangeProposal,
  HarmLevel,
  SafeFileHandle,
  WriteApproval,
} from '@zaivim/core';

/**
 * NullSecurityProvider — Fallback security provider for non-Linux platforms
 *
 * WARNING: This implementation provides NO sandbox enforcement.
 * All operations are allowed by default. Use only when bwrap is unavailable.
 * See BwrapSecurityProvider for actual sandbox enforcement.
 */
export class NullSecurityProvider implements ISecurityProvider {
  readonly sandboxType: 'none' | 'bwrap' = 'none';
  #platform: 'linux' | 'macos' | 'windows' | 'unknown' = 'unknown';

  constructor() {
    this.#detectPlatform();
  }

  #detectPlatform(): void {
    const platform = process.platform;
    if (platform === 'linux') this.#platform = 'linux';
    else if (platform === 'darwin') this.#platform = 'macos';
    else if (platform === 'win32') this.#platform = 'windows';
    else this.#platform = 'unknown';
  }

  /**
   * Pre-execution check — ALWAYS allows operations (MVP placeholder)
   *
   * WARNING: No actual security checks performed.
   * All operations return allowed=true with C-level harm.
   */
  async preExecute(
    operation: string,
    _params: Record<string, unknown>,
  ): Promise<SecurityDecision> {
    // Null provider: Allow all operations without classification
    console.warn(`[NullSecurityProvider] Pre-execution check for ${operation} — ALLOWED (no enforcement)`);
    return {
      allowed: true,
      harmLevel: 'C',
      reason: 'NullSecurityProvider allows all operations (MVP placeholder)',
    };
  }

  /**
   * Post-execution logging — logs to console only
   *
   * Note: NullSecurityProvider uses console logging.
   * Use AuditLogger for persistent JSONL audit logging.
   */
  async postExecute(
    operation: string,
    result: { success: boolean; output?: string },
  ): Promise<void> {
    console.log(`[NullSecurityProvider] Post-execution: ${operation} — ${result.success ? 'SUCCESS' : 'FAILED'}`);
    if (result.output) {
      console.log(`[NullSecurityProvider] Output: ${result.output.substring(0, 200)}${result.output.length > 200 ? '...' : ''}`);
    }
  }

  /**
   * Get security status for user display
   */
  getStatus(): SecurityStatus {
    return {
      sandboxMode: 'null',
      platform: this.#platform,
      filesystemRestricted: false,
      networkIsolated: false,
      auditLogPath: 'none',
      isOperational: false,
      details: [
        'NullSecurityProvider — NO ENFORCEMENT',
        'All operations are allowed without security checks',
        'Use BwrapSecurityProvider for actual sandbox protection',
      ],
    };
  }

  /**
   * Sandbox availability — always false for null provider
   */
  isSandboxAvailable(): boolean {
    return false;
  }

  /**
   * Legacy path validation — always allows
   * @deprecated Use preExecute() instead
   */
  validatePath(_path: string, _operation: string): boolean {
    console.warn('[NullSecurityProvider] validatePath called — always returns true (no enforcement)');
    return true;
  }

  /**
   * Legacy change proposal — always approves
   * @deprecated Use preExecute() instead
   */
  async proposeChange(_proposal: FileChangeProposal): Promise<boolean> {
    console.warn('[NullSecurityProvider] proposeChange called — always returns true (no approval flow)');
    return true;
  }

  /**
   * Open a file — no validation (null security, allows all).
   * Story 3.1 interface conformance.
   */
  async openFile(path: string, operation: 'read'): Promise<SafeFileHandle>;
  async openFile(path: string, operation: 'write' | 'delete'): Promise<WriteApproval>;
  async openFile(path: string, operation: 'read' | 'write' | 'delete'): Promise<SafeFileHandle | WriteApproval> {
    console.warn(`[NullSecurityProvider] openFile('${path}', '${operation}') — no path validation (null security)`);
    const resolvedPath = resolve(path);

    if (operation === 'read') {
      const { readFile } = await import('node:fs/promises');
      return {
        validatedPath: resolvedPath,
        async read(encoding?: BufferEncoding): Promise<string> {
          return readFile(resolvedPath, { encoding }) as Promise<string>;
        },
        async close(): Promise<void> { /* no-op */ },
      } satisfies SafeFileHandle;
    }

    return {
      validatedPath: resolvedPath,
      resolvedPath,
    } satisfies WriteApproval;
  }
}
