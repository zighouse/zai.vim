// @zaivim/gateway — Transport context aggregating EventBus + ClientManager + ACL
// This is the shared context passed from engine startup to the transport layer.

import type { EventBus, ClientManager } from '@zaivim/engine';
import { MethodACL, readAdminToken } from '../method-acl.js';

export interface TransportContextOptions {
  eventBus: EventBus;
  clientManager: ClientManager;
  acl?: MethodACL;
}

/**
 * TransportContext wires together EventBus, ClientManager, and ACL.
 * Event forwarding is handled by the transport layer directly.
 */
export class TransportContext {
  readonly eventBus: EventBus;
  readonly clientManager: ClientManager;
  readonly acl: MethodACL;
  readonly adminToken: string | undefined;

  constructor(options: TransportContextOptions) {
    this.eventBus = options.eventBus;
    this.clientManager = options.clientManager;
    this.acl = options.acl ?? MethodACL.createDefault();
    this.adminToken = readAdminToken();
  }

  /**
   * Clean up all resources.
   */
  dispose(): void {
    this.clientManager.disconnectAll();
  }
}
