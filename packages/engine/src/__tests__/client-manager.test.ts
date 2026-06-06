// @zaivim/engine — ClientManager unit tests
// Tests: register/unregister, broadcast, disconnect cleanup

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventBus } from '../events/event-bus.js';
import { ClientManager } from '../events/client-manager.js';
import type { ClientConnection } from '../events/client-manager.js';

describe('ClientManager', () => {
  let eventBus: EventBus;
  let manager: ClientManager;

  beforeEach(() => {
    eventBus = new EventBus();
    manager = new ClientManager(eventBus);
  });

  describe('client registration', () => {
    it('registers a client and returns its ID', () => {
      const client = createMockClient('client-1');
      manager.register(client);
      expect(manager.connectedCount).toBe(1);
    });

    it('unregisters a client by ID', () => {
      const client = createMockClient('client-1');
      manager.register(client);
      manager.unregister('client-1');
      expect(manager.connectedCount).toBe(0);
    });

    it('generates unique client IDs', () => {
      const id1 = manager.generateId();
      const id2 = manager.generateId();
      expect(id1).not.toBe(id2);
    });

    it('refuses duplicate registration of active client', () => {
      const client1 = createMockClient('dup-1');
      manager.register(client1);

      const client2 = createMockClient('dup-1'); // same ID, alive
      expect(() => manager.register(client2)).toThrow(/already registered/);
    });
  });

  describe('broadcast', () => {
    it('broadcasts event to all connected clients', () => {
      const client1 = createMockClient('client-1');
      const client2 = createMockClient('client-2');
      manager.register(client1);
      manager.register(client2);

      manager.broadcast('session.created', { sessionId: 'sess-1' });

      expect(client1.sendEvent).toHaveBeenCalledWith('session.created', { sessionId: 'sess-1' });
      expect(client2.sendEvent).toHaveBeenCalledWith('session.created', { sessionId: 'sess-1' });
    });

    it('only broadcasts to alive clients', () => {
      const aliveClient = createMockClient('alive-1', true);
      const deadClient = createMockClient('dead-1', false);
      manager.register(aliveClient);
      manager.register(deadClient);

      manager.broadcast('session.closed', { sessionId: 'sess-2' });

      expect(aliveClient.sendEvent).toHaveBeenCalled();
      expect(deadClient.sendEvent).not.toHaveBeenCalled();
    });

    it('handles no clients gracefully', () => {
      expect(() => {
        manager.broadcast('session.created', { sessionId: 'sess-3' });
      }).not.toThrow();
    });
  });

  describe('sendTo', () => {
    it('sends event to specific client', () => {
      const client1 = createMockClient('client-1');
      const client2 = createMockClient('client-2');
      manager.register(client1);
      manager.register(client2);

      const sent = manager.sendTo('client-1', 'session.created', { sessionId: 'sess-4' });

      expect(sent).toBe(true);
      expect(client1.sendEvent).toHaveBeenCalled();
      expect(client2.sendEvent).not.toHaveBeenCalled();
    });

    it('returns false for non-existent client', () => {
      const sent = manager.sendTo('nonexistent', 'session.created', { sessionId: 'sess-5' });
      expect(sent).toBe(false);
    });
  });

  describe('disconnect and cleanup', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('handles disconnect with cleanup timer', () => {
      const client = createMockClient('client-disc');
      manager.register(client);
      expect(manager.connectedCount).toBe(1);

      manager.handleDisconnect('client-disc');

      // Client should still be connected immediately after disconnect
      expect(manager.connectedCount).toBe(1);

      // After cleanup delay, client should be removed
      vi.advanceTimersByTime(5000);

      // The setTimeout callback removes the client from the map
      // But since we're using fake timers, the callback hasn't actually fired
      // Let's advance all timers and check
      vi.runAllTimers();

      expect(manager.connectedCount).toBe(0);
    });

    it('cancels pending cleanup on re-registration', () => {
      const oldClient = createMockClient('client-re');
      manager.register(oldClient);
      manager.handleDisconnect('client-re');

      // Mark old client as dead before reconnect
      Object.defineProperty(oldClient, 'isAlive', { get: () => false });

      // Re-register with same ID (old client is dead, reconnect allowed)
      const newClient = createMockClient('client-re');
      manager.register(newClient);

      // Advance past cleanup delay
      vi.advanceTimersByTime(5000);
      vi.runAllTimers();

      // Client should still be registered (reconnect cancelled cleanup)
      expect(manager.connectedCount).toBe(1);
    });
  });

  describe('disconnectAll', () => {
    it('disconnects all clients and clears state', () => {
      const client1 = createMockClient('client-1');
      const client2 = createMockClient('client-2');
      manager.register(client1);
      manager.register(client2);

      manager.disconnectAll();

      expect(manager.connectedCount).toBe(0);
      expect(client1.disconnect).toHaveBeenCalled();
      expect(client2.disconnect).toHaveBeenCalled();
    });

    it('cancels all cleanup timers', () => {
      const client = createMockClient('client-1');
      manager.register(client);
      manager.handleDisconnect('client-1');

      manager.cancelAllCleanupTimers();

      // After cancellation, disconnectAll works
      manager.disconnectAll();
      expect(manager.connectedCount).toBe(0);
    });
  });

  describe('query methods', () => {
    it('getClient returns registered client', () => {
      const client = createMockClient('client-1');
      manager.register(client);
      expect(manager.getClient('client-1')).toBe(client);
    });

    it('getClient returns undefined for unknown', () => {
      expect(manager.getClient('nonexistent')).toBeUndefined();
    });

    it('getClientIds returns all IDs', () => {
      manager.register(createMockClient('a'));
      manager.register(createMockClient('b'));
      const ids = manager.getClientIds();
      expect(ids).toContain('a');
      expect(ids).toContain('b');
      expect(ids).toHaveLength(2);
    });
  });
});

/**
 * Create a mock client connection for testing.
 */
function createMockClient(id: string, alive = true): ClientConnection {
  return {
    id,
    sendEvent: vi.fn(),
    get isAlive() { return alive; },
    disconnect: vi.fn(),
  };
}
