// @zaivim/engine — NullSecurityProvider
// Fallback when E2 security module is not loaded.
// All operations pass through with warning logging.

import type { ISecurityProvider, FileChangeProposal } from '@zaivim/core';

export class NullSecurityProvider implements ISecurityProvider {
  readonly sandboxType = 'none' as const;
  readonly #log: (msg: string) => void;

  constructor(log?: (msg: string) => void) {
    this.#log = log ?? (() => {});
    this.#log(JSON.stringify({ type: 'security.fallback', reason: 'security module not loaded' }));
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
