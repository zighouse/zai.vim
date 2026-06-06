// @zaivim/engine — Health endpoint response builder

import type { HealthResponse, EngineAPI } from '@zaivim/core';

const NEXT_MILESTONE = 'v0.2.0 - AI chat';

/**
 * Build health response from engine.
 */
export function buildHealthResponse(engine: EngineAPI, uptime?: number): HealthResponse {
  const health = engine.getHealth();
  return {
    status: health.status,
    version: engine.version,
    uptime: uptime ?? 0,
    sandboxAvailable: health.sandboxAvailable,
    activeSessions: health.activeSessions,
    nextMilestone: NEXT_MILESTONE,
  };
}

/**
 * Build a simple ping response for `zaivim ping` (AC2).
 */
export function buildPingResponse(engine: EngineAPI | undefined, version: string, uptime?: number): {
  status: string;
  version: string;
  uptime?: number;
  nextMilestone: string;
} {
  if (engine) {
    const health = engine.getHealth();
    return {
      status: health.status === 'ok' ? 'ok' : health.status,
      version,
      uptime: uptime ?? 0,
      nextMilestone: NEXT_MILESTONE,
    };
  }

  // No engine instance (daemon mode or not running)
  // If uptime is provided, assume daemon mode with running engine
  if (uptime && uptime > 0) {
    return {
      status: 'ok',
      version,
      uptime,
      nextMilestone: NEXT_MILESTONE,
    };
  }

  return {
    status: 'down',
    version,
    nextMilestone: NEXT_MILESTONE,
  };
}
