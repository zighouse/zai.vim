// @zaivim/engine — EventBus unit tests
// Tests: emit/on/off cycle, multi-listener broadcast, listener count warning

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventBus } from '../events/event-bus.js';

describe('EventBus', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus(5); // Low threshold for testing
  });

  describe('basic emit/on', () => {
    it('emits event to registered listener', () => {
      const handler = vi.fn();
      bus.on('session.created', handler);
      bus.emit('session.created', { sessionId: 'sess-1' });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith({ sessionId: 'sess-1' });
    });

    it('emits correct data to multiple listeners', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      bus.on('session.created', handler1);
      bus.on('session.created', handler2);

      bus.emit('session.created', { sessionId: 'sess-2' });

      expect(handler1).toHaveBeenCalledWith({ sessionId: 'sess-2' });
      expect(handler2).toHaveBeenCalledWith({ sessionId: 'sess-2' });
    });

    it('does not emit to listeners of different event types', () => {
      const handler = vi.fn();
      bus.on('session.created', handler);
      bus.emit('session.closed', { sessionId: 'sess-3' });

      expect(handler).not.toHaveBeenCalled();
    });

    it('does not emit after off', () => {
      const handler = vi.fn();
      const dispose = bus.on('session.created', handler);
      dispose();
      bus.emit('session.created', { sessionId: 'sess-4' });

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('off', () => {
    it('removes specific listener while keeping others', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      bus.on('session.created', handler1);
      bus.on('session.created', handler2);

      bus.off('session.created', handler1);
      bus.emit('session.created', { sessionId: 'sess-5' });

      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).toHaveBeenCalledTimes(1);
    });
  });

  describe('removeAllListeners', () => {
    it('removes all listeners for a specific event type', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      bus.on('session.created', handler1);
      bus.on('session.created', handler2);

      bus.removeAllListeners('session.created');
      bus.emit('session.created', { sessionId: 'sess-6' });

      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).not.toHaveBeenCalled();
    });

    it('removes all listeners when called without type', () => {
      bus.on('session.created', vi.fn());
      bus.on('session.closed', vi.fn());
      bus.removeAllListeners();

      expect(bus.listenerCount('session.created')).toBe(0);
      expect(bus.listenerCount('session.closed')).toBe(0);
    });
  });

  describe('listener counting', () => {
    it('reports correct listener count', () => {
      expect(bus.listenerCount('session.created')).toBe(0);

      bus.on('session.created', vi.fn());
      expect(bus.listenerCount('session.created')).toBe(1);

      bus.on('session.created', vi.fn());
      expect(bus.listenerCount('session.created')).toBe(2);
    });

    it('totalActiveListeners returns sum across all types', () => {
      expect(bus.totalActiveListeners).toBe(0);

      bus.on('session.created', vi.fn());
      bus.on('session.closed', vi.fn());
      bus.on('session.closed', vi.fn());

      expect(bus.totalActiveListeners).toBe(3);
    });
  });

  describe('listener warning threshold', () => {
    it('emits engine.warning when listener count exceeds threshold', () => {
      const warningHandler = vi.fn();
      bus.on('engine.warning', warningHandler);

      // Register enough listeners to exceed threshold (5)
      for (let i = 0; i < 6; i++) {
        bus.on('session.created', vi.fn());
      }

      // Emit to trigger the warning check
      bus.emit('session.created', { sessionId: 'sess-warn' });

      expect(warningHandler).toHaveBeenCalledTimes(1);
      const warningData = warningHandler.mock.calls[0][0];
      expect(warningData.message).toContain('session.created');
      expect(warningData.data.count).toBeGreaterThanOrEqual(6);
    });

    it('does not emit warning when under threshold', () => {
      const warningHandler = vi.fn();
      bus.on('engine.warning', warningHandler);

      // Register fewer than threshold
      for (let i = 0; i < 3; i++) {
        bus.on('session.created', vi.fn());
      }

      bus.emit('session.created', { sessionId: 'sess-ok' });

      expect(warningHandler).not.toHaveBeenCalled();
    });
  });

  describe('edge cases', () => {
    it('handles no listeners gracefully', () => {
      expect(() => {
        bus.emit('session.created', { sessionId: 'sess-7' });
      }).not.toThrow();
    });

    it('handles multiple event types simultaneously', () => {
      const createdHandler = vi.fn();
      const closedHandler = vi.fn();

      bus.on('session.created', createdHandler);
      bus.on('session.closed', closedHandler);

      bus.emit('session.created', { sessionId: 'sess-8' });
      bus.emit('session.closed', { sessionId: 'sess-8' });

      expect(createdHandler).toHaveBeenCalledTimes(1);
      expect(closedHandler).toHaveBeenCalledTimes(1);
    });
  });
});
