// @zaivim/engine — Engine state machine
// 6 states: starting → running → degraded → draining → shutting_down → terminated
// All invalid transitions throw.

import type { EngineState } from '@zaivim/core';

export type EngineTransition =
  | 'ready'       // starting → running
  | 'degrade'     // running → degraded
  | 'recover'     // degraded → running
  | 'drain'       // running/degraded → draining
  | 'shutdown'    // draining → shutting_down
  | 'terminate'   // shutting_down → terminated
  | 'kill';       // any → terminated (force)

const TRANSITIONS: ReadonlyMap<EngineState, ReadonlyMap<EngineTransition, EngineState>> = new Map([
  ['starting', new Map([
    ['ready', 'running'],
    ['kill', 'terminated'],
  ])],
  ['running', new Map([
    ['degrade', 'degraded'],
    ['drain', 'draining'],
    ['kill', 'terminated'],
  ])],
  ['degraded', new Map([
    ['recover', 'running'],
    ['drain', 'draining'],
    ['kill', 'terminated'],
  ])],
  ['draining', new Map([
    ['shutdown', 'shutting_down'],
    ['kill', 'terminated'],
  ])],
  ['shutting_down', new Map([
    ['terminate', 'terminated'],
    ['kill', 'terminated'],
  ])],
  ['terminated', new Map()],
]);

export class EngineStateMachine {
  #state: EngineState;
  #startedAt: number;

  constructor() {
    this.#state = 'starting';
    this.#startedAt = Date.now();
  }

  transition(event: EngineTransition): EngineState {
    const validTargets = TRANSITIONS.get(this.#state);
    if (!validTargets) {
      throw new Error(`Engine state machine corrupted: unknown state "${this.#state}"`);
    }

    const next = validTargets.get(event);
    if (!next) {
      throw new Error(
        `Invalid engine transition: "${this.#state}" + "${event}". ` +
        `Allowed: [${[...validTargets.keys()].join(', ')}]`,
      );
    }

    this.#state = next;
    return this.#state;
  }

  get state(): EngineState { return this.#state; }

  get startedAt(): number { return this.#startedAt; }

  get uptime(): number { return Date.now() - this.#startedAt; }

  get isTerminal(): boolean { return this.#state === 'terminated'; }

  get isRunning(): boolean { return this.#state === 'running' || this.#state === 'degraded'; }
}
