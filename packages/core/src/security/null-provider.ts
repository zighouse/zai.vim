// =============================================================================
// @zaivim/core — NullSecurityProvider
// Story 3.3 (AC5): Fallback provider used when the E2 security module is not
// injected. Lets tools execute in degraded environments (tests, sandboxless
// platforms) while loudly logging that no sandbox enforcement is active.
// =============================================================================

import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import type {
  ISecurityProvider,
  SecurityDecision,
  SecurityStatus,
  FileChangeProposal,
  SafeFileHandle,
  WriteApproval,
  FileOperation,
} from '../types/security.js';

/**
 * Logger sink for NullSecurityProvider warnings.
 *
 * Every preExecute / openFile call emits a warning to make security degradation
 * visible (pre-mortem: "NullSecurityProvider 静默通过导致安全降级不可见").
 * When `logger` is omitted the provider falls back to `console.warn`.
 */
export interface NullSecurityProviderOptions {
  readonly logger?: { warn(msg: string): void };
}

const FALLBACK_WARNING =
  'security: NullSecurityProvider fallback in use — E2 not injected';

function detectPlatform(): 'linux' | 'macos' | 'windows' | 'unknown' {
  const p = process.platform;
  if (p === 'linux') return 'linux';
  if (p === 'darwin') return 'macos';
  if (p === 'win32') return 'windows';
  return 'unknown';
}

/**
 * NullSecurityProvider — implements the full ISecurityProvider contract.
 *
 * File reads remain functional (realpath normalization + fs.promises.readFile
 * backed SafeFileHandle) so that `file_read` works in E2-degraded scenarios.
 * Writes/deletes pass through with a warning — they are NOT sandboxed.
 */
export class NullSecurityProvider implements ISecurityProvider {
  readonly sandboxType = 'none' as const;
  readonly #logger: { warn(msg: string): void };

  constructor(options: NullSecurityProviderOptions = {}) {
    this.#logger = options.logger ?? console;
  }

  #warn(message: string): void {
    try {
      this.#logger.warn(message);
    } catch {
      // Logger may throw in constrained environments; never let it bubble up.
    }
  }

  async preExecute(
    _operation: string,
    _params: Record<string, unknown>,
  ): Promise<SecurityDecision> {
    this.#warn(FALLBACK_WARNING);
    return {
      allowed: true,
      harmLevel: 'C',
      reason: 'NullSecurityProvider: security not injected (E2 degraded), passthrough',
    };
  }

  async postExecute(
    operation: string,
    result: { success: boolean; output?: string; sessionId?: string },
  ): Promise<void> {
    this.#warn(
      `security: NullSecurityProvider postExecute ${operation} — ${result.success ? 'success' : 'failure'} (E2 not injected)`,
    );
  }

  getStatus(): SecurityStatus {
    return {
      sandboxMode: 'null',
      platform: detectPlatform(),
      filesystemRestricted: false,
      networkIsolated: false,
      auditLogPath: '',
      isOperational: false,
      details: ['NullSecurityProvider in use — E2 not injected'],
    };
  }

  isSandboxAvailable(): boolean {
    return false;
  }

  async openFile(path: string, operation: 'read'): Promise<SafeFileHandle>;
  async openFile(path: string, operation: 'write' | 'delete'): Promise<WriteApproval>;
  async openFile(
    path: string,
    operation: FileOperation,
  ): Promise<SafeFileHandle | WriteApproval> {
    this.#warn(FALLBACK_WARNING);

    let resolvedPath: string;
    try {
      // Best-effort realpath normalization for the directory. For reads the
      // file must exist; for writes/deletes only the parent directory must.
      resolvedPath = realpathSync.native(resolve(path));
    } catch {
      // Path doesn't exist yet (e.g. new file) — fall back to resolve() and
      // surface that validation was skipped.
      this.#warn('security: NullSecurityProvider openFile — path validation skipped (realpath failed)');
      resolvedPath = resolve(path);
    }

    if (operation === 'read') {
      this.#warn('security: NullSecurityProvider openFile read — path validation skipped');
      const target = resolvedPath;
      return {
        validatedPath: target,
        async read(encoding?: BufferEncoding): Promise<string> {
          const { readFile } = await import('node:fs/promises');
          return readFile(target, { encoding }) as Promise<string>;
        },
        async close(): Promise<void> {
          // No descriptor to release — fs.promises.readFile closes implicitly.
        },
      } satisfies SafeFileHandle;
    }

    const dir = resolve(path);
    return {
      validatedPath: dir,
      resolvedPath: dir,
    } satisfies WriteApproval;
  }

  /** @deprecated Use preExecute() instead */
  validatePath(_path: string, _operation: string): boolean {
    this.#warn(FALLBACK_WARNING);
    return true;
  }

  /** @deprecated Use preExecute() instead */
  async proposeChange(_proposal: FileChangeProposal): Promise<boolean> {
    this.#warn(FALLBACK_WARNING);
    return Promise.resolve(true);
  }
}
