// @zaivim/engine — Security Monitor Tests (Story 2.2, Task 7.6 / 7.7)
// Tests for security health monitoring, status changes, and notifications.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SecurityMonitor } from '../security/security-monitor.js';

describe('SecurityMonitor', () => {
  let monitor: SecurityMonitor;
  let changes: Array<{ from: string; to: string }> = [];

  beforeEach(() => {
    changes = [];
  });

  afterEach(() => {
    monitor?.shutdown();
  });

  describe('Health checks', () => {
    it('should return secure when all components healthy', async () => {
      monitor = new SecurityMonitor(async () => ({
        level: 'secure',
        sandboxAvailable: true,
        auditHealthy: true,
        classifierHealthy: true,
        auditBacklog: 0,
        lastChecked: Date.now(),
      }));

      const health = await monitor.getHealth();
      expect(health.level).toBe('secure');
      expect(health.sandboxAvailable).toBe(true);
    });

    it('should return degraded when sandbox unavailable', async () => {
      monitor = new SecurityMonitor(async () => ({
        level: 'degraded',
        sandboxAvailable: false,
        auditHealthy: true,
        classifierHealthy: true,
        auditBacklog: 0,
        lastChecked: Date.now(),
      }));

      const health = await monitor.getHealth();
      expect(health.level).toBe('degraded');
      expect(health.sandboxAvailable).toBe(false);
    });

    it('should return at-risk when audit unhealthy', async () => {
      monitor = new SecurityMonitor(async () => ({
        level: 'at-risk',
        sandboxAvailable: true,
        auditHealthy: false,
        classifierHealthy: true,
        auditBacklog: 500,
        lastChecked: Date.now(),
      }));

      const health = await monitor.getHealth();
      expect(health.level).toBe('at-risk');
      expect(health.auditHealthy).toBe(false);
    });
  });

  describe('Status change detection', () => {
    it('should detect secure → degraded transition', async () => {
      let isSecure = true;
      monitor = new SecurityMonitor(async () => {
        const level = isSecure ? 'secure' : 'degraded';
        return {
          level: level as 'secure' | 'degraded',
          sandboxAvailable: isSecure,
          auditHealthy: true,
          classifierHealthy: true,
          auditBacklog: 0,
          lastChecked: Date.now(),
        };
      });

      monitor.onChange((change) => {
        changes.push({ from: change.from, to: change.to });
      });

      await monitor.getHealth();
      isSecure = false;
      await monitor.refreshNow();

      // Wait for debounce
      await new Promise(r => setTimeout(r, 2500));

      expect(changes.length).toBeGreaterThanOrEqual(1);
      expect(changes[0]!.from).toBe('secure');
      expect(changes[0]!.to).toBe('degraded');
    }, 10000);
  });

  describe('Recent events cache (Task 5.5)', () => {
    it('should cache recent events for new client sync', async () => {
      monitor = new SecurityMonitor(async () => ({
        level: 'degraded',
        sandboxAvailable: false,
        auditHealthy: true,
        classifierHealthy: true,
        auditBacklog: 0,
        lastChecked: Date.now(),
      }));

      await monitor.getHealth();
      // Wait for debounce + notification
      await new Promise(r => setTimeout(r, 2500));

      const events = monitor.recentEvents;
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0]!.to).toBe('degraded');
    }, 10000);
  });

  describe('Health caching (30s TTL)', () => {
    it('should cache health result within TTL', async () => {
      let callCount = 0;
      monitor = new SecurityMonitor(async () => {
        callCount++;
        return {
          level: 'secure',
          sandboxAvailable: true,
          auditHealthy: true,
          classifierHealthy: true,
          auditBacklog: 0,
          lastChecked: Date.now(),
        };
      });

      // First call populates cache
      await monitor.getHealth();
      expect(callCount).toBe(1);

      // Second call within TTL should use cache
      await monitor.getHealth();
      expect(callCount).toBe(1);
    });
  });
});