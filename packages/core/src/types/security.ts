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
 */
export interface FileChangeProposal {
  readonly path: string;
  readonly operation: 'create' | 'modify' | 'delete';
  readonly diff?: string;
  readonly reason: string;
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
  postExecute(operation: string, result: { success: boolean; output?: string }): Promise<void>;

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
