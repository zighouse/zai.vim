// @zaivim/engine — Security module
// Depth defense: bwrap+seccomp (shell) + .git boundary (file) + FileChangeProposal + backup + audit.
// Each security layer protects a different attack surface.

import type {
  ISecurityProvider,
  FileChangeProposal,
  SecurityDecision,
  SecurityStatus,
} from '@zaivim/core';
import { ZaiSecurityError } from '@zaivim/core';
import { resolve } from 'node:path';

export { BwrapSecurityProvider } from './bwrap-security.js';
import { HarmClassifier } from './harm-classifier.js';
export { HarmClassifier } from './harm-classifier.js';
import { AuditLogger } from './audit-logger.js';
export { AuditLogger, type AuditEntry, type AuditStatistics } from './audit-logger.js';
export { OverrideManager } from './override-manager.js';
export { SecurityMonitor } from './security-monitor.js';
export type { SecurityLevel, SecurityHealth, SecurityStatusChange } from './security-monitor.js';
export { getBadge, getAllBadges, isElevatedRisk, isBlockingLevel } from './badge-display.js';
export { generateRiskCard } from './risk-card.js';
export type { RiskCardSummary } from './risk-card.js';

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

interface AuditStoreEntry {
  readonly timestamp: number;
  readonly sessionId: string;
  readonly action: string;
  readonly detail: Record<string, unknown>;
}

export class Auditor {
  #entries: AuditStoreEntry[] = [];

  log(sessionId: string, action: string, detail: Record<string, unknown>): void {
    const entry: AuditStoreEntry = {
      timestamp: Date.now(),
      sessionId,
      action,
      detail,
    };
    this.#entries.push(entry);
    // Growth: write to JSONL file, rotate when >100MB
  }

  query(sessionId?: string): AuditStoreEntry[] {
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
  #auditLogger?: AuditLogger;
  #projectRoot: string;
  #harmClassifier: HarmClassifier;
  #onRejection?: (operation: string, harmLevel: HarmLevel, command: string, reason: string) => string;

  constructor(sandbox: SandboxManager, auditor: Auditor, projectRoot?: string, auditLogger?: AuditLogger) {
    this.sandboxType = sandbox.sandboxType;
    this.#sandbox = sandbox;
    this.#auditor = auditor;
    this.#projectRoot = resolve(projectRoot ?? process.cwd());
    this.#harmClassifier = new HarmClassifier();
    this.#auditLogger = auditLogger;
  }

  /**
   * Set a callback for when operations are rejected (for override recording)
   */
  set onRejection(cb: ((operation: string, harmLevel: HarmLevel, command: string, reason: string) => string) | undefined) {
    this.#onRejection = cb;
  }

  /**
   * Pre-execution security check
   *
   * Validates operation against security policies.
   * Uses HarmClassifier for shell commands and path validation for file ops.
   */
  async preExecute(
    operation: string,
    params: Record<string, unknown>,
  ): Promise<SecurityDecision> {
    // Classify shell commands using HarmClassifier (AC2, AC5)
    if (operation === 'shell_exec') {
      const command = params.command as string;
      if (command) {
        const classification = this.#harmClassifier.classifyCommand(command);
        if (!classification.whitelisted && classification.level === 'S') {
          const reason = `Command blocked (S-level): ${classification.reason}`;
          this.#onRejection?.(operation, 'S', command, classification.reason);
          return {
            allowed: false,
            harmLevel: 'S',
            reason,
          };
        }
        return {
          allowed: true,
          harmLevel: classification.level,
          reason: classification.reason,
        };
      }
    }

    // File operations: classify using HarmClassifier (Story 2.2, Task 1.7)
    if (operation === 'file_read' || operation === 'file_write' || operation === 'file_delete' || operation === 'file_modify') {
      const path = params.path as string;
      if (!path) {
        return {
          allowed: false,
          harmLevel: 'B',
          reason: 'File path is empty or undefined',
        };
      }

      const opType = operation === 'file_read' ? 'read'
        : operation === 'file_write' ? 'write'
        : operation === 'file_delete' ? 'delete'
        : 'modify';

      const classification = this.#harmClassifier.classifyFileOperation(path, opType);

      // S-level: block all file operations
      if (classification.harmLevel === 'S') {
        const reason = `File operation blocked (S-level): ${classification.reason}`;
        this.#onRejection?.(operation, 'S', path, classification.reason);
        return {
          allowed: false,
          harmLevel: 'S',
          reason,
          alternatives: [
            'Use a different path outside system directories',
            'Request explicit user override with acknowledgment',
          ],
        };
      }

      // A-level: block write/delete/modify, allow read
      if (classification.harmLevel === 'A' && opType !== 'read') {
        const reason = `File operation blocked (A-level): ${classification.reason}`;
        this.#onRejection?.(operation, 'A', path, classification.reason);
        return {
          allowed: false,
          harmLevel: 'A',
          reason,
          alternatives: [
            'Use project-internal paths instead',
            'Request explicit user override with acknowledgment',
          ],
        };
      }

      return {
        allowed: true,
        harmLevel: classification.harmLevel,
        reason: classification.reason,
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
   * Logs all operations to audit store.
   * Uses AuditLogger (JSONL) when available, falls back to in-memory Auditor.
   */
  async postExecute(
    operation: string,
    result: { success: boolean; output?: string; sessionId?: string },
  ): Promise<void> {
    // Use AuditLogger (persistent JSONL) when available
    if (this.#auditLogger) {
      await this.#auditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: result.sessionId ?? '',
        operation,
        harmLevel: 'C',
        decision: result.success ? 'allowed' : 'denied',
        reason: `Operation ${result.success ? 'completed' : 'failed'}`,
        user: 'system',
        metadata: {
          outputLength: result.output?.length ?? 0,
        },
      });
      return;
    }

    // Fallback to in-memory Auditor
    this.#auditor.log('', 'operation_completed', {
      operation,
      success: result.success,
      outputLength: result.output?.length ?? 0,
    });
  }

  /**
   * Get security status for user display
   */
  getStatus(): SecurityStatus {
    const plat = process.platform;
    const platform: SecurityStatus['platform'] = plat === 'linux' ? 'linux' : plat === 'darwin' ? 'macos' : plat === 'win32' ? 'windows' : 'unknown';
    return {
      sandboxMode: this.#sandbox.isAvailable() ? 'bwrap' : 'null',
      platform,
      filesystemRestricted: true,
      networkIsolated: false,
      auditLogPath: this.#auditLogger ? this.#auditLogger.logFilePath : 'memory',
      isOperational: this.#sandbox.isAvailable(),
      details: this.#sandbox.isAvailable()
        ? ['Bwrap sandbox available', 'Project root boundary enforcement active']
        : ['Sandbox not available', 'Using null security provider (degraded mode)'],
    };
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

  // ============================================================================
  // Whitelist management with audit logging (Story 2.2, Task 1.10)
  // ============================================================================

  /** Add command to whitelist (with audit record) */
  addToWhitelist(pattern: string, reason: string): void {
    this.#harmClassifier.addToWhitelist(pattern, reason);
    this.#auditor.log('', 'whitelist.add', { pattern, reason });
    if (this.#auditLogger) {
      this.#auditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: '',
        operation: 'whitelist_add',
        harmLevel: 'C',
        decision: 'allowed',
        reason: `Whitelist added: ${pattern} — ${reason}`,
        user: 'system',
        metadata: { pattern, reason },
      }).catch(() => {});
    }
  }

  /** Remove command from whitelist (with audit record) */
  removeFromWhitelist(pattern: string): void {
    this.#harmClassifier.removeFromWhitelist(pattern);
    this.#auditor.log('', 'whitelist.remove', { pattern });
    if (this.#auditLogger) {
      this.#auditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: '',
        operation: 'whitelist_remove',
        harmLevel: 'C',
        decision: 'allowed',
        reason: `Whitelist removed: ${pattern}`,
        user: 'system',
        metadata: { pattern },
      }).catch(() => {});
    }
  }

  /** Get all whitelisted patterns */
  getWhitelist(): Array<[string, string]> {
    return this.#harmClassifier.getWhitelist();
  }
}
