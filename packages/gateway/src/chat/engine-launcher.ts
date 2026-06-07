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
  // 1. Check if engine is already running (AC3: health check)
  const pidCheck = checkExistingPid(PID_PATH);
  if (pidCheck.alive && verifyProcessAlive(pidCheck.pid)) {
    return { alreadyRunning: true, pid: pidCheck.pid };
  }

  // 2. Auto-start engine in daemon mode
  const cliPath = getCliPath();
  let stderrChunks: string[] = [];
  const child = spawn(process.execPath, [cliPath, 'serve', '--daemon'], {
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  // Capture stderr so we can surface config/startup errors on timeout
  child.stderr?.on('data', (data: Buffer) => {
    const text = data.toString('utf-8');
    stderrChunks.push(text);
  });

  child.unref();

  if (!child.pid) {
    child.stderr?.destroy();
    throw new Error('Failed to spawn engine daemon process');
  }

  // 3. Poll PID file until engine is ready (AC3: /health readiness check)
  const maxAttempts = Math.ceil(ENGINE_STARTUP_TIMEOUT / HEALTH_POLL_INTERVAL);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await sleep(HEALTH_POLL_INTERVAL);
    const check = checkExistingPid(PID_PATH);
    if (check.alive && verifyProcessAlive(check.pid)) {
      child.stderr?.destroy();
      return { alreadyRunning: false, pid: check.pid };
    }
  }

  // Timeout — surface captured stderr to help the user diagnose
  child.stderr?.destroy();
  const stderrOutput = stderrChunks.join('').trim();
  const detail = stderrOutput
    ? `\nEngine stderr:\n${stderrOutput}`
    : '\nTry running "zaivim serve --daemon" manually to see the full error.';
  throw new Error(
    `Engine startup timed out after ${ENGINE_STARTUP_TIMEOUT}ms.${detail}`,
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

/** Verify a PID is alive using signal 0 (no actual signal sent). */
function verifyProcessAlive(pid: number | undefined): pid is number {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
