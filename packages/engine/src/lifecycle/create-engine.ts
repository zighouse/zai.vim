// @zaivim/engine — createEngine() singleton factory
// MVP: global singleton. Second call returns existing instance.

import type { EngineAPI, EngineConfig, EngineHealth } from '@zaivim/core';
import { EngineStateMachine } from './state-machine.js';

export class EngineImpl implements EngineAPI {
  readonly version: string;
  readonly #stateMachine: EngineStateMachine;
  readonly #config: EngineConfig;

  constructor(config: EngineConfig) {
    this.version = config.version;
    this.#config = config;
    this.#stateMachine = new EngineStateMachine();
  }

  /** Transition to running state — called by createEngine after construction */
  start(): void {
    this.#stateMachine.transition('ready');
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

  async destroy(): Promise<void> {
    this.#stateMachine.transition('drain');
    this.#stateMachine.transition('shutdown');
    this.#stateMachine.transition('terminate');
    clearInstance();
  }
}

let instance: EngineImpl | undefined;

export function createEngine(config: EngineConfig): EngineAPI {
  if (instance) return instance;
  instance = new EngineImpl(config);
  instance.start();
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
