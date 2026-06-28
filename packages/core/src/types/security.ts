// =============================================================================
// @zaivim/core — Security types
// Types for security enforcement, harm classification, and audit logging
// =============================================================================

/**
 * Harm level classification for shell commands and operations
 *
 * - S: Severe - destructive operations (rm -rf, mkfs, dd, etc.)
 * - A: Advanced - system modifications (package install, system config)
 * - B: Basic - standard operations with potential impact
 * - C: Common - read-only operations, minimal risk
 */
export type HarmLevel = 'S' | 'A' | 'B' | 'C';

/**
 * Security decision result from pre-execution check
 *
 * When allowed=false, the operation MUST be blocked.
 * The harmLevel and reason MUST be displayed to the user.
 */
export interface SecurityDecision {
  /** Whether the operation is allowed to proceed */
  readonly allowed: boolean;
  /** Classified harm level of the operation */
  readonly harmLevel: HarmLevel;
  /** Human-readable explanation of the decision */
  readonly reason: string;
  /** If blocked, suggest safer alternatives (optional) */
  readonly alternatives?: readonly string[];
}

/**
 * Security status for user-facing display
 *
 * Provides transparency about current security configuration and restrictions.
 */
export interface SecurityStatus {
  /** Current sandbox implementation */
  readonly sandboxMode: 'bwrap' | 'null' | 'degraded' | 'sandbox-exec' | 'wsl2';
  /** Platform-specific information */
  readonly platform: 'linux' | 'macos' | 'windows' | 'unknown';
  /** Filesystem restrictions active */
  readonly filesystemRestricted: boolean;
  /** Network isolation status */
  readonly networkIsolated: boolean;
  /** Audit log location */
  readonly auditLogPath: string;
  /** Whether security is fully operational */
  readonly isOperational: boolean;
  /** Additional status information */
  readonly details?: readonly string[];
}

/**
 * Audit log entry structure
 *
 * All security-relevant operations are logged to append-only JSONL.
 */
export interface AuditEntry {
  /** ISO 8601 timestamp */
  readonly timestamp: string;
  /** Session identifier */
  readonly sessionId: string;
  /** Operation being performed (e.g., 'shell_exec', 'file_write') */
  readonly operation: string;
  /** Classified harm level */
  readonly harmLevel: HarmLevel;
  /** Security decision made */
  readonly decision: 'allowed' | 'denied';
  /** Reason for decision */
  readonly reason: string;
  /** User acknowledgment (for overrides) */
  readonly userAcknowledged?: boolean;
  /** Additional metadata (operation-specific) */
  readonly metadata?: Record<string, unknown>;
}

/**
 * File change proposal for approval flow
 *
 * Proposed file changes that require user approval.
 * Story 3.5 (async approval): enhanced with changeId, agentId, sessionId,
 * timestamp, timeoutMs, baseFileHash for the full async approval lifecycle.
 */
export interface FileChangeProposal {
  readonly path: string;
  readonly operation: 'create' | 'modify' | 'delete';
  readonly diff?: string;
  readonly reason: string;
  // --- Write-backup fields (tools/src/file.ts original) ---
  readonly originalPath?: string;
  readonly backupPath?: string;
  readonly proposedContent?: string;
  // --- Story 3.5 async approval fields ---
  readonly changeId?: string;
  readonly agentId?: string;
  readonly sessionId?: string;
  readonly timestamp?: number;
  readonly timeoutMs?: number;
  readonly baseFileHash?: string;
}

// =============================================================================
// File operation handle types (Story 3.1)
// =============================================================================

/** File operation type for openFile */
export type FileOperation = 'read' | 'write' | 'delete';

/**
 * Safe file handle returned by ISecurityProvider.openFile(path, 'read').
 *
 * Tool code reads through this handle, not via raw fs — ensures path
 * validation cannot be bypassed after the check.
 */
export interface SafeFileHandle {
  /** The validated real path of the opened file */
  readonly validatedPath: string;
  /** Read the entire file content with the given encoding */
  read(encoding?: BufferEncoding): Promise<string>;
  /** Close the underlying file handle */
  close(): Promise<void>;
}

/**
 * Write approval returned by ISecurityProvider.openFile(path, 'write'|'delete').
 *
 * Confirms the path passed validation and provides the resolved absolute path
 * that tools can use for writing.
 */
export interface WriteApproval {
  /** The validated real path for writing */
  readonly validatedPath: string;
  /** The resolved absolute path (after realpath normalization) */
  readonly resolvedPath: string;
}

/**
 * Security provider interface
 *
 * All tool executions MUST go through this interface for security checks.
 * The security chain cannot be bypassed - enforcement at ToolExecutor level.
 */
export interface ISecurityProvider {
  /** Sandbox type identifier */
  readonly sandboxType: 'none' | 'bwrap' | 'sandbox-exec' | 'wsl2';

  /**
   * Pre-execution security check
   *
   * Called BEFORE any tool execution. Must return SecurityDecision.
   * If allowed=false, execution MUST be blocked.
   *
   * @param operation - Operation type (e.g., 'shell_exec', 'file_write')
   * @param params - Operation parameters
   * @returns Security decision with allow/deny and explanation
   */
  preExecute(operation: string, params: Record<string, unknown>): Promise<SecurityDecision>;

  /**
   * Post-execution audit logging
   *
   * Called AFTER tool execution completes (success or failure).
   * Must append to audit log (async, non-blocking).
   *
   * @param operation - Operation type that was executed
   * @param result - Execution result (success/failure, output, etc.)
   */
  postExecute(operation: string, result: { success: boolean; output?: string; sessionId?: string }): Promise<void>;

  /**
   * Get current security status for display
   *
   * Returns user-facing security status information.
   */
  getStatus(): SecurityStatus;

  /**
   * Check if sandbox is available on this platform
   *
   * Returns false if sandbox cannot be used (graceful degradation).
   */
  isSandboxAvailable(): boolean;

  /**
   * Open a file with TOCTOU-safe path validation (Story 3.1).
   *
   * For reads: returns SafeFileHandle for validated file access.
   * For writes/deletes: returns WriteApproval with resolved path.
   *
   * @param path - File path relative to project root
   * @param operation - File operation type
   */
  openFile(path: string, operation: 'read'): Promise<SafeFileHandle>;
  openFile(path: string, operation: 'write' | 'delete'): Promise<WriteApproval>;
  openFile(path: string, operation: FileOperation): Promise<SafeFileHandle | WriteApproval>;

  /**
   * Validate a path is inside the project boundary without opening a file
   * handle (Story 3.3). Use for boundary-membership checks (e.g., shell cwd)
   * where a TOCTOU-safe open is unnecessary — avoids leaking a FileHandle.
   *
   * @param path - Path to validate (relative to project root or absolute)
   * @returns Resolved absolute path on success
   * @throws Error with code TOOLS_SECURITY_BLOCKED when the path is outside the boundary
   */
  validatePathAsync(path: string): Promise<string>;

  /**
   * Legacy path validation (for backward compatibility)
   *
   * @deprecated Use preExecute() instead for new code
   */
  validatePath(path: string, operation: string): boolean;

  /**
   * Legacy change proposal (for backward compatibility)
   *
   * @deprecated Use preExecute() instead for new code
   */
  proposeChange(proposal: FileChangeProposal): Promise<boolean>;
}

/**
 * Security context passed to tools
 *
 * Tools receive this through ToolContext for security-aware operations.
 */
export interface SecurityContext {
  /** Current security provider */
  readonly provider: ISecurityProvider;
  /** Session identifier for audit logging */
  readonly sessionId: string;
  /** Current harm level classification */
  readonly currentHarmLevel: HarmLevel;
}

// =============================================================================
// File operation classification types (Story 2.2)
// =============================================================================

/** Type of file operation for classification */
export type FileOperationType = 'read' | 'write' | 'delete' | 'modify';

/**
 * File classification result
 */
export interface FileClassification {
  /** Classified harm level */
  readonly harmLevel: HarmLevel;
  /** Human-readable reason */
  readonly reason: string;
  /** Resolved real path (after symlink resolution) */
  readonly resolvedPath: string;
}

// =============================================================================
// Badge display types (Story 2.2, AC5)
// =============================================================================

/** Badge display properties for a harm level */
export interface HarmLevelBadge {
  /** Harm level */
  readonly level: HarmLevel;
  /** Display color */
  readonly color: 'green' | 'yellow' | 'orange' | 'red';
  /** Short label */
  readonly label: string;
  /** Icon character */
  readonly icon: string;
  /** Brief explanation */
  readonly description: string;
}

// =============================================================================
// Risk card types (Story 2.2, AC8)
// =============================================================================

/** Risk card severity */
export type RiskCardSeverity = 'warning' | 'danger';

/** Risk description card */
export interface RiskCard {
  /** Template version for traceability */
  readonly templateVersion: string;
  /** The operation being classified */
  readonly operation: string;
  /** Harm level */
  readonly harmLevel: HarmLevel;
  /** Severity category */
  readonly severity: RiskCardSeverity;
  /** Specific risk description */
  readonly risk: string;
  /** Potential consequences */
  readonly consequences: readonly string[];
  /** Safer alternatives */
  readonly alternatives: readonly string[];
  /** Instructions for override (if applicable) */
  readonly overrideInstructions?: string;
}

// =============================================================================
// Override types (Story 2.2, AC4 / FR66)
// =============================================================================

/** Override request */
export interface OverrideRequest {
  /** Operation ID (crypto.randomUUID) */
  readonly operationId: string;
  /** Harm level of the original operation */
  readonly harmLevel: HarmLevel;
  /** Original command/operation that was blocked */
  readonly originalCommand: string;
  /** User acknowledgment text */
  readonly acknowledgment: string;
  /** Session ID of the requester */
  readonly sessionId: string;
  /** Timestamp of the override */
  readonly timestamp: string;
}

/** Override record stored in audit log */
export interface OverrideRecord {
  /** Audit event type discriminator */
  readonly auditEventType: 'override';
  /** Override details */
  readonly override: OverrideRequest;
  /** Original rejection decision */
  readonly originalDecision: {
    readonly harmLevel: HarmLevel;
    readonly reason: string;
  };
  /** Result after override execution */
  readonly executionResult?: {
    readonly success: boolean;
    readonly output?: string;
  };
}

// =============================================================================
// Security notification types (Story 2.2, AC9 / FR33)
// =============================================================================

/** Security degradation notification event */
export interface SecurityDegradedNotification {
  readonly type: 'security.degraded';
  readonly reason: string;
  readonly implications: readonly string[];
}

/** Security recovery notification event */
export interface SecuritySecureNotification {
  readonly type: 'security.secure';
  readonly reason: string;
  readonly status: 'secure';
}

/** Security notification union */
export type SecurityNotification = SecurityDegradedNotification | SecuritySecureNotification;

/** Tool notification with security context */
export interface ToolSecurityNotification {
  readonly type: 'tool.security';
  readonly toolCallId: string;
  readonly harmLevel: HarmLevel;
  readonly badge?: HarmLevelBadge;
}
