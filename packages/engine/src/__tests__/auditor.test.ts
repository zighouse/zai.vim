// @zaivim/engine — Auditor Tests
// Tests for JSONL append-only audit logging with redaction, rate limiting,
// fail-closed, truncation, and query/summary.
//
// Coverage targets: auditor.ts ≥80%, audit-middleware.ts ≥80%

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, unlinkSync, rmSync, mkdirSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Auditor } from '../security/auditor.js';
import { AuditMiddleware } from '../middleware/audit-middleware.js';
import type { AuditEvent } from '@zaivim/core';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTestDir(): string {
  const dir = resolve(tmpdir(), `auditor-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeEvent(overrides: Partial<AuditEvent> & { sessionId: string }): AuditEvent {
  return {
    timestamp: new Date().toISOString(),
    operation: 'shell_execute',
    level: 'C',
    sessionId: overrides.sessionId,
    result: 'allowed',
    ...overrides,
  };
}

function cleanDir(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Auditor', () => {
  let testDir: string;
  let auditor: Auditor;

  beforeEach(() => {
    testDir = makeTestDir();
    auditor = new Auditor(testDir);
  });

  afterEach(async () => {
    await auditor.close();
    cleanDir(testDir);
  });

  // ─── Subtask 6.1: 核心写入逻辑 ──────────────────────────────────────────

  describe('core write logic (Subtask 6.1)', () => {
    it('should write an audit event and flush to JSONL file', async () => {
      await auditor.write(makeEvent({ sessionId: 'sess-1', operation: 'file_read' }));
      await auditor.flush();

      const today = new Date().toISOString().slice(0, 10);
      const filePath = resolve(testDir, `${today}.jsonl`);
      expect(existsSync(filePath)).toBe(true);

      const content = readFileSync(filePath, 'utf8');
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(1);

      const parsed = JSON.parse(lines[0]!);
      expect(parsed.operation).toBe('file_read');
      expect(parsed.sessionId).toBe('sess-1');
      expect(parsed.result).toBe('allowed');
    });

    it('should append multiple events to the same file', async () => {
      await auditor.write(makeEvent({ sessionId: 'sess-1', operation: 'file_read' }));
      await auditor.write(makeEvent({ sessionId: 'sess-1', operation: 'file_write' }));
      await auditor.flush();

      const content = readFileSync(resolve(testDir, `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf8');
      expect(content.trim().split('\n')).toHaveLength(2);
    });

    it('should apply JSON.stringify encoding (JSONL injection protection)', async () => {
      await auditor.write(makeEvent({
        sessionId: 'sess-1',
        operation: 'file_read',
        params: { path: '/tmp/test\nfile\r\n\0' },
      }));
      await auditor.flush();

      const content = readFileSync(resolve(testDir, `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf8');
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(1);

      const line = lines[0]!;
      // The newline in the path should be JSON-escaped
      expect(line).toContain('\\n');
      expect(line).toContain('\\r');
      // Each record occupies exactly one line
      expect(line.split('\n')).toHaveLength(1);
    });

    it('should record audit.truncated for large parameters (AC #7)', async () => {
      const largeContent = 'x'.repeat(70000);
      await auditor.write(makeEvent({
        sessionId: 'sess-1',
        operation: 'file_read',
        params: { file_content: largeContent },
      }));
      await auditor.flush();

      const content = readFileSync(resolve(testDir, `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf8');
      const lines = content.trim().split('\n');

      // Should have at least 2 entries: the original + truncation record
      expect(lines.length).toBeGreaterThanOrEqual(2);

      const truncationRecords = lines
        .map(l => JSON.parse(l))
        .filter((e: AuditEvent) => e.auditEventType === 'audit.truncated');
      expect(truncationRecords.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ─── Subtask 6.2: 敏感信息脱敏 ──────────────────────────────────────────

  describe('sensitive data redaction (Subtask 6.2)', () => {
    it('should redact OpenAI-style API keys (sk-...)', async () => {
      await auditor.write(makeEvent({
        sessionId: 'sess-1',
        params: { apiKey: 'sk-' + 'a'.repeat(40) },
      }));
      await auditor.flush();

      const content = readFileSync(resolve(testDir, `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf8');
      expect(content).not.toContain('sk-');
      expect(content).toContain('***REDACTED***');
    });

    it('should redact Anthropic-style keys (sk-ant-...)', async () => {
      await auditor.write(makeEvent({
        sessionId: 'sess-1',
        params: { apiKey: 'sk-ant-' + 'a'.repeat(30) },
      }));
      await auditor.flush();

      const content = readFileSync(resolve(testDir, `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf8');
      expect(content).toContain('***REDACTED***');
    });

    it('should redact Bearer tokens', async () => {
      await auditor.write(makeEvent({
        sessionId: 'sess-1',
        params: { authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9' },
      }));
      await auditor.flush();

      const content = readFileSync(resolve(testDir, `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf8');
      expect(content).not.toContain('Bearer eyJ');
      expect(content).toContain('***REDACTED***');
    });

    it('should redact JWT tokens', async () => {
      await auditor.write(makeEvent({
        sessionId: 'sess-1',
        params: { token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dkN5LyQ' },
      }));
      await auditor.flush();

      const content = readFileSync(resolve(testDir, `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf8');
      expect(content).not.toContain('eyJhbGci');
      expect(content).toContain('***REDACTED***');
    });

    it('should redact password fields by key name', async () => {
      await auditor.write(makeEvent({
        sessionId: 'sess-1',
        params: { password: 'super-secret-123', username: 'testuser' },
      }));
      await auditor.flush();

      const content = readFileSync(resolve(testDir, `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf8');
      expect(content).not.toContain('super-secret-123');
      expect(content).toContain('***REDACTED***');
      expect(content).toContain('testuser');
    });

    it('should preserve non-sensitive values', async () => {
      await auditor.write(makeEvent({
        sessionId: 'sess-1',
        params: { filePath: '/home/test/file.txt', lineCount: 42 },
      }));
      await auditor.flush();

      const content = readFileSync(resolve(testDir, `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf8');
      expect(content).toContain('/home/test/file.txt');
      expect(content).toContain('42');
    });

    it('should redact hex tokens of length ≥32', async () => {
      await auditor.write(makeEvent({
        sessionId: 'sess-1',
        params: { secretKey: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2' },
      }));
      await auditor.flush();

      const content = readFileSync(resolve(testDir, `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf8');
      expect(content).toContain('***REDACTED***');
    });
  });

  // ─── Subtask 6.3: JSONL 注入防护 ────────────────────────────────────────

  describe('JSONL injection protection (Subtask 6.3)', () => {
    it('should escape newlines in string params', async () => {
      await auditor.write(makeEvent({
        sessionId: 'sess-1',
        params: { path: 'line1\nline2\nline3' },
      }));
      await auditor.flush();

      const content = readFileSync(resolve(testDir, `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf8');
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(1);

      const parsed = JSON.parse(lines[0]!);
      expect(parsed.params.path).toBe('line1\nline2\nline3');
    });

    it('should escape tabs and null chars', async () => {
      await auditor.write(makeEvent({
        sessionId: 'sess-1',
        params: { data: 'col1\tcol2\tcol3\0null' },
      }));
      await auditor.flush();

      const content = readFileSync(resolve(testDir, `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf8');
      const parsed = JSON.parse(content.trim());
      expect(parsed.params.data).toBe('col1\tcol2\tcol3\0null');
    });

    it('should produce parsable JSONL even with binary-like params', async () => {
      const binaryLike = Buffer.from([0x00, 0x01, 0x02, 0x1f, 0x7f, 0xff]).toString('binary');
      await auditor.write(makeEvent({
        sessionId: 'sess-1',
        params: { raw: binaryLike },
      }));
      await auditor.flush();

      const content = readFileSync(resolve(testDir, `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf8');
      expect(() => JSON.parse(content.trim())).not.toThrow();
    });

    it('should ensure each record occupies exactly one line', async () => {
      for (let i = 0; i < 5; i++) {
        await auditor.write(makeEvent({
          sessionId: 'sess-1',
          operation: `op-${i}`,
          params: { special: `line${i}\nwith\nbreaks` },
        }));
      }
      await auditor.flush();

      const content = readFileSync(resolve(testDir, `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf8');
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(5);

      for (const line of lines) {
        expect(() => JSON.parse(line!)).not.toThrow();
      }
    });
  });

  // ─── Subtask 6.4: 速率限制器 ────────────────────────────────────────────

  describe('rate limiting (Subtask 6.4)', () => {
    it('should throttle when exceeding 100/sec per session', async () => {
      // Use a very low rate limit for testing
      const auditor = new Auditor(testDir, { rateLimitPerSec: 5, flushBatchSize: 100 });

      // Write 10 events rapidly (should trigger throttle at 5/sec)
      for (let i = 0; i < 10; i++) {
        try {
          await auditor.write(makeEvent({ sessionId: 'sess-1', operation: `op-${i}` }));
        } catch {
          // Rate limited — acceptable
        }
      }

      await auditor.flush();
      // With rateLimitPerSec=5 and 10 writes, at least some throttling should occur
      expect(auditor.throttleNotifications.length).toBeGreaterThan(0);
      await auditor.close();
    });

    it('should allow writes within rate limit', async () => {
      const auditor = new Auditor(testDir, { rateLimitPerSec: 1000, flushBatchSize: 100 });

      for (let i = 0; i < 50; i++) {
        await auditor.write(makeEvent({ sessionId: 'sess-2', operation: `op-${i}` }));
      }

      await auditor.flush();

      const content = readFileSync(resolve(testDir, `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf8');
      const lines = content.trim().split('\n').filter(l => l);
      // Should have written most events (some may be throttle records)
      expect(lines.length).toBeGreaterThanOrEqual(45);
      await auditor.close();
    });

    it('should maintain separate buckets for different sessions', async () => {
      const auditor = new Auditor(testDir, { rateLimitPerSec: 3, flushBatchSize: 100 });

      // Write to different sessions — each gets its own bucket
      await auditor.write(makeEvent({ sessionId: 'sess-a', operation: 'op-1' }));
      await auditor.write(makeEvent({ sessionId: 'sess-a', operation: 'op-2' }));
      await auditor.write(makeEvent({ sessionId: 'sess-a', operation: 'op-3' }));
      // Session B should still have full tokens
      await auditor.write(makeEvent({ sessionId: 'sess-b', operation: 'op-1' }));

      await auditor.flush();

      const content = readFileSync(resolve(testDir, `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf8');
      const lines = content.trim().split('\n').filter(l => l);
      expect(lines.length).toBeGreaterThanOrEqual(4);
      await auditor.close();
    });
  });

  // ─── Subtask 6.5: Pipeline 中间件顺序验证 ──────────────────────────────

  describe('Pipeline middleware order validation (Subtask 6.5)', () => {
    it('should accept correct order: Security → Audit', () => {
      const result = AuditMiddleware.validatePipelinePosition(['SecurityMiddleware', 'AuditMiddleware']);
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should reject reversed order: Audit → Security', () => {
      const result = AuditMiddleware.validatePipelinePosition(['AuditMiddleware', 'SecurityMiddleware']);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('violation');
      expect(result.error).toContain('ADR-5');
    });

    it('should reject when AuditMiddleware is missing', () => {
      const result = AuditMiddleware.validatePipelinePosition(['SecurityMiddleware']);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('not registered');
    });

    it('should be valid when SecurityMiddleware is missing (degraded config)', () => {
      const result = AuditMiddleware.validatePipelinePosition(['AuditMiddleware']);
      expect(result.valid).toBe(true);
    });

    it('should accept Security=index 0, Audit=index 1', () => {
      const order = ['SecurityMiddleware', 'ToolExecutor', 'AuditMiddleware'];
      const result = AuditMiddleware.validatePipelinePosition(order);
      expect(result.valid).toBe(true);
    });

    it('should reject Audit before Security in multi-element chain', () => {
      const order = ['ToolExecutor', 'AuditMiddleware', 'SecurityEnricher', 'SecurityMiddleware'];
      const result = AuditMiddleware.validatePipelinePosition(order);
      expect(result.valid).toBe(false);
    });
  });

  // ─── Subtask 6.6: Fail-closed 原则验证 ─────────────────────────────────

  describe('fail-closed (Subtask 6.6)', () => {
    it('should work normally with successful flush cycles', async () => {
      // Multiple write+flush cycles should not trigger degraded
      for (let i = 0; i < 3; i++) {
        await auditor.write(makeEvent({ sessionId: 'sess-1', operation: `cycle-${i}` }));
        await auditor.write(makeEvent({ sessionId: 'sess-1', operation: `cycle-${i}` }));
        await auditor.flush();
        expect(auditor.degraded).toBe(false);
        expect(auditor.bufferSize).toBe(0);
      }
    });

    it('should reject write() when degraded after flush failure', async () => {
      // Create auditor pointing to a read-only path to force flush failure
      const readonlyDir = resolve(testDir, 'readonly-audit');
      mkdirSync(resolve(readonlyDir, 'overrides'), { recursive: true });
      try { chmodSync(readonlyDir, 0o444); } catch { /* May fail on Windows */ }

      const auditor = new Auditor(readonlyDir, { flushBatchSize: 2 });

      // Write events to trigger flush. The flush should fail
      // because the directory is read-only.
      await auditor.write(makeEvent({ sessionId: 'sess-1' }));
      await auditor.write(makeEvent({ sessionId: 'sess-1' }));

      // The write() at batchSize threshold triggers flush (fire-and-forget)
      // Give it a tick to process
      await new Promise(r => setTimeout(r, 10));

      // After failed flush, the auditor should be degraded
      // (Note: on some systems/CI, chmod may not work as expected)
      if (process.platform !== 'win32') {
        expect(auditor.degraded).toBe(true);
        // Subsequent writes should fail
        await expect(
          auditor.write(makeEvent({ sessionId: 'sess-3' }))
        ).rejects.toMatchObject({ code: 'SECURITY_AUDIT_UNAVAILABLE' });
      }

      try { chmodSync(readonlyDir, 0o755); } catch { /* restore */ }
      await auditor.close();
    });

    it('should reject writeInternal when degraded', async () => {
      const readonlyDir = resolve(testDir, 'readonly-internal');
      mkdirSync(resolve(readonlyDir, 'overrides'), { recursive: true });
      try { chmodSync(readonlyDir, 0o444); } catch {}

      const auditor = new Auditor(readonlyDir, { flushBatchSize: 2 });

      await auditor.write(makeEvent({ sessionId: 'sess-1' }));
      await auditor.write(makeEvent({ sessionId: 'sess-1' }));

      await new Promise(r => setTimeout(r, 10));

      if (process.platform !== 'win32') {
        expect(auditor.degraded).toBe(true);
        await expect(
          auditor.writeInternal(makeEvent({ sessionId: 'sess-3' }))
        ).rejects.toMatchObject({ code: 'SECURITY_AUDIT_UNAVAILABLE' });
      }

      try { chmodSync(readonlyDir, 0o755); } catch {}
      await auditor.close();
    });
  });

  // ─── Subtask 6.7: 写入性能 ≤5ms ─────────────────────────────────────────

  describe('write latency ≤5ms (Subtask 6.7)', () => {
    it('should complete write() calls within 5ms (non-blocking buffer)', async () => {
      const durations: number[] = [];

      for (let i = 0; i < 20; i++) {
        const start = performance.now();
        await auditor.write(makeEvent({ sessionId: 'sess-1', operation: `op-${i}` }));
        durations.push(performance.now() - start);
      }

      await auditor.flush();

      const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
      expect(avg).toBeLessThan(5);
    });
  });

  // ─── Query / Summary ─────────────────────────────────────────────────────

  describe('query() and summary()', () => {
    it('should query by date and level', async () => {
      await auditor.write(makeEvent({ sessionId: 'sess-1', level: 'S', operation: 'rm-rf' }));
      await auditor.write(makeEvent({ sessionId: 'sess-1', level: 'C', operation: 'file_read' }));
      await auditor.flush();

      const today = new Date().toISOString().slice(0, 10);
      const results = await auditor.query({ date: today, level: 'S' });
      expect(results).toHaveLength(1);
      expect(results[0]!.level).toBe('S');
    });

    it('should query by session', async () => {
      await auditor.write(makeEvent({ sessionId: 'sess-a', operation: 'op-1' }));
      await auditor.write(makeEvent({ sessionId: 'sess-b', operation: 'op-2' }));
      await auditor.flush();

      const today = new Date().toISOString().slice(0, 10);
      const results = await auditor.query({ date: today, session: 'sess-a' });
      expect(results).toHaveLength(1);
      expect(results[0]!.sessionId).toBe('sess-a');
    });

    it('should return summary with aggregation', async () => {
      await auditor.write(makeEvent({ sessionId: 'sess-1', level: 'S', result: 'rejected', operation: 'rm' }));
      await auditor.write(makeEvent({ sessionId: 'sess-1', level: 'C', result: 'allowed', operation: 'read' }));
      await auditor.write(makeEvent({ sessionId: 'sess-1', level: 'C', result: 'allowed', operation: 'read' }));
      await auditor.write(makeEvent({ sessionId: 'sess-2', level: 'B', result: 'allowed', operation: 'write' }));
      await auditor.flush();

      const result = await auditor.summary('24h');
      expect(result.total).toBe(4);
      expect(result.byLevel.S).toBe(1);
      expect(result.byLevel.C).toBe(2);
      expect(result.rejected).toBe(1);
      expect(result.topSessions.length).toBeGreaterThanOrEqual(1);
    });

    it('should return undefined overrides when none present', async () => {
      await auditor.write(makeEvent({ sessionId: 'sess-1', level: 'C', result: 'allowed', operation: 'read' }));
      await auditor.flush();

      const result = await auditor.summary('24h');
      expect(result.total).toBe(1);
      expect(result.overrides).toBeUndefined();
    });
  });

  // ─── writeInternal ──────────────────────────────────────────────────────

  describe('writeInternal (bypass preExecute)', () => {
    it('should write without rate limiting', async () => {
      const auditor = new Auditor(testDir, { rateLimitPerSec: 1, flushBatchSize: 100 });

      // Write many events via internal path — should not be rate limited
      for (let i = 0; i < 10; i++) {
        await auditor.writeInternal(makeEvent({ sessionId: 'sess-1', operation: `internal-${i}` }));
      }
      await auditor.flush();

      const content = readFileSync(resolve(testDir, `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf8');
      const lines = content.trim().split('\n').filter(l => l);
      // All 10 should be there (no rate limiting)
      expect(lines.length).toBeGreaterThanOrEqual(10);
      await auditor.close();
    });

    it('should respect degraded state (set by flush failure)', async () => {
      const readOnlyDir = resolve(testDir, 'ro-writeinternal');
      mkdirSync(resolve(readOnlyDir, 'overrides'), { recursive: true });
      try { chmodSync(readOnlyDir, 0o444); } catch {}

      const auditor = new Auditor(readOnlyDir, { flushBatchSize: 1 });

      await auditor.write(makeEvent({ sessionId: 'sess-1' }));
      await new Promise(r => setTimeout(r, 10));

      if (process.platform !== 'win32') {
        expect(auditor.degraded).toBe(true);
        await expect(
          auditor.writeInternal(makeEvent({ sessionId: 'sess-2' }))
        ).rejects.toMatchObject({ code: 'SECURITY_AUDIT_UNAVAILABLE' });
      }

      try { chmodSync(readOnlyDir, 0o755); } catch {}
      await auditor.close();
    });
  });

  // ─── Log rotation ────────────────────────────────────────────────────────

  describe('log rotation', () => {
    it('should rotate file when size exceeds limit', async () => {
      const auditor = new Auditor(testDir, { maxFileSizeMB: 0.001 }); // ~1KB

      // Write enough data to trigger rotation
      for (let i = 0; i < 30; i++) {
        await auditor.write(makeEvent({
          sessionId: 'sess-1',
          params: { data: 'x'.repeat(200) },
        }));
      }
      await auditor.flush();

      // Check that rotated files exist
      const today = new Date().toISOString().slice(0, 10);
      const rotatedPattern = `${today}.001.jsonl`;
      expect(existsSync(resolve(testDir, rotatedPattern))).toBe(true);

      await auditor.close();
    });
  });

  // ─── Legacy convenience methods ─────────────────────────────────────────

  describe('legacy log() method', () => {
    it('should log via convenience method', async () => {
      auditor.log('sess-1', 'test_action', { key: 'value' });
      await auditor.flush();

      const content = readFileSync(resolve(testDir, `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf8');
      const parsed = JSON.parse(content.trim());
      expect(parsed.operation).toBe('test_action');
      expect(parsed.sessionId).toBe('sess-1');
      expect(parsed.result).toBe('allowed');
    });
  });
});

// ─── AuditMiddleware Tests ──────────────────────────────────────────────────

describe('AuditMiddleware', () => {
  let testDir: string;
  let auditor: Auditor;
  let middleware: AuditMiddleware;

  beforeEach(() => {
    testDir = makeTestDir();
    auditor = new Auditor(testDir);
    middleware = new AuditMiddleware(auditor);
  });

  afterEach(async () => {
    middleware.shutdown();
    await auditor.close();
    cleanDir(testDir);
  });

  it('should record an allowed operation', async () => {
    middleware.record(
      { allowed: true, harmLevel: 'C', reason: 'safe', sessionId: 'sess-1' },
      { operation: 'file_read', sessionId: 'sess-1' },
    );
    await auditor.flush();

    const today = new Date().toISOString().slice(0, 10);
    const events = await auditor.query({ date: today, session: 'sess-1' });
    expect(events).toHaveLength(1);
    expect(events[0]!.result).toBe('allowed');
  });

  it('should record a rejected operation', async () => {
    middleware.record(
      { allowed: false, harmLevel: 'S', reason: 'destructive', sessionId: 'sess-1' },
      { operation: 'rm_rf', sessionId: 'sess-1' },
    );
    await auditor.flush();

    const today = new Date().toISOString().slice(0, 10);
    const events = await auditor.query({ date: today, session: 'sess-1' });
    expect(events).toHaveLength(1);
    expect(events[0]!.result).toBe('rejected');
    expect(events[0]!.reason).toBe('destructive');
  });

  it('should not record after shutdown', async () => {
    middleware.shutdown();
    middleware.record(
      { allowed: true, harmLevel: 'C', reason: 'safe', sessionId: 'sess-1' },
      { operation: 'file_read', sessionId: 'sess-1' },
    );
    await auditor.flush();

    const today = new Date().toISOString().slice(0, 10);
    const events = await auditor.query({ date: today, session: 'sess-1' });
    expect(events).toHaveLength(0);
  });

  it('should pass params to audit event', async () => {
    middleware.record(
      { allowed: true, harmLevel: 'C', reason: 'safe', sessionId: 'sess-1' },
      { operation: 'file_read', sessionId: 'sess-1', params: { path: '/test.txt' } },
    );
    await auditor.flush();

    const today = new Date().toISOString().slice(0, 10);
    const events = await auditor.query({ date: today });
    expect(events[0]!.params).toEqual({ path: '/test.txt' });
  });
});
