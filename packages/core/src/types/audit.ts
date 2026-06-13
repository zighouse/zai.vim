// =============================================================================
// @zaivim/core — Audit types
// AuditEvent, IAuditor interface, query/summary types for JSONL audit logging
// =============================================================================

/** Safety level classification for audit events */
export type SafetyLevel = 'S' | 'A' | 'B' | 'C';

/** Audit event type discriminator */
export type AuditEventType =
  | 'operation'              // Normal operation
  | 'override'               // User override of S-level rejection
  | 'security_status_change' // Security state degraded/restored
  | 'audit.truncated'        // Parameter truncation record
  | 'audit.throttle';        // Rate limit triggered

/** A single audit log event */
export interface AuditEvent {
  readonly timestamp: string;          // ISO 8601
  readonly operation: string;          // Operation name (file_read, shell_execute, etc.)
  readonly level: SafetyLevel;         // Safety classification
  readonly sessionId: string;          // Associated session
  readonly agentId?: string;           // Optional agent identifier
  readonly result: 'allowed' | 'rejected';  // Final outcome
  readonly reason?: string;            // Rejection reason if rejected
  readonly params?: Record<string, unknown>; // Operation parameters (redacted)
  readonly auditEventType?: AuditEventType;  // Default 'operation'
  readonly metadata?: Record<string, unknown> & {
    readonly elapsed?: number;         // Operation duration (ms)
    readonly truncated?: boolean;      // Whether params were truncated
  };
}

/** Filter for audit.query() */
export interface AuditQueryFilter {
  date?: string;                      // YYYY-MM-DD
  level?: SafetyLevel;
  session?: string;
  auditEventType?: AuditEventType;    // Default excludes override records
}

/** Aggregated audit summary for audit.summary() */
export interface AuditSummary {
  readonly period: string;            // '24h' | '7d'
  readonly total: number;
  readonly byLevel: Record<SafetyLevel, number>;
  readonly rejected: number;
  readonly overrides?: number;
  readonly topSessions: Array<{ id: string; ops: number }>;
}

/** Auditor interface — JSONL append-only audit logging */
export interface IAuditor {
  readonly logDir: string;

  /** External path: via Pipeline/AuditMiddleware, subject to preExecute check */
  write(event: AuditEvent): Promise<void>;

  /** Internal path: bypasses preExecute (prevents self-triggered audit loops) */
  writeInternal(event: AuditEvent): Promise<void>;

  /** Query audit events with optional filters */
  query(filter: AuditQueryFilter): Promise<AuditEvent[]>;

  /** Get aggregated summary for a time period */
  summary(period: '24h' | '7d'): Promise<AuditSummary>;
}
