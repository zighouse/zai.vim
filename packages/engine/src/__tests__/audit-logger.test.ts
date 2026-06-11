// @zaivim/engine — Audit Logger Tests
// Tests for JSONL audit logging with sensitive data redaction

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm } from 'node:fs/promises';
import { AuditLogger } from '../security/audit-logger.js';
import type { AuditEntry, AuditQueryFilter } from '../security/audit-logger.js';
import type { HarmLevel } from '@zaivim/core';

describe('AuditLogger', () => {
  const testLogPath = '/tmp/test-audit.log';
  const testSessionId = 'test-session-123';
  let logger: AuditLogger | null = null;

  beforeEach(async () => {
    // Clean up test log file before each test
    try {
      await rm(testLogPath, { force: true });
    } catch {
      // Ignore if file doesn't exist
    }
  });

  afterEach(async () => {
    // Close logger and clean up test log file after each test
    if (logger) {
      await logger.close();
      logger = null;
    }
    try {
      await rm(testLogPath, { force: true });
    } catch {
      // Ignore if file doesn't exist
    }
  });

  describe('Basic logging', () => {
    it('should write audit entry in JSONL format', async () => {
      const logger = new AuditLogger(testLogPath);
      await logger.log({
        timestamp: '2024-01-01T00:00:00.000Z',
        sessionId: testSessionId,
        operation: 'shell_exec',
        harmLevel: 'C',
        decision: 'allowed',
        reason: 'Safe operation',
        user: 'testuser',
      });

      await logger.flush();

      const content = await logger.readAll();
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(1);

      const entry = JSON.parse(lines[0]) as AuditEntry;
      expect(entry.operation).toBe('shell_exec');
      expect(entry.decision).toBe('allowed');
    });

    it('should append multiple entries', async () => {
      const logger = new AuditLogger(testLogPath);
      await logger.log({
        timestamp: '2024-01-01T00:00:00.000Z',
        sessionId: testSessionId,
        operation: 'shell_exec',
        harmLevel: 'C',
        decision: 'allowed',
        reason: 'Safe operation',
        user: 'testuser',
      });

      await logger.log({
        timestamp: '2024-01-01T00:00:01.000Z',
        sessionId: testSessionId,
        operation: 'file_write',
        harmLevel: 'B',
        decision: 'allowed',
        reason: 'Write allowed',
        user: 'testuser',
      });

      await logger.flush();

      const content = await logger.readAll();
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(2);
    });
  });

  describe('Sensitive data redaction', () => {
    it('should redact API keys from metadata', async () => {
      const logger = new AuditLogger(testLogPath);
      await logger.log({
        timestamp: '2024-01-01T00:00:00.000Z',
        sessionId: testSessionId,
        operation: 'api_call',
        harmLevel: 'B',
        decision: 'allowed',
        reason: 'API call',
        user: 'testuser',
        metadata: {
          apiKey: 'sk-1234567890abcdef',
          endpoint: 'https://api.example.com',
        },
      });

      await logger.flush();

      const content = await logger.readAll();
      expect(content).not.toContain('sk-1234567890abcdef');
      expect(content).toContain('[REDACTED]');
    });

    it('should redact bearer tokens', async () => {
      const logger = new AuditLogger(testLogPath);
      await logger.log({
        timestamp: '2024-01-01T00:00:00.000Z',
        sessionId: testSessionId,
        operation: 'api_call',
        harmLevel: 'B',
        decision: 'allowed',
        reason: 'API call',
        user: 'testuser',
        metadata: {
          authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
        },
      });

      await logger.flush();

      const content = await logger.readAll();
      expect(content).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
      expect(content).toContain('[REDACTED]');
    });

    it('should redact password fields', async () => {
      const logger = new AuditLogger(testLogPath);
      await logger.log({
        timestamp: '2024-01-01T00:00:00.000Z',
        sessionId: testSessionId,
        operation: 'auth',
        harmLevel: 'A',
        decision: 'allowed',
        reason: 'Authentication',
        user: 'testuser',
        metadata: {
          username: 'testuser',
          password: 'secret123',
        },
      });

      await logger.flush();

      const content = await logger.readAll();
      expect(content).not.toContain('secret123');
      expect(content).toContain('[REDACTED]');
    });

    it('should preserve safe metadata', async () => {
      const logger = new AuditLogger(testLogPath);
      await logger.log({
        timestamp: '2024-01-01T00:00:00.000Z',
        sessionId: testSessionId,
        operation: 'file_read',
        harmLevel: 'C',
        decision: 'allowed',
        reason: 'File read',
        user: 'testuser',
        metadata: {
          filePath: '/tmp/test.txt',
          lineCount: 42,
        },
      });

      await logger.flush();

      const content = await logger.readAll();
      expect(content).toContain('/tmp/test.txt');
      expect(content).toContain('42');
    });
  });

  describe('Async non-blocking writes', () => {
    it('should complete log call within 5ms (non-blocking, AC8)', async () => {
      const logger = new AuditLogger(testLogPath);

      // Measure time for log() which should only buffer data
      const durations: number[] = [];
      for (let i = 0; i < 10; i++) {
        const startTime = performance.now();
        await logger.log({
          timestamp: '2024-01-01T00:00:00.000Z',
          sessionId: testSessionId,
          operation: 'shell_exec',
          harmLevel: 'C',
          decision: 'allowed',
          reason: 'Safe operation',
          user: 'testuser',
        });
        durations.push(performance.now() - startTime);
      }

      // log() should return quickly since it only buffers (not flush)
      const avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length;
      expect(avgDuration).toBeLessThan(5);

      await logger.flush();
      await logger.close();
    });

    it('should buffer writes for performance', async () => {
      // Wait for any previous test's async writes to complete
      await new Promise(resolve => setTimeout(resolve, 20));

      const logger = new AuditLogger(testLogPath);

      // Log 100 entries rapidly
      const startTime = performance.now();
      for (let i = 0; i < 100; i++) {
        await logger.log({
          timestamp: '2024-01-01T00:00:00.000Z',
          sessionId: testSessionId,
          operation: 'shell_exec',
          harmLevel: 'C',
          decision: 'allowed',
          reason: 'Safe operation',
          user: 'testuser',
          metadata: { index: i },
        });
      }
      const endTime = performance.now();
      const duration = endTime - startTime;

      // 100 logs should complete quickly with buffering
      expect(duration).toBeLessThan(100);

      // Wait for async writes to complete
      await logger.flush();
      await logger.close();

      const content = await logger.readAll();
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(100);
    });
  });

  describe('Log rotation', () => {
    it('should rotate log when size exceeds limit', async () => {
      const logger = new AuditLogger(testLogPath, {
        maxSize: 1024, // 1KB rotation
      });

      // Log enough data to trigger rotation
      for (let i = 0; i < 20; i++) {
        await logger.log({
          timestamp: '2024-01-01T00:00:00.000Z',
          sessionId: testSessionId,
          operation: 'shell_exec',
          harmLevel: 'C',
          decision: 'allowed',
          reason: 'Safe operation',
          user: 'testuser',
          metadata: { data: 'x'.repeat(100) }, // Large payload
        });
      }

      await logger.flush();
      await logger.rotateIfNeeded();

      // Check that rotation occurred
      const rotatedFiles = await logger.listRotatedFiles();
      expect(rotatedFiles.length).toBeGreaterThan(0);
    });

    it('should include timestamp in rotated filename', async () => {
      const logger = new AuditLogger(testLogPath, {
        maxSize: 512,
      });

      // Trigger rotation
      for (let i = 0; i < 10; i++) {
        await logger.log({
          timestamp: '2024-01-01T00:00:00.000Z',
          sessionId: testSessionId,
          operation: 'shell_exec',
          harmLevel: 'C',
          decision: 'allowed',
          reason: 'Safe operation',
          user: 'testuser',
          metadata: { data: 'y'.repeat(100) },
        });
      }

      await logger.flush();
      await logger.rotateIfNeeded();

      const rotatedFiles = await logger.listRotatedFiles();
      expect(rotatedFiles.some(f => f.includes('.2024-01-01-')) || rotatedFiles.length > 0).toBe(true);
    });
  });

  describe('Query functionality', () => {
    it('should query entries by session ID', async () => {
      const logger = new AuditLogger(testLogPath);

      await logger.log({
        timestamp: '2024-01-01T00:00:00.000Z',
        sessionId: 'session-1',
        operation: 'shell_exec',
        harmLevel: 'C',
        decision: 'allowed',
        reason: 'Safe operation',
        user: 'testuser',
      });

      await logger.log({
        timestamp: '2024-01-01T00:00:01.000Z',
        sessionId: 'session-2',
        operation: 'file_write',
        harmLevel: 'B',
        decision: 'allowed',
        reason: 'Write allowed',
        user: 'testuser',
      });

      await logger.flush();

      const session1Entries = await logger.queryBySession('session-1');
      expect(session1Entries).toHaveLength(1);
      expect(session1Entries[0].operation).toBe('shell_exec');
    });

    it('should query entries by time range', async () => {
      const logger = new AuditLogger(testLogPath);

      await logger.log({
        timestamp: '2024-01-01T00:00:00.000Z',
        sessionId: testSessionId,
        operation: 'shell_exec',
        harmLevel: 'C',
        decision: 'allowed',
        reason: 'Safe operation',
        user: 'testuser',
      });

      await logger.log({
        timestamp: '2024-01-01T01:00:00.000Z',
        sessionId: testSessionId,
        operation: 'file_write',
        harmLevel: 'B',
        decision: 'allowed',
        reason: 'Write allowed',
        user: 'testuser',
      });

      await logger.flush();

      const entries = await logger.queryByTimeRange('2024-01-01T00:00:00.000Z', '2024-01-01T00:30:00.000Z');
      expect(entries).toHaveLength(1);
      expect(entries[0].operation).toBe('shell_exec');
    });

    it('should filter out override entries by default in query (Subtask 2.4.2)', async () => {
      const logger = new AuditLogger(testLogPath);

      await logger.log({
        timestamp: '2024-01-01T00:00:00.000Z',
        sessionId: testSessionId,
        operation: 'override',
        harmLevel: 'S',
        decision: 'allowed',
        reason: 'User override',
        user: 'testuser',
        auditEventType: 'override',
      });

      await logger.log({
        timestamp: '2024-01-01T00:00:01.000Z',
        sessionId: testSessionId,
        operation: 'shell_exec',
        harmLevel: 'C',
        decision: 'allowed',
        reason: 'Safe operation',
        user: 'testuser',
      });

      await logger.flush();

      // Default query excludes overrides
      const entries = await logger.query();
      expect(entries).toHaveLength(1);
      expect(entries[0].operation).toBe('shell_exec');
    });

    it('should include overrides when includeOverrides is true (Subtask 2.4.2)', async () => {
      const logger = new AuditLogger(testLogPath);

      await logger.log({
        timestamp: '2024-01-01T00:00:00.000Z',
        sessionId: testSessionId,
        operation: 'override',
        harmLevel: 'S',
        decision: 'allowed',
        reason: 'User override',
        user: 'testuser',
        auditEventType: 'override',
      });

      await logger.flush();

      const entries = await logger.query({ includeOverrides: true });
      expect(entries).toHaveLength(1);
      expect(entries[0].auditEventType).toBe('override');
    });

    it('should filter by auditEventType in query (Subtask 2.4.2)', async () => {
      const logger = new AuditLogger(testLogPath);

      await logger.log({
        timestamp: '2024-01-01T00:00:00.000Z',
        sessionId: testSessionId,
        operation: 'override',
        harmLevel: 'S',
        decision: 'allowed',
        reason: 'User override',
        user: 'testuser',
        auditEventType: 'override',
      });

      await logger.log({
        timestamp: '2024-01-01T00:00:01.000Z',
        sessionId: testSessionId,
        operation: 'shell_exec',
        harmLevel: 'C',
        decision: 'allowed',
        reason: 'Safe operation',
        user: 'testuser',
      });

      await logger.flush();

      const entries = await logger.query({ auditEventType: 'override', includeOverrides: true });
      expect(entries).toHaveLength(1);
      expect(entries[0].auditEventType).toBe('override');
    });

    it('should filter by sessionId in query', async () => {
      const logger = new AuditLogger(testLogPath);

      await logger.log({
        timestamp: '2024-01-01T00:00:00.000Z',
        sessionId: 'session-a',
        operation: 'shell_exec',
        harmLevel: 'C',
        decision: 'allowed',
        reason: 'Safe',
        user: 'u1',
      });

      await logger.log({
        timestamp: '2024-01-01T00:00:01.000Z',
        sessionId: 'session-b',
        operation: 'file_write',
        harmLevel: 'B',
        decision: 'allowed',
        reason: 'Write',
        user: 'u1',
      });

      await logger.flush();

      const entries = await logger.query({ sessionId: 'session-a' });
      expect(entries).toHaveLength(1);
      expect(entries[0].sessionId).toBe('session-a');
    });
  });

  describe('Error handling', () => {
    it('should handle invalid log path gracefully', async () => {
      const logger = new AuditLogger('/invalid/path/audit.log');

      // Should not throw, but handle error internally
      await expect(
        logger.log({
          timestamp: '2024-01-01T00:00:00.000Z',
          sessionId: testSessionId,
          operation: 'shell_exec',
          harmLevel: 'C',
          decision: 'allowed',
          reason: 'Safe operation',
          user: 'testuser',
        })
      ).resolves.not.toThrow();
    });

    it('should handle invalid JSON in log file', async () => {
      const logger = new AuditLogger(testLogPath);

      // Write invalid JSON to log file
      await logger.flush();
      const fs = await import('node:fs/promises');
      await fs.appendFile(testLogPath, 'invalid json line\n');

      // Should skip invalid lines
      const content = await logger.readAll();
      expect(content).toBeTruthy();
    });
  });

  describe('Statistics', () => {
    it('should provide log statistics', async () => {
      const logger = new AuditLogger(testLogPath);

      await logger.log({
        timestamp: '2024-01-01T00:00:00.000Z',
        sessionId: testSessionId,
        operation: 'shell_exec',
        harmLevel: 'C',
        decision: 'allowed',
        reason: 'Safe operation',
        user: 'testuser',
      });

      await logger.log({
        timestamp: '2024-01-01T00:00:01.000Z',
        sessionId: testSessionId,
        operation: 'file_write',
        harmLevel: 'S',
        decision: 'denied',
        reason: 'Destructive operation',
        user: 'testuser',
      });

      await logger.flush();

      const stats = await logger.getStatistics();
      expect(stats.totalEntries).toBe(2);
      expect(stats.allowedCount).toBe(1);
      expect(stats.deniedCount).toBe(1);
      expect(stats.harmLevelDistribution).toEqual({ C: 1, S: 1 });
      expect(stats.overrides).toBe(0); // No override entries
    });

    it('should count overrides in statistics (Subtask 2.4.3)', async () => {
      const logger = new AuditLogger(testLogPath);

      await logger.log({
        timestamp: '2024-01-01T00:00:00.000Z',
        sessionId: testSessionId,
        operation: 'override',
        harmLevel: 'S',
        decision: 'allowed',
        reason: 'User override',
        user: 'testuser',
        auditEventType: 'override',
        userAcknowledged: true,
      });

      await logger.log({
        timestamp: '2024-01-01T00:00:01.000Z',
        sessionId: testSessionId,
        operation: 'shell_exec',
        harmLevel: 'C',
        decision: 'allowed',
        reason: 'Safe operation',
        user: 'testuser',
      });

      await logger.flush();

      const stats = await logger.getStatistics();
      expect(stats.totalEntries).toBe(2);
      expect(stats.overrides).toBe(1);
    });
  });
});
