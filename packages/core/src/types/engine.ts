// =============================================================================
// @zaivim/core — Engine types
// EngineConfig, EngineStatus, HealthResponse, EngineState
// =============================================================================

/** Engine lifecycle states — explicit state machine (ADR-13) */
export type EngineState =
  | 'starting'
  | 'running'
  | 'degraded'
  | 'draining'
  | 'shutting_down'
  | 'terminated';

/** Engine configuration passed to createEngine() */
export interface EngineConfig {
  readonly pidFile: string;
  readonly version: string;
  readonly startupTimeout: number;
  readonly healthCheckInterval: number;
}

/** Simplified engine status for status command */
export interface EngineStatus {
  readonly status: 'ok' | 'down' | 'degraded';
  readonly pid: number | null;
  readonly uptime: number;
  readonly version: string;
}

/** Health endpoint response (AC1) */
export interface HealthResponse {
  readonly status: 'ok' | 'degraded' | 'down';
  readonly version: string;
  readonly uptime: number;
  readonly sandboxAvailable: boolean;
  /** Security level indicator (Story 2.2, Task 6) */
  readonly securityLevel?: 'secure' | 'degraded' | 'at-risk';
  readonly activeSessions: number;
  readonly nextMilestone?: string;
  readonly methods?: Record<string, string>;
}

/** Shutdown stages following ADR-23 graded shutdown protocol */
export type ShutdownStage =
  | 'drain-requests'
  | 'drain-agents'
  | 'persist-sessions'
  | 'flush-audit'
  | 'clean-pid'
  | 'exit';

/** Shutdown options for controlling graceful shutdown behavior */
export interface ShutdownOptions {
  readonly force: boolean;
  readonly reason: string;
  readonly timeout?: number; // milliseconds, default 10000
}

/** Shutdown event emitted during lifecycle */
export interface ShutdownEvent {
  readonly stage: ShutdownStage;
  readonly timestamp: number;
  readonly reason: string;
  readonly force: boolean;
}
