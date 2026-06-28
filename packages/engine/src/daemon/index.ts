// @zaivim/engine — Daemon utility barrel
// Low-level utilities for engine process management: PID file,
// instance conflict detection, and health response builders.
// These are consumed by the gateway CLI (zaivim serve/stop/status/ping).

export { writePidFile, readPidFile, checkExistingPid, removePidFile, isProcessAlive } from './pid-file.js';
export type { PidFileData } from './pid-file.js';
export { buildHealthResponse, buildPingResponse } from './health.js';
export { InstanceGuard } from './instance-guard.js';
