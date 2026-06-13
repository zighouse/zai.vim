// @zaivim/engine — Override Manager (Story 2.2, Task 2 / FR66)
// User override mechanism for blocked security operations.
// Enables users to explicitly acknowledge risks and override S/A-level blocks.

import { randomUUID } from 'node:crypto';
import type { HarmLevel, OverrideRecord } from '@zaivim/core';
import type { AuditLogger } from './audit-logger.js';

// ============================================================================
// Types
// ============================================================================

export interface PendingOperation {
  readonly operationId: string;
  readonly sessionId: string;
  readonly harmLevel: HarmLevel;
  readonly originalCommand: string;
  readonly originalDecision: { harmLevel: HarmLevel; reason: string };
  readonly timestamp: number; // Date.now() when rejected
}

/** Warning fatigue tracking per session and operation type (Task 4.4) */
interface WarningFatigueEntry {
  readonly sessionId: string;
  readonly operationType: string; // Derived from reason keyword
  readonly attempts: number;
  readonly lastAttemptAt: number;
}

/** Result of warning fatigue check (Task 4.4) */
interface WarningFatigueResult {
  readonly escalated: boolean; // Requires "I CONFIRM"
  readonly countdownRequired: boolean; // Requires 10s countdown
  readonly countdownSeconds?: number; // Countdown duration
  readonly attemptNumber: number; // Current attempt number
}

interface OverrideConfig {
  /** Max overrides per minute across all sessions */
  readonly maxRatePerMinute: number;
  /** Operation expiry in ms (default 5 min) */
  readonly operationTtlMs: number;
  /** Delay progression (seconds) */
  readonly delayProgression: readonly number[];
  /** Max audit log ratio before warning (default 30%) */
  readonly maxOverrideAuditRatio: number;
  /** Separate file for override audit logs (optional) */
  readonly overrideAuditPath?: string;
  /** Warning fatigue: minutes to track repeat attempts (default 5) */
  readonly warningFatigueWindowMinutes: number;
  /** Warning fatigue: acknowledgment escalation threshold (default 2) */
  readonly warningFatigueEscalationThreshold: number;
  /** Warning fatigue: countdown wait threshold (default 3) */
  readonly warningFatigueCountdownThreshold: number;
  /** Warning fatigue: countdown wait seconds (default 10) */
  readonly warningFatigueCountdownSeconds: number;
}

const DEFAULT_CONFIG: OverrideConfig = {
  maxRatePerMinute: 5,
  operationTtlMs: 5 * 60 * 1000, // 5 minutes
  delayProgression: [0, 2, 5, 10, 30],
  maxOverrideAuditRatio: 0.3,
  warningFatigueWindowMinutes: 5,
  warningFatigueEscalationThreshold: 2,
  warningFatigueCountdownThreshold: 3,
  warningFatigueCountdownSeconds: 10,
};

// ============================================================================
// OverrideManager
// ============================================================================

export class OverrideManager {
  #config: OverrideConfig;

  /** Pending (rejected) operations awaiting potential override */
  readonly #pendingOps = new Map<string, PendingOperation>();

  /** Rate limiting state — global token bucket */
  #rateTokens: number;
  #rateLastRefill: number;

  /** Delay progression state */
  #delayIndex: number;
  #delayLastReset: number;
  /** Debounce delay — resets after CONSECUTIVE_RESET_MS of inactivity */
  static readonly CONSECUTIVE_RESET_MS = 60_000;

  /** Override counters for audit ratio tracking */
  #totalOverrideCount: number;
  #totalAuditCount: number;

  /** Separate audit logger for overrides (optional) */
  #overrideAuditLogger?: AuditLogger;
  #mainAuditLogger?: AuditLogger;

  /** Warning fatigue tracking: session+operationType → attempts and timestamp (Task 4.4) */
  readonly #warningFatigue = new Map<string, WarningFatigueEntry>();

  constructor(config: Partial<OverrideConfig> = {}, overrideAuditLogger?: AuditLogger, mainAuditLogger?: AuditLogger) {
    this.#config = { ...DEFAULT_CONFIG, ...config };
    this.#rateTokens = this.#config.maxRatePerMinute;
    this.#rateLastRefill = Date.now();
    this.#delayIndex = 0;
    this.#delayLastReset = Date.now();
    this.#totalOverrideCount = 0;
    this.#totalAuditCount = 0;
    this.#overrideAuditLogger = overrideAuditLogger;
    this.#mainAuditLogger = mainAuditLogger;
  }

  /**
   * Record a rejected operation for potential override
   *
   * @param sessionId - Session that triggered the rejection
   * @param harmLevel - Classified harm level
   * @param originalCommand - The operation/command that was blocked
   * @param originalDecision - The original security decision
   * @returns Operation ID for later override reference
   */
  recordRejection(
    sessionId: string,
    harmLevel: HarmLevel,
    originalCommand: string,
    originalDecision: { harmLevel: HarmLevel; reason: string },
  ): string {
    const operationId = randomUUID();
    const pending: PendingOperation = {
      operationId,
      sessionId,
      harmLevel,
      originalCommand,
      originalDecision,
      timestamp: Date.now(),
    };
    this.#pendingOps.set(operationId, pending);
    this.#totalAuditCount++;
    return operationId;
  }

  /**
   * Request override of a blocked operation (AC4 / FR66)
   *
   * Validates:
   * 1. operationId exists and matches a pending operation
   * 2. Caller sessionId matches the original rejection session
   * 3. Operation hasn't expired (5 min TTL)
   * 4. Acknowledgment text is non-empty (Subtask 2.3)
   * 5. Global rate limit not exceeded (Subtask 2.5)
   * 6. Input is sanitized (Subtask 2.7)
   *
   * @param operationId - ID of the pending operation
   * @param acknowledgment - User's explicit acknowledgment text
   * @param callerSessionId - Session ID of the caller
   * @returns true if override is granted
   * @throws Error with reason if override is denied
   */
  requestOverride(operationId: string, acknowledgment: string, callerSessionId: string): boolean {
    // Subtask 2.2.1: Validate operationId format
    if (!operationId || typeof operationId !== 'string') {
      throw new Error('Invalid operationId');
    }

    // Subtask 2.2: Validate operationId exists
    const pending = this.#pendingOps.get(operationId);
    if (!pending) {
      throw new Error(`Operation not found or already overridden: ${operationId}`);
    }

    // Subtask 2.1.2: Verify caller sessionId matches original
    if (pending.sessionId !== callerSessionId) {
      throw new Error('Caller session does not match the original rejected operation');
    }

    // Subtask 2.2.2: Check TTL
    const age = Date.now() - pending.timestamp;
    if (age > this.#config.operationTtlMs) {
      this.#pendingOps.delete(operationId);
      throw new Error(`Override window expired (${Math.round(age / 1000)}s > ${Math.round(this.#config.operationTtlMs / 1000)}s)`);
    }

    // Subtask 2.3: Validate non-empty acknowledgment
    const sanitized = this.#sanitizeInput(acknowledgment);
    if (!sanitized || sanitized.length === 0) {
      throw new Error('Acknowledgment text must not be empty');
    }

    // Task 4.4: Warning fatigue mitigation
    const fatigueResult = this.#checkWarningFatigue(pending);
    if (fatigueResult.escalated && !sanitized.includes('I CONFIRM')) {
      throw new Error(
        `Repeated override attempt (${fatigueResult.attemptNumber} in ${this.#config.warningFatigueWindowMinutes}min). ` +
        `Please add "I CONFIRM" to your acknowledgment to confirm you understand the risk.`
      );
    }
    if (fatigueResult.countdownRequired) {
      const countdownMs = (fatigueResult.countdownSeconds ?? this.#config.warningFatigueCountdownSeconds) * 1000;
      const target = Date.now() + countdownMs;
      while (Date.now() < target) {
        // Busy-wait countdown (prevents accidental rapid overrides)
      }
    }

    // Subtask 2.5: Global rate limit check
    this.#refillRateTokens();
    if (this.#rateTokens < 1) {
      throw new Error('Override rate limit exceeded (max 5 per minute across all sessions)');
    }

    // Subtask 2.6: Apply progressive delay
    this.#applyProgressiveDelay();

    // Consume rate token
    this.#rateTokens--;
    this.#totalOverrideCount++;

    // Remove from pending
    this.#pendingOps.delete(operationId);

    // Subtask 2.4: Log to audit
    const sanitizedAck = this.#sanitizeInput(acknowledgment);
    this.#logOverride(pending, sanitizedAck);

    // Subtask 2.4.4: Check override ratio
    this.#checkOverrideRatio();

    return true;
  }

  /**
   * Get pending operation info (for Gateway forwarding)
   */
  getPendingOperation(operationId: string): PendingOperation | undefined {
    return this.#pendingOps.get(operationId);
  }

  /**
   * Get current delay index (for testing)
   */
  get currentDelayIndex(): number {
    return this.#delayIndex;
  }

  /**
   * Get override statistics
   */
  getStats(): { totalOverrides: number; totalAudits: number; overrideRatio: number; pendingCount: number } {
    return {
      totalOverrides: this.#totalOverrideCount,
      totalAudits: this.#totalAuditCount,
      overrideRatio: this.#totalAuditCount > 0 ? this.#totalOverrideCount / this.#totalAuditCount : 0,
      pendingCount: this.#pendingOps.size,
    };
  }

  // ---- Private helpers ----

  /** Refill rate tokens (Subtask 2.5) */
  #refillRateTokens(): void {
    const now = Date.now();
    const elapsed = (now - this.#rateLastRefill) / 1000;
    const refill = (elapsed / 60) * this.#config.maxRatePerMinute;
    if (refill >= 1) {
      this.#rateTokens = Math.min(this.#config.maxRatePerMinute, this.#rateTokens + Math.floor(refill));
      this.#rateLastRefill = now;
    }
  }

  /** Apply progressive delay with decay (Subtask 2.6) */
  #applyProgressiveDelay(): void {
    const now = Date.now();
    // Reset delay index after CONSECUTIVE_RESET_MS of inactivity
    if (now - this.#delayLastReset > OverrideManager.CONSECUTIVE_RESET_MS) {
      this.#delayIndex = 0;
    }

    const delaySec = this.#config.delayProgression[
      Math.min(this.#delayIndex, this.#config.delayProgression.length - 1)
    ] ?? this.#config.delayProgression[this.#config.delayProgression.length - 1] ?? 0;

    if (delaySec > 0) {
      // Synchronous sleep — blocks the caller (within the mutex scope)
      const target = now + delaySec * 1000;
      while (Date.now() < target) {
        // Busy-wait (micro tasks still process)
      }
    }

    this.#delayIndex++;
    this.#delayLastReset = now;
  }

  /** Sanitize input: strip newlines, null chars (Subtask 2.7) */
  #sanitizeInput(input: string): string {
    return input.replace(/[\n\r ]/g, ' ').trim();
  }

  /** Log override to audit trail (Subtask 2.4) */
  #logOverride(pending: PendingOperation, acknowledgment: string): void {
    const record: OverrideRecord = {
      auditEventType: 'override',
      override: {
        operationId: pending.operationId,
        harmLevel: pending.harmLevel,
        originalCommand: pending.originalCommand,
        acknowledgment,
        sessionId: pending.sessionId,
        timestamp: new Date().toISOString(),
      },
      originalDecision: {
        harmLevel: pending.originalDecision.harmLevel,
        reason: pending.originalDecision.reason,
      },
    };

    const jsonLine = JSON.stringify(record) + '\n';

    // Write to main audit logger
    if (this.#mainAuditLogger) {
      // Use internal write path — bypass preExecute to avoid self-trigger loops
      this.#mainAuditLogger.log({
        timestamp: record.override.timestamp,
        sessionId: record.override.sessionId,
        operation: 'override',
        harmLevel: record.override.harmLevel,
        decision: 'allowed',
        reason: `User override: ${acknowledgment}`,
        user: 'system',
        userAcknowledged: true,
        auditEventType: 'override',
        metadata: { overrideRecord: record },
      }).catch(() => {});
    }

    // Subtask 2.4.4: Write to separate file if configured
    if (this.#overrideAuditLogger) {
      this.#overrideAuditLogger.log({
        timestamp: record.override.timestamp,
        sessionId: record.override.sessionId,
        operation: 'override',
        harmLevel: record.override.harmLevel,
        decision: 'allowed',
        reason: `User override for ${record.override.originalCommand}: ${acknowledgment}`,
        user: 'system',
        userAcknowledged: true,
        auditEventType: 'override',
        metadata: { overrideRecord: record },
      }).catch(() => {});
    }
  }

  /** Check override-to-audit ratio (Subtask 2.4.4) */
  #checkOverrideRatio(): void {
    const ratio = this.#totalAuditCount > 0
      ? this.#totalOverrideCount / this.#totalAuditCount
      : 0;

    if (ratio > this.#config.maxOverrideAuditRatio) {
      console.warn(
        `[OverrideManager] Override ratio ${(ratio * 100).toFixed(1)}% exceeds threshold ` +
        `${(this.#config.maxOverrideAuditRatio * 100).toFixed(1)}% — ` +
        `${this.#totalOverrideCount} overrides in ${this.#totalAuditCount} total audits`
      );
    }
  }

  // ---- Warning fatigue mitigation (Task 4.4) ----

  /**
   * Check warning fatigue status for this override attempt
   *
   * Returns the fatigue level and any additional requirements:
   * - escalated: requires "I CONFIRM" in acknowledgment
   * - countdownRequired: requires 10s countdown
   *
   * @param pending - The pending operation being overridden
   * @returns Fatigue result with escalation and countdown requirements
   */
  #checkWarningFatigue(pending: PendingOperation): WarningFatigueResult {
    // Extract operation type from reason (normalized for grouping)
    const operationType = this.#extractOperationType(pending.originalDecision.reason);
    const key = `${pending.sessionId}:${operationType}`;

    // Clean up old entries outside the fatigue window (5 minutes)
    this.#cleanupFatigueEntries();

    // Get existing entry or create new
    const existing = this.#warningFatigue.get(key);
    const now = Date.now();
    const attemptNumber = existing ? existing.attempts + 1 : 1;

    // Update fatigue tracking
    this.#warningFatigue.set(key, {
      sessionId: pending.sessionId,
      operationType,
      attempts: attemptNumber,
      lastAttemptAt: now,
    });

    // Determine fatigue level (Task 4.4)
    const escalated = attemptNumber >= this.#config.warningFatigueEscalationThreshold;
    const countdownRequired = attemptNumber >= this.#config.warningFatigueCountdownThreshold;

    return {
      escalated,
      countdownRequired,
      countdownSeconds: this.#config.warningFatigueCountdownSeconds,
      attemptNumber,
    };
  }

  /**
   * Extract operation type from reason for fatigue grouping
   *
   * Normalizes similar operations for grouping:
   * - "system file modification attempted" → "system_file_mod"
   * - "SSH configuration modification" → "ssh_config"
   * - "package installation" → "package_install"
   */
  #extractOperationType(reason: string): string {
    const lowerReason = reason.toLowerCase();

    // Group by keyword patterns
    if (lowerReason.includes('system file') || lowerReason.includes('/etc/') || lowerReason.includes('/usr/')) {
      return 'system_file_mod';
    }
    if (lowerReason.includes('ssh') || lowerReason.includes('.ssh/')) {
      return 'ssh_config';
    }
    if (lowerReason.includes('aws') || lowerReason.includes('.aws/')) {
      return 'aws_credential';
    }
    if (lowerReason.includes('kube') || lowerReason.includes('.kube/')) {
      return 'kubernetes_config';
    }
    if (lowerReason.includes('package install') || lowerReason.includes('pip install') || lowerReason.includes('npm install')) {
      return 'package_install';
    }
    if (lowerReason.includes('docker') || lowerReason.includes('container')) {
      return 'container_op';
    }
    if (lowerReason.includes('destructive') || lowerReason.includes('rm -rf')) {
      return 'destructive_op';
    }

    // Default: use first two words as type
    const words = lowerReason.split(' ').slice(0, 2);
    return words.join('_');
  }

  /**
   * Clean up fatigue entries outside the tracking window (5 minutes)
   */
  #cleanupFatigueEntries(): void {
    const now = Date.now();
    const windowMs = this.#config.warningFatigueWindowMinutes * 60 * 1000;
    const cutoff = now - windowMs;

    for (const [key, entry] of this.#warningFatigue.entries()) {
      if (entry.lastAttemptAt < cutoff) {
        this.#warningFatigue.delete(key);
      }
    }
  }

  /**
   * Get warning fatigue stats for testing
   */
  getWarningFatigueStats(sessionId: string): Map<string, WarningFatigueEntry> {
    const result = new Map<string, WarningFatigueEntry>();
    for (const [key, entry] of this.#warningFatigue.entries()) {
      if (entry.sessionId === sessionId) {
        result.set(key, entry);
      }
    }
    return result;
  }
}
