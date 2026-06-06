// @zaivim/engine — createEngine() singleton factory
// MVP: global singleton. Second call returns existing instance.

import type { EngineAPI, EngineConfig, EngineHealth, ShutdownOptions } from '@zaivim/core';
import { EventEmitter } from 'node:events';
import { EngineStateMachine } from './state-machine.js';
import { removePidFile } from './pid-file.js';
import { ShutdownSequencer, type ShutdownDependencies } from './shutdown-sequencer.js';

export class EngineImpl extends EventEmitter implements EngineAPI {
  readonly version: string;
  readonly #stateMachine: EngineStateMachine;
  readonly #config: EngineConfig;
  readonly #shutdownSequencer: ShutdownSequencer;
  readonly #agentPool: any = null; // Will be implemented in future stories
  readonly #sessionManager: any = null; // Will be implemented in future stories

  #signalHandlers: Array<(signal: NodeJS.Signals) => void> = [];

  constructor(config: EngineConfig) {
    super();
    this.version = config.version;
    this.#config = config;
    this.#stateMachine = new EngineStateMachine();

    // Create shutdown sequencer with minimal dependencies for MVP
    this.#shutdownSequencer = new ShutdownSequencer({
      stateMachine: {
        transition: (event: string) => this.#stateMachine.transition(event as any),
      },
      agentPool: {
        drain: async () => {
          // MVP: no agents to drain
        },
        terminateAll: async () => {
          // MVP: no agents to terminate
        },
      },
      sessionManager: {
        persistAll: async () => {
          // MVP: no sessions to persist
        },
        flushAuditLog: async () => {
          // MVP: no audit log to flush
        },
      },
      pidFile: {
        remove: () => removePidFile(this.#config.pidFile),
      },
      eventEmitter: this,
    });

    // Transition to running state immediately (L1: prevent forgotten start())
    this.registerSignalHandlers();
    this.#stateMachine.transition('ready');
  }

  /**
   * Register signal handlers for graceful shutdown.
   * Handles SIGTERM and SIGINT (Ctrl+C).
   */
  private registerSignalHandlers(): void {
    const handleShutdown = (signal: NodeJS.Signals) => {
      console.log(`Received ${signal} - initiating graceful shutdown`);
      this.destroy({ force: false, reason: signal }).catch((err) => {
        console.error('Shutdown error:', err);
        process.exit(1);
      });
    };

    process.once('SIGTERM', handleShutdown);
    process.once('SIGINT', handleShutdown);

    this.#signalHandlers.push(handleShutdown);
  }

  /**
   * Cleanup signal handlers (for testing and destroy).
   */
  private cleanupSignalHandlers(): void {
    this.#signalHandlers.forEach((handler) => {
      process.off('SIGTERM', handler);
      process.off('SIGINT', handler);
    });
    this.#signalHandlers = [];
  }

  /**
   * Handle stdin-end event for non-daemon mode.
   * When stdin closes (e.g., Vim disconnects), trigger shutdown.
   */
  handleStdinEnd(): void {
    console.log('stdin closed - initiating auto-shutdown');
    this.destroy({ force: false, reason: 'stdin_end' }).catch((err) => {
      console.error('Shutdown error:', err);
      process.exit(1);
    });
  }

  get state() { return this.#stateMachine.state; }
  get uptime() { return this.#stateMachine.uptime; }
  get config() { return this.#config; }

  async createSession(): Promise<never> {
    throw new Error('Not implemented in this story');
  }

  getSession(): undefined {
    return undefined;
  }

  async closeSession(): Promise<void> {
    // no-op for MVP
  }

  createAgent(): never {
    throw new Error('Not implemented in this story');
  }

  getHealth(): EngineHealth {
    return {
      status: this.#stateMachine.isRunning ? 'ok' : 'down',
      sandboxAvailable: false,
      activeSessions: 0,
      activeAgents: 0,
    };
  }

  /**
   * Destroy the engine gracefully.
   * Can be called directly or via signal handler.
   * @param options - Shutdown options
   */
  async destroy(options?: Partial<ShutdownOptions>): Promise<void> {
    const shutdownOptions: ShutdownOptions = {
      force: options?.force ?? false,
      reason: options?.reason ?? 'manual',
      timeout: options?.timeout,
    };

    // Handle double signal - immediate exit
    if (this.#shutdownSequencer.isShuttingDown) {
      this.#shutdownSequencer.handleSecondSigterm();
      return; // unreachable due to exit()
    }

    this.#shutdownSequencer.markShutdownInProgress();

    try {
      await this.#shutdownSequencer.shutdown(shutdownOptions);
    } catch (err) {
      console.error('Engine destroy error:', err);
      throw err;
    } finally {
      this.cleanupSignalHandlers();
      clearInstance();
    }
  }
}

let instance: EngineImpl | undefined;

export function createEngine(config: EngineConfig): EngineAPI {
  if (instance) return instance;
  instance = new EngineImpl(config);
  return instance;
}

function clearInstance(): void {
  instance = undefined;
}

export function resetEngine(): void {
  instance = undefined;
}

export function getEngineInstance(): EngineImpl | undefined {
  return instance;
}
