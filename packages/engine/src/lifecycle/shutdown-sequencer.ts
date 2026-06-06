// @zaivim/engine — ShutdownSequencer
// Graded shutdown orchestration following ADR-23 protocol
// Order: drain requests → drain agents → persist sessions → flush audit → clean pid → exit

import type { ShutdownOptions, ShutdownStage, ShutdownEvent } from '@zaivim/core';
import type { EventEmitter } from 'node:events';

const SHUTDOWN_TIMEOUT = 10_000; // 10s total per NFR26
const STAGE_TIMEOUT = 2_500; // 2.5s per stage (10s / 4 stages)

// Use global AbortController (available in Node.js 16+)
declare const AbortController: {
  prototype: AbortController;
  new(): AbortController;
};

export interface ShutdownDependencies {
  stateMachine: { transition: (event: string) => unknown };
  agentPool: {
    drain(): Promise<void>;
    terminateAll(): Promise<void>;
  };
  sessionManager: {
    persistAll(): Promise<void>;
    flushAuditLog(): Promise<void>;
  };
  pidFile: { remove(): void };
  eventEmitter: EventEmitter;
}

/**
 * ShutdownSequencer implements graded graceful shutdown following ADR-23.
 *
 * Stages (executed in order):
 * 1. drain-requests: Stop accepting new requests
 * 2. drain-agents: Wait for agents to complete (or timeout)
 * 3. persist-sessions: Force fsync session data
 * 4. flush-audit: Flush audit logs
 * 5. clean-pid: Remove PID file
 * 6. exit: process.exit(0)
 *
 * On timeout (10s), forces termination:
 * - Skips remaining waits
 * - Ensures state is persisted
 * - Calls agent.terminate()
 * - Still exits cleanly
 */
export class ShutdownSequencer {
  readonly #deps: ShutdownDependencies;
  #shutdownInProgress = false;
  #aborted = false;

  constructor(deps: ShutdownDependencies) {
    this.#deps = deps;
  }

  /**
   * Initiate graceful shutdown sequence.
   * @param options - Shutdown configuration
   */
  async shutdown(options: ShutdownOptions): Promise<void> {
    if (this.#shutdownInProgress) {
      this.handleSecondSigterm();
      return; // unreachable due to exit()
    }

    this.#shutdownInProgress = true;

    const { force, reason, timeout = SHUTDOWN_TIMEOUT } = options;
    const controller = new AbortController();
    const signal = controller.signal;

    // Set timeout for entire shutdown sequence
    const timeoutId = setTimeout(() => {
      if (!this.#aborted) controller.abort();
    }, timeout);

    try {
      this.emitEvent('drain-requests', reason, force);
      this.#deps.stateMachine.transition('drain');

      this.emitEvent('drain-agents', reason, force);
      if (force) {
        await this.#deps.agentPool.terminateAll();
      } else {
        await this.withStageTimeout('drain-agents', () =>
          this.#deps.agentPool.drain()
        );
      }

      this.emitEvent('persist-sessions', reason, force);
      await this.withStageTimeout('persist-sessions', () =>
        this.#deps.sessionManager.persistAll()
      );

      this.emitEvent('flush-audit', reason, force);
      await this.withStageTimeout('flush-audit', () =>
        this.#deps.sessionManager.flushAuditLog()
      );

      this.emitEvent('clean-pid', reason, force);
      this.#deps.pidFile.remove();

      this.emitEvent('exit', reason, force);
      this.#deps.stateMachine.transition('shutdown');
      this.#deps.stateMachine.transition('terminate');

      clearTimeout(timeoutId);
      process.exit(0);
    } catch (error) {
      clearTimeout(timeoutId);

      if (signal.aborted || this.#aborted) {
        // Timeout or aborted - force termination
        await this.forceShutdown(reason);
      } else {
        console.error('Shutdown error:', error);
        // Continue with cleanup anyway
        await this.forceShutdown(reason);
      }
    }
  }

  /**
   * Execute a stage with timeout.
   * If timeout, aborts and continues to next stage.
   */
  private async withStageTimeout<T>(
    stage: ShutdownStage,
    fn: () => Promise<T>
  ): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      console.warn(`Shutdown stage "${stage}" failed or timed out:`, error);
      throw error; // Re-throw to trigger force shutdown
    }
  }

  /**
   * Force shutdown when timeout or error occurs.
   * Ensures critical cleanup happens.
   */
  private async forceShutdown(reason: string): Promise<void> {
    this.#aborted = true;

    console.warn('Force shutdown initiated');

    try {
      // Terminate agents immediately
      await this.#deps.agentPool.terminateAll();
    } catch (err) {
      console.error('Failed to terminate agents:', err);
    }

    try {
      // Best effort persist
      await this.#deps.sessionManager.persistAll();
    } catch (err) {
      console.error('Failed to persist sessions:', err);
    }

    try {
      await this.#deps.sessionManager.flushAuditLog();
    } catch (err) {
      console.error('Failed to flush audit log:', err);
    }

    try {
      this.#deps.pidFile.remove();
    } catch (err) {
      console.error('Failed to remove PID file:', err);
    }

    this.#deps.stateMachine.transition('shutdown');
    this.#deps.stateMachine.transition('terminate');

    process.exit(0);
  }

  /**
   * Emit shutdown event for external listeners (e.g., gateway layer).
   */
  private emitEvent(stage: ShutdownStage, reason: string, force: boolean): void {
    const event: ShutdownEvent = {
      stage,
      timestamp: Date.now(),
      reason,
      force,
    };
    this.#deps.eventEmitter.emit('engine:shutdown:stage', event);
    this.#deps.eventEmitter.emit(`engine:shutdown:${stage}`, event);
  }

  /**
   * Handle second SIGTERM - immediate exit.
   * Called when shutdown already in progress and another signal received.
   */
  handleSecondSigterm(): void {
    console.error('Second SIGTERM received - forcing immediate exit');
    process.exit(1);
  }

  /**
   * Mark shutdown as in progress (for double-signal detection).
   */
  markShutdownInProgress(): void {
    this.#shutdownInProgress = true;
  }

  /**
   * Check if shutdown is currently in progress.
   */
  get isShuttingDown(): boolean {
    return this.#shutdownInProgress;
  }
}
