// @zaivim/engine — NullSecurityProvider
// Fallback when E2 security module is not loaded.
// All operations pass through with warning logging.

import type { ISecurityProvider, FileChangeProposal, SecurityDecision, SecurityStatus } from '@zaivim/core';

export class NullSecurityProvider implements ISecurityProvider {
  readonly sandboxType = 'none' as const;
  readonly #log: (msg: string) => void;

  constructor(log?: (msg: string) => void) {
    this.#log = log ?? (() => {});
    this.#log(JSON.stringify({ type: 'security.fallback', reason: 'security module not loaded' }));
  }

  async preExecute(_operation: string, _params: Record<string, unknown>): Promise<SecurityDecision> {
    this.#log(JSON.stringify({ type: 'security.pre_execute', allowed: true }));
    return { allowed: true, harmLevel: 'C', reason: 'Null security — all operations allowed' };
  }

  async postExecute(_operation: string, _result: { success: boolean; output?: string; sessionId?: string }): Promise<void> {
    // no-op
  }

  getStatus(): SecurityStatus {
    let platform: 'linux' | 'macos' | 'windows' | 'unknown' = 'unknown';
    const p = process.platform;
    if (p === 'linux') platform = 'linux';
    else if (p === 'darwin') platform = 'macos';
    else if (p === 'win32') platform = 'windows';
    return {
      sandboxMode: 'null',
      platform,
      filesystemRestricted: false,
      networkIsolated: false,
      auditLogPath: 'none',
      isOperational: false,
      details: ['Null security provider — all operations allowed'],
    };
  }

  validatePath(_path: string, _operation: string): boolean {
    return true;
  }

  async proposeChange(_proposal: FileChangeProposal): Promise<boolean> {
    return true;
  }

  isSandboxAvailable(): boolean {
    return false;
  }
}
