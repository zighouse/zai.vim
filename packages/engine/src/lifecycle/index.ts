// @zaivim/engine — Lifecycle barrel export
export { EngineStateMachine } from './state-machine.js';
export type { EngineTransition } from './state-machine.js';
export { createEngine, resetEngine, getEngineInstance, EngineImpl } from './create-engine.js';
export { writePidFile, readPidFile, checkExistingPid, removePidFile, isProcessAlive } from './pid-file.js';
export type { PidFileData } from './pid-file.js';
export { buildHealthResponse, buildPingResponse } from './health.js';
export { ShutdownSequencer } from './shutdown-sequencer.js';
export type { ShutdownDependencies } from './shutdown-sequencer.js';
export { InstanceGuard } from './instance-guard.js';
