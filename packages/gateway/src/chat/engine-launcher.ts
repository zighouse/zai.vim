// @zaivim/gateway — Engine auto-start and health check
// Ensures the zaivim engine is running before entering chat mode.

import { checkExistingPid, readPidFile } from '@zaivim/engine';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const PID_PATH = join(homedir(), '.zaivim', 'engine.pid');
const ENGINE_STARTUP_TIMEOUT = 3000; // NFR4
const HEALTH_POLL_INTERVAL = 200;

export interface EngineLauncherResult {
  /** Whether the engine was already running. */
  alreadyRunning: boolean;
  /** PID of the engine process. */
  pid?: number;
}

/**
 * Ensure the zaivim engine is running.
 * If not, auto-start in daemon mode and poll until healthy.
 * @throws Error if engine fails to start within timeout.
 */
export async function ensureEngineRunning(): Promise<EngineLauncherResult> {
  // 1. Check if engine is already running
  const pidCheck = checkExistingPid(PID_PATH);
  if (pidCheck.alive && pidCheck.pid) {
    return { alreadyRunning: true, pid: pidCheck.pid };
  }

  // 2. Auto-start engine in daemon mode
  const cliPath = getCliPath();
  const child = spawn(process.execPath, [cliPath, 'serve', '--daemon'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  if (!child.pid) {
    throw new Error('Failed to spawn engine daemon process');
  }

  // 3. Poll PID file until engine is ready
  const maxAttempts = Math.ceil(ENGINE_STARTUP_TIMEOUT / HEALTH_POLL_INTERVAL);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await sleep(HEALTH_POLL_INTERVAL);
    const check = checkExistingPid(PID_PATH);
    if (check.alive) {
      return { alreadyRunning: false, pid: check.pid };
    }
  }

  throw new Error(
    `Engine startup timed out after ${ENGINE_STARTUP_TIMEOUT}ms. ` +
    'Try running "zaivim serve --daemon" manually.',
  );
}

/** Resolve the path to the CLI entry point for daemon spawn. */
function getCliPath(): string {
  // In production: dist/cli.js relative to this file
  const thisFile = fileURLToPath(import.meta.url);
  const distDir = dirname(thisFile);
  // chat/engine-launcher.js → dist/cli.js (both in dist/)
  return join(distDir, '..', 'cli.js');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
