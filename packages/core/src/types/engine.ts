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
  readonly activeSessions: number;
  readonly nextMilestone?: string;
}
