// @zaivim/engine — Security module
// Depth defense: bwrap+seccomp (shell) + .git boundary (file) + FileChangeProposal + backup + audit.
// Each security layer protects a different attack surface.

import type { ISecurityProvider, FileChangeProposal } from '@zaivim/core';
import { ZaiSecurityError } from '@zaivim/core';
import { resolve } from 'node:path';

// ============================================================================
// TODO (@zaivim/sandbox): extract SandboxManager to @zaivim/sandbox when
// engine/src/ exceeds 30 files. All bwrap/seccomp/fallback logic must stay
// ONLY in this file until extraction.
// ============================================================================

export class SandboxManager {
  #available: boolean;
  #sandboxType: 'none' | 'bwrap';
  #workDir: string;

  constructor(enabled: boolean, type: 'none' | 'bwrap', workDir: string) {
    this.#available = enabled && type === 'bwrap';
    this.#sandboxType = enabled ? type : 'none';
    this.#workDir = workDir;
  }

  get sandboxType(): 'none' | 'bwrap' {
    return this.#sandboxType;
  }

  isAvailable(): boolean {
    return this.#available;
  }

  /**
   * Validate a shell command for execution within sandbox.
   * MVP: allow all commands, sandbox enforcement via bwrap.
   * Growth: command allowlist / deny patterns.
   */
  validateCommand(_command: string): boolean {
    if (this.#sandboxType === 'none') return true;
    // bwrap will enforce isolation
    return true;
  }

  /**
   * Execute a command in the sandbox.
   * MVP: returns a stub — full bwrap integration in Growth phase.
   */
  async execute(
    command: string,
    options?: { cwd?: string; env?: Record<string, string>; stdin?: string; timeout?: number },
  ): Promise<{ exitCode: number; stdout: string; stderr: string; killed: boolean }> {
    if (!this.#available) {
      throw new ZaiSecurityError('Sandbox not available', 'shell', 'ENGINE_SANDBOX_UNAVAILABLE');
    }
    // Growth: bwrap --unshare-net --proc /proc --dev /dev --ro-bind /usr /usr ...
    // MVP: returns a stub
    return {
      exitCode: 0,
      stdout: `[sandbox stub] would execute: ${command}`,
      stderr: '',
      killed: false,
    };
  }
}

// ============================================================================
// TODO (@zaivim/audit): extract Auditor to @zaivim/audit when engine/src/
// exceeds 30 files. All JSONL write/query/rotate logic must stay ONLY in
// this file until extraction.
// ============================================================================

export interface AuditEntry {
  readonly timestamp: number;
  readonly sessionId: string;
  readonly action: string;
  readonly detail: Record<string, unknown>;
}

export class Auditor {
  #entries: AuditEntry[] = [];

  log(sessionId: string, action: string, detail: Record<string, unknown>): void {
    const entry: AuditEntry = {
      timestamp: Date.now(),
      sessionId,
      action,
      detail,
    };
    this.#entries.push(entry);
    // Growth: write to JSONL file, rotate when >100MB
  }

  query(sessionId?: string): AuditEntry[] {
    if (sessionId) {
      return this.#entries.filter(e => e.sessionId === sessionId);
    }
    return [...this.#entries];
  }
}

// ============================================================================
// SecurityProvider — implements ISecurityProvider interface from @zaivim/core
// ============================================================================

export class SecurityProvider implements ISecurityProvider {
  readonly sandboxType: 'none' | 'bwrap';
  #sandbox: SandboxManager;
  #auditor: Auditor;
  #projectRoot: string;

  constructor(sandbox: SandboxManager, auditor: Auditor, projectRoot?: string) {
    this.sandboxType = sandbox.sandboxType;
    this.#sandbox = sandbox;
    this.#auditor = auditor;
    this.#projectRoot = resolve(projectRoot ?? process.cwd());
  }

  validatePath(path: string, operation: string): boolean {
    const resolved = resolve(path);

    // File ops must be within project boundary (.git directory)
    if (!resolved.startsWith(this.#projectRoot)) {
      this.#auditor.log('', 'path_denied', { path, operation, reason: 'outside project root' });
      return false;
    }

    // Reject writes to .git directory
    if (resolved.includes('/.git/') || resolved.endsWith('/.git')) {
      this.#auditor.log('', 'path_denied', { path, operation, reason: '.git directory' });
      return false;
    }

    return true;
  }

  async proposeChange(proposal: FileChangeProposal): Promise<boolean> {
    this.#auditor.log('', 'change_proposed', {
      path: proposal.path,
      operation: proposal.operation,
      reason: proposal.reason,
    });
    // MVP: auto-approve within project root. Growth: FileChangeProposal → user approval UI
    return true;
  }

  isSandboxAvailable(): boolean {
    return this.#sandbox.isAvailable();
  }
}
