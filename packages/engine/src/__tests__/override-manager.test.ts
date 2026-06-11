// @zaivim/engine — Override Manager Tests (Story 2.2, Task 7.2)
// Tests for user override mechanism covering normal, error, and edge cases.

import { describe, it, expect, beforeEach } from 'vitest';
import { OverrideManager } from '../security/override-manager.js';

describe('OverrideManager', () => {
  let manager: OverrideManager;

  beforeEach(() => {
    manager = new OverrideManager({
      maxRatePerMinute: 10, // Allow multiple in tests
      operationTtlMs: 5000, // 5 second TTL for quick expiry tests
    });
  });

  // ==========================================================================
  // Basic flow: record + override
  // ==========================================================================

  describe('Normal override flow', () => {
    it('should record a rejection and return operationId', () => {
      const opId = manager.recordRejection('session-1', 'S', 'rm -rf /', { harmLevel: 'S', reason: 'destructive command' });
      expect(opId).toBeTruthy();
      expect(typeof opId).toBe('string');
      expect(opId.length).toBeGreaterThan(10);
    });

    it('should grant override with valid acknowledgment', () => {
      const opId = manager.recordRejection('session-1', 'S', 'rm -rf /', { harmLevel: 'S', reason: 'destructive command' });
      const result = manager.requestOverride(opId, 'override rm -rf /', 'session-1');
      expect(result).toBe(true);
    });

    it('should track override statistics', () => {
      const opId = manager.recordRejection('session-1', 'A', 'write /etc/config', { harmLevel: 'A', reason: 'sensitive config' });
      manager.requestOverride(opId, 'override write /etc/config', 'session-1');
      const stats = manager.getStats();
      expect(stats.totalOverrides).toBe(1);
      expect(stats.totalAudits).toBe(1);
      expect(stats.overrideRatio).toBe(1);
    });

    it('should handle multiple independent overrides', { timeout: 15000 }, () => {
      const op1 = manager.recordRejection('s1', 'S', 'cmd1', { harmLevel: 'S', reason: 'r1' });
      const op2 = manager.recordRejection('s1', 'A', 'cmd2', { harmLevel: 'A', reason: 'r2' });
      const op3 = manager.recordRejection('s2', 'S', 'cmd3', { harmLevel: 'S', reason: 'r3' });

      expect(manager.requestOverride(op1, 'ack1', 's1')).toBe(true);
      expect(manager.requestOverride(op2, 'ack2', 's1')).toBe(true);
      expect(manager.requestOverride(op3, 'ack3', 's2')).toBe(true);

      const stats = manager.getStats();
      expect(stats.totalOverrides).toBe(3);
      expect(stats.pendingCount).toBe(0); // All consumed
    });
  });

  // ==========================================================================
  // Error cases
  // ==========================================================================

  describe('Error handling', () => {
    it('should reject override with empty acknowledgment (Subtask 2.3)', () => {
      const opId = manager.recordRejection('session-1', 'S', 'rm -rf /', { harmLevel: 'S', reason: 'destructive' });
      expect(() => manager.requestOverride(opId, '', 'session-1')).toThrow('Acknowledgment');
    });

    it('should reject override with whitespace-only acknowledgment', () => {
      const opId = manager.recordRejection('session-1', 'A', 'write /etc/config', { harmLevel: 'A', reason: 'sensitive' });
      expect(() => manager.requestOverride(opId, '   ', 'session-1')).toThrow('Acknowledgment');
    });

    it('should reject override with invalid operationId', () => {
      expect(() => manager.requestOverride('non-existent-id', 'ack', 'session-1')).toThrow('not found');
    });

    it('should reject override with mismatched sessionId (Subtask 2.1.2)', () => {
      const opId = manager.recordRejection('session-1', 'S', 'rm -rf /', { harmLevel: 'S', reason: 'destructive' });
      expect(() => manager.requestOverride(opId, 'ack', 'session-2')).toThrow('session does not match');
    });

    it('should reject expired operations (Subtask 2.2.2)', { timeout: 10000 }, async () => {
      const opId = manager.recordRejection('session-1', 'S', 'rm -rf /', { harmLevel: 'S', reason: 'destructive' });

      // Wait for TTL to expire
      await new Promise(r => setTimeout(r, 5100));

      expect(() => manager.requestOverride(opId, 'ack', 'session-1')).toThrow('expired');
    });

    it('should reject duplicate overrides of the same operation', () => {
      const opId = manager.recordRejection('session-1', 'S', 'rm -rf /', { harmLevel: 'S', reason: 'destructive' });
      manager.requestOverride(opId, 'first ack', 'session-1');
      expect(() => manager.requestOverride(opId, 'second ack', 'session-1')).toThrow('not found');
    });
  });

  // ==========================================================================
  // Rate limiting (Subtask 2.5)
  // ==========================================================================

  describe('Rate limiting', () => {
    it('should reject overrides exceeding rate limit', () => {
      const strictManager = new OverrideManager({ maxRatePerMinute: 2, operationTtlMs: 60000 });

      const ops = [];
      for (let i = 0; i < 3; i++) {
        ops.push(strictManager.recordRejection(`session-${i}`, 'S', `cmd-${i}`, { harmLevel: 'S', reason: 'test' }));
      }

      // First 2 should succeed
      expect(strictManager.requestOverride(ops[0]!, 'ack 0', 'session-0')).toBe(true);
      expect(strictManager.requestOverride(ops[1]!, 'ack 1', 'session-1')).toBe(true);

      // Third should fail rate limit
      expect(() => strictManager.requestOverride(ops[2]!, 'ack 2', 'session-2')).toThrow('rate limit');
    });
  });

  // ==========================================================================
  // Input sanitization (Subtask 2.7)
  // ==========================================================================

  describe('Input sanitization', () => {
    it('should strip newlines and null characters from acknowledgment', () => {
      const opId = manager.recordRejection('session-1', 'S', 'rm -rf /', { harmLevel: 'S', reason: 'destructive' });
      const result = manager.requestOverride(opId, 'override\nrm\r\n\0test', 'session-1');
      expect(result).toBe(true);
    });
  });

  // ==========================================================================
  // Progressive delay (Subtask 2.6)
  // ==========================================================================

  // ==========================================================================
  // Performance: override response latency (Task 7.8)
  // ==========================================================================

  describe('Override performance (Task 7.8)', () => {
    it('should complete normal override within 50ms', () => {
      const perfManager = new OverrideManager({ maxRatePerMinute: 100, operationTtlMs: 60000, delayProgression: [0, 0, 0, 0, 0] });
      const opId = perfManager.recordRejection('session-1', 'S', 'test-cmd', { harmLevel: 'S', reason: 'test' });

      const start = performance.now();
      perfManager.requestOverride(opId, 'acknowledge test override', 'session-1');
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(50);
    });
  });

  describe('Progressive delay', () => {
    it('should increase delay index after consecutive overrides', () => {
      const ops = [];
      for (let i = 0; i < 4; i++) {
        ops.push(manager.recordRejection('session-1', 'S', `cmd-${i}`, { harmLevel: 'S', reason: 'test' }));
      }

      // First override: delay index 0
      manager.requestOverride(ops[0]!, 'ack 0', 'session-1');
      expect(manager.currentDelayIndex).toBeGreaterThanOrEqual(1);

      // Second override: requires "I CONFIRM" (Task 4.4 warning fatigue)
      manager.requestOverride(ops[1]!, 'ack 1 I CONFIRM', 'session-1');
      expect(manager.currentDelayIndex).toBeGreaterThanOrEqual(2);
    });
  });
});
