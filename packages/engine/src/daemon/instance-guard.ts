// @zaivim/engine — InstanceGuard
// Instance conflict detection and stale PID cleanup

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PidFileData } from './pid-file.js';
import { ZaiInstanceConflictError } from '@zaivim/core';

/**
 * InstanceGuard manages instance conflict detection and stale PID cleanup.
 *
 * Checks for existing instances by:
 * 1. Reading PID file if exists
 * 2. Checking if process is alive via kill(pid, 0)
 * 3. Throwing ZaiInstanceConflictError if alive
 * 4. Auto-cleaning stale PID if dead
 */
export class InstanceGuard {
  readonly #pidPath: string;

  constructor(pidPath: string) {
    this.#pidPath = resolve(pidPath.replace(/^~/, process.env.HOME ?? '~'));
  }

  /**
   * Check for existing instance. Throws if conflict detected.
   * Auto-cleans stale PID if process is dead.
   *
   * @throws {ZaiInstanceConflictError} If existing instance is running
   */
  checkOrThrow(): void {
    if (!existsSync(this.#pidPath)) {
      return; // No PID file = no conflict
    }

    const pidData = this.readPidFile();
    if (!pidData) {
      this.cleanupStalePid();
      return;
    }

    if (this.isProcessAlive(pidData.pid)) {
      throw new ZaiInstanceConflictError(pidData.pid, pidData.startedAt);
    }

    // Stale PID - clean up and continue
    this.cleanupStalePid();
  }

  /**
   * Find process by reading PID file.
   * Returns null if file doesn't exist or is invalid.
   */
  findProcessByPidFile(): PidFileData | null {
    if (!existsSync(this.#pidPath)) {
      return null;
    }

    return this.readPidFile();
  }

  /**
   * Read and parse PID file.
   */
  private readPidFile(): PidFileData | null {
    try {
      const raw = readFileSync(this.#pidPath, 'utf-8');
      return JSON.parse(raw) as PidFileData;
    } catch {
      return null;
    }
  }

  /**
   * Check if process with given PID is alive.
   * Uses kill(pid, 0) - returns ESRCH if process doesn't exist.
   */
  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      // ESRCH = No such process
      if (error.code === 'ESRCH') {
        return false;
      }
      // Other error (e.g., EPERM) - assume alive for safety
      return true;
    }
  }

  /**
   * Clean up stale PID file.
   */
  cleanupStalePid(): void {
    try {
      if (existsSync(this.#pidPath)) {
        unlinkSync(this.#pidPath);
      }
    } catch (err) {
      console.warn(`Failed to cleanup stale PID file at ${this.#pidPath}:`, err);
    }
  }
}
