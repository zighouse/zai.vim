// @zaivim/engine — PID file management
// writePidFile() + checkExistingPid() for daemon mode

import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

export interface PidFileData {
  readonly pid: number;
  readonly startedAt: number;
  readonly version: string;
}

/**
 * Write PID file with current process info.
 * Creates parent directories if needed.
 */
export function writePidFile(pidPath: string, version: string): void {
  const data: PidFileData = {
    pid: process.pid,
    startedAt: Date.now(),
    version,
  };

  const resolved = resolve(pidPath.replace(/^~/, process.env.HOME ?? '~'));
  try {
    mkdirSync(dirname(resolved), { recursive: true });
    writeFileSync(resolved, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error(`Failed to write PID file at ${resolved}: ${(err as Error).message}`);
    throw err;
  }
}

/**
 * Read existing PID file. Returns null if file doesn't exist or is invalid.
 */
export function readPidFile(pidPath: string): PidFileData | null {
  const resolved = resolve(pidPath.replace(/^~/, process.env.HOME ?? '~'));
  if (!existsSync(resolved)) return null;

  try {
    const raw = readFileSync(resolved, 'utf-8');
    return JSON.parse(raw) as PidFileData;
  } catch {
    return null;
  }
}

/**
 * Check if a process with given PID is still alive using kill(pid, 0).
 * Returns true if process exists, false if ESRCH (no such process).
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check for existing PID file and whether that process is still running.
 * Returns { alive: false } if no file or stale PID.
 */
export function checkExistingPid(pidPath: string): { alive: boolean; pid?: number; data?: PidFileData } {
  const data = readPidFile(pidPath);
  if (!data) return { alive: false };

  const alive = isProcessAlive(data.pid);
  return { alive, pid: data.pid, data };
}

/**
 * Remove PID file. Used during graceful shutdown.
 */
export function removePidFile(pidPath: string): void {
  const resolved = resolve(pidPath.replace(/^~/, process.env.HOME ?? '~'));
  try {
    if (existsSync(resolved)) unlinkSync(resolved);
  } catch {
    // best-effort removal
  }
}
