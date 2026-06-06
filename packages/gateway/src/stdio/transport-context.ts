// @zaivim/gateway — Transport context aggregating EventBus + ClientManager + ACL
// This is the shared context passed from engine startup to the transport layer.

import type { EventBus, ClientManager } from '@zaivim/engine';
import { MethodACL, readAdminToken } from '../method-acl.js';
import { encodeNotification } from './notification-sender.js';
import type { EngineEventType } from '@zaivim/core';

export interface TransportContextOptions {
  eventBus: EventBus;
  clientManager: ClientManager;
  acl?: MethodACL;
}

/**
 * TransportContext wires together EventBus, ClientManager, and ACL.
 * It connects engine events to client notifications and provides auth.
 */
export class TransportContext {
  readonly eventBus: EventBus;
  readonly clientManager: ClientManager;
  readonly acl: MethodACL;
  readonly adminToken: string | undefined;

  /** Disposers for EventBus listeners, called on cleanup. */
  readonly #disposers: Array<() => void> = [];

  constructor(options: TransportContextOptions) {
    this.eventBus = options.eventBus;
    this.clientManager = options.clientManager;
    this.acl = options.acl ?? MethodACL.createDefault();
    this.adminToken = readAdminToken();
  }

  /**
   * Start forwarding engine events to client notifications.
   * Each registered client receives $/notification events.
   */
  startEventForwarding(): void {
    const eventTypes: EngineEventType[] = [
      'session.created',
      'session.closed',
      'security.degraded',
      'engine.warning',
      'engine.shutdown',
    ];

    for (const type of eventTypes) {
      const dispose = this.eventBus.on(type, (data) => {
        const notification = encodeNotification(type, data);
        this.clientManager.broadcast(type, data);
        // Also write to transport output (handled by transport's own listener)
      });
      this.#disposers.push(dispose);
    }
  }

  /**
   * Clean up all resources.
   */
  dispose(): void {
    for (const dispose of this.#disposers) {
      dispose();
    }
    this.#disposers.length = 0;
    this.clientManager.disconnectAll();
  }
}
