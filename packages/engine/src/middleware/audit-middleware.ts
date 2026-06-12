// @zaivim/engine — AuditMiddleware Pipeline Middleware (Story 2.3, AC #10)
// Sits after SecurityMiddleware in the pipeline and records final operation
// results (rejected/allowed) to the audit log.
//
// Middleware order registration constraint:
//   SecurityMiddleware must be registered BEFORE AuditMiddleware (ADR-5)
//   Violation → engine refuses to start with explicit error message.

import type { Auditor } from '../security/auditor.js';
import type { AuditEvent, AuditEventType, SafetyLevel } from '@zaivim/core';

/** Result passed from SecurityMiddleware to AuditMiddleware */
export interface SecurityResult {
  readonly allowed: boolean;
  readonly harmLevel: SafetyLevel;
  readonly reason: string;
  readonly sessionId: string;
}

/** Parameters for an operation being processed through the pipeline */
export interface OperationParams {
  readonly operation: string;
  readonly params?: Record<string, unknown>;
  readonly sessionId: string;
  readonly agentId?: string;
}

/**
 * AuditMiddleware — records final operation results to audit log
 *
 * MUST be registered after SecurityMiddleware in the pipeline.
 * Startup validation ensures this constraint (AC #10).
 */
export class AuditMiddleware {
  readonly #auditor: Auditor;
  #active: boolean;

  constructor(auditor: Auditor) {
    this.#auditor = auditor;
    this.#active = true;
  }

  /**
   * Validate middleware registration order (AC #10)
   *
   * SecurityMiddleware must be registered before AuditMiddleware per ADR-5.
   * Returns valid=false if order is violated.
   */
  static validatePipelinePosition(
    middlewareOrder: readonly string[],
  ): { valid: boolean; error?: string } {
    const secIndex = middlewareOrder.indexOf('SecurityMiddleware');
    const auditIndex = middlewareOrder.indexOf('AuditMiddleware');

    if (auditIndex === -1) {
      // AuditMiddleware not in list — this is a configuration error
      return {
        valid: false,
        error: 'AuditMiddleware is not registered in the pipeline',
      };
    }

    if (secIndex === -1) {
      // SecurityMiddleware not in list — config error, but not our job to enforce
      return { valid: true };
    }

    if (auditIndex <= secIndex) {
      return {
        valid: false,
        error:
          'Pipeline middleware order violation: AuditMiddleware must be registered after SecurityMiddleware (ADR-5)',
      };
    }

    return { valid: true };
  }

  /**
   * Record a completed operation to the audit log.
   *
   * Called after SecurityMiddleware makes its decision and the operation
   * either executes or is rejected. Records the FINAL result (rejected/allowed),
   * not intermediate state.
   *
   * @returns void — errors are logged but never thrown (audit failure must not
   *   crash the pipeline). The Auditor handles fail-closed via its own
   *   degraded flag.
   */
  record(
    securityResult: SecurityResult,
    op: OperationParams,
  ): void {
    if (!this.#active) return;

    const event: AuditEvent = {
      timestamp: new Date().toISOString(),
      operation: op.operation,
      level: securityResult.harmLevel,
      sessionId: securityResult.sessionId,
      agentId: op.agentId,
      result: securityResult.allowed ? 'allowed' : 'rejected',
      reason: securityResult.reason,
      params: op.params,
    };

    // Use writeInternal to avoid re-entering preExecute (prevents audit loops)
    this.#auditor.writeInternal(event).catch((err) => {
      // Audit failures are non-fatal for the pipeline — the Auditor
      // manages its own degraded/fail-closed lifecycle independently.
      // Log to stderr for diagnostics (do not throw — pipeline must continue).
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[AuditMiddleware] audit write failed: ${msg}\n`);
    });
  }

  /**
   * Shutdown the middleware.
   */
  shutdown(): void {
    this.#active = false;
  }
}
