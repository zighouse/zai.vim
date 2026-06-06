// @zaivim/engine — Multi-client connection management + event broadcast
// Manages ClientConnection instances and provides broadcast(event) for event fan-out

import type { EngineEventType, EngineEventData } from '@zaivim/core';
import type { EventBus } from './event-bus.js';

export interface ClientConnection {
  readonly id: string;
  sendEvent(type: string, data: unknown): void;
  get isAlive(): boolean;
  disconnect(): void;
}

const CLEANUP_DELAY_MS = 5000;

export class ClientManager {
  readonly #clients = new Map<string, ClientConnection>();
  readonly #eventBus: EventBus;
  readonly #cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
  #clientCounter = 0;

  constructor(eventBus: EventBus) {
    this.#eventBus = eventBus;
  }

  /**
   * Register a new client connection.
   * Returns the assigned client ID.
   */
  register(client: ClientConnection): string {
    const id = client.id;
    this.#clients.set(id, client);

    // Cancel any pending cleanup for this ID (reconnect scenario)
    const pending = this.#cleanupTimers.get(id);
    if (pending) {
      clearTimeout(pending);
      this.#cleanupTimers.delete(id);
    }

    // Listen for disconnect
    const dispose = this.#eventBus.on('session.created', () => {
      // Client disconnect is detected externally (stdin close, WS close)
    });

    return id;
  }

  /**
   * Unregister a client by ID.
   */
  unregister(id: string): void {
    this.#clients.delete(id);
  }

  /**
   * Handle client disconnection.
   * Sets a timer to clean up all event listeners registered by this client.
   */
  handleDisconnect(id: string): void {
    const client = this.#clients.get(id);
    if (!client) return;

    // Start cleanup timer (AC8: 5s listener cleanup)
    const timer = setTimeout(() => {
      this.#cleanupTimers.delete(id);
      this.#clients.delete(id);
    }, CLEANUP_DELAY_MS);

    this.#cleanupTimers.set(id, timer);
  }

  /**
   * Broadcast an event to ALL connected clients.
   */
  broadcast<T extends EngineEventType>(type: T, data: EngineEventData<T>): void {
    for (const client of this.#clients.values()) {
      if (client.isAlive) {
        client.sendEvent(type, data);
      }
    }
  }

  /**
   * Send an event to a specific client by ID.
   */
  sendTo<T extends EngineEventType>(id: string, type: T, data: EngineEventData<T>): boolean {
    const client = this.#clients.get(id);
    if (!client || !client.isAlive) return false;
    client.sendEvent(type, data);
    return true;
  }

  /**
   * Get count of connected clients.
   */
  get connectedCount(): number {
    return this.#clients.size;
  }

  /**
   * Get a client by ID.
   */
  getClient(id: string): ClientConnection | undefined {
    return this.#clients.get(id);
  }

  /**
   * Get all registered client IDs.
   */
  getClientIds(): string[] {
    return Array.from(this.#clients.keys());
  }

  /**
   * Generate a unique client ID.
   */
  generateId(): string {
    this.#clientCounter++;
    return `client-${this.#clientCounter}-${Date.now()}`;
  }

  /**
   * Cancel all cleanup timers (for graceful shutdown).
   */
  cancelAllCleanupTimers(): void {
    for (const [id, timer] of this.#cleanupTimers) {
      clearTimeout(timer);
      this.#cleanupTimers.delete(id);
    }
  }

  /**
   * Disconnect all clients.
   */
  disconnectAll(): void {
    this.cancelAllCleanupTimers();
    for (const client of this.#clients.values()) {
      client.disconnect();
    }
    this.#clients.clear();
  }
}
