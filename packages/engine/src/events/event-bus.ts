// @zaivim/engine — EventBus wrapping Node.js EventEmitter
// Provides emit(event) + on(event, handler) + off(event, handler)
// All events are typed via EngineEventMap.

import { EventEmitter } from 'node:events';
import type { EngineEventType, EngineEventData } from '@zaivim/core';

const DEFAULT_LISTENER_WARN_THRESHOLD = 1000;

export class EventBus {
  readonly #emitter = new EventEmitter();
  readonly #warnThreshold: number;

  constructor(warnThreshold: number = DEFAULT_LISTENER_WARN_THRESHOLD) {
    this.#emitter.setMaxListeners(0); // We manage our own limits
    this.#warnThreshold = warnThreshold;
  }

  /**
   * Emit an engine event. All registered listeners receive the data.
   */
  emit<T extends EngineEventType>(type: T, data: EngineEventData<T>): void {
    this.#emitter.emit(type, data);

    // Check for listener leaks after emit
    const count = this.#emitter.listenerCount(type);
    if (count > this.#warnThreshold) {
      this.#emitter.emit('engine.warning', {
        message: `Listener count for '${type}' exceeded threshold: ${count} > ${this.#warnThreshold}`,
        data: { type, count, threshold: this.#warnThreshold },
      });
    }
  }

  /**
   * Register an event listener.
   * Returns a dispose function for easy cleanup.
   */
  on<T extends EngineEventType>(type: T, handler: (data: EngineEventData<T>) => void): () => void {
    this.#emitter.on(type, handler);
    return () => this.off(type, handler);
  }

  /**
   * Remove a specific event listener.
   */
  off<T extends EngineEventType>(type: T, handler: (data: EngineEventData<T>) => void): void {
    this.#emitter.off(type, handler);
  }

  /**
   * Remove all listeners for a specific event type.
   */
  removeAllListeners(type?: EngineEventType): void {
    if (type) {
      this.#emitter.removeAllListeners(type);
    } else {
      this.#emitter.removeAllListeners();
    }
  }

  /**
   * Get the number of registered listeners for a given event type.
   */
  listenerCount(type: EngineEventType): number {
    return this.#emitter.listenerCount(type);
  }

  /**
   * Get total active listener count across all event types.
   */
  get totalActiveListeners(): number {
    // Known event types we track
    const types: EngineEventType[] = [
      'session.created',
      'session.closed',
      'security.degraded',
      'engine.warning',
      'engine.shutdown',
    ];
    return types.reduce((sum, t) => sum + this.#emitter.listenerCount(t), 0);
  }
}
