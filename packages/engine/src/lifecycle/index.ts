// @zaivim/engine — Lifecycle state machine
// Agent lifecycle states: idle → running → waiting_tool → done / error / cancelled
// Class-encapsulated: private state, public transition() — cannot bypass (P7 defense).

export type AgentLifecycleState = 'idle' | 'running' | 'waiting_tool' | 'done' | 'error' | 'cancelled';

export type LifecycleEvent =
  | 'start'
  | 'tool_call'
  | 'tool_result'
  | 'finish'
  | 'error'
  | 'cancel';

const TRANSITIONS: ReadonlyMap<AgentLifecycleState, ReadonlyMap<LifecycleEvent, AgentLifecycleState>> = new Map([
  ['idle', new Map([['start', 'running'], ['cancel', 'cancelled']])],
  ['running', new Map([['tool_call', 'waiting_tool'], ['finish', 'done'], ['error', 'error'], ['cancel', 'cancelled']])],
  ['waiting_tool', new Map([['tool_result', 'running'], ['error', 'error'], ['cancel', 'cancelled']])],
  ['done', new Map()],
  ['error', new Map()],
  ['cancelled', new Map()],
]);

export class LifecycleStateMachine {
  #state: AgentLifecycleState;

  constructor(initial?: AgentLifecycleState) {
    this.#state = initial ?? 'idle';
  }

  /**
   * Transition to next state. Returns the new state or throws if invalid.
   * Private #state cannot be read directly — only through state getter.
   */
  transition(event: LifecycleEvent): AgentLifecycleState {
    const validEvents = TRANSITIONS.get(this.#state);
    if (!validEvents) {
      throw new Error(`State machine corrupted: unknown state "${this.#state}"`);
    }

    const next = validEvents.get(event);
    if (!next) {
      throw new Error(
        `Invalid transition: "${this.#state}" + "${event}". ` +
        `Allowed: [${[...validEvents.keys()].join(', ')}]`,
      );
    }

    this.#state = next;
    return this.#state;
  }

  /** Read-only accessor — cannot bypass transition. */
  get state(): AgentLifecycleState {
    return this.#state;
  }

  get isTerminal(): boolean {
    return this.#state === 'done' || this.#state === 'error' || this.#state === 'cancelled';
  }
}
