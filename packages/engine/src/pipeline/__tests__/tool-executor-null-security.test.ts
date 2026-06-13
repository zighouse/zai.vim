// Story 3.3, Task 6.4: ToolExecutor with no injected security (AC5)
// Verifies that when options.security is undefined, the NullSecurityProvider
// fallback kicks in, file_read still executes, and warnings are routed to audit.

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolRegistry } from '@zaivim/tools';
import { executeToolCall } from '../tool-executor.js';

describe('executeToolCall — NullSecurityProvider fallback (AC5)', () => {
  it('executes file_read without injected security', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zai-null-sec-exec-'));
    try {
      const filePath = join(dir, 'sample.txt');
      writeFileSync(filePath, 'hello from null-security fallback');
      const registry = ToolRegistry.createDefault();

      const audit = vi.fn();
      const result = await executeToolCall(
        { id: 'tc-1', name: 'file_read', arguments: { path: filePath } },
        registry,
        { sessionId: 's1', sandbox: dir, audit },
      );

      expect(result.timedOut).toBe(false);
      expect(result.result).toContain('hello from null-security fallback');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('routes NullSecurityProvider warnings through the audit sink', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zai-null-sec-audit-'));
    try {
      const filePath = join(dir, 'sample.txt');
      writeFileSync(filePath, 'data');
      const registry = ToolRegistry.createDefault();

      const audit = vi.fn();
      await executeToolCall(
        { id: 'tc-1', name: 'file_read', arguments: { path: filePath } },
        registry,
        { sessionId: 's1', sandbox: dir, audit },
      );

      const securityFallbackCalls = audit.mock.calls.filter(
        ([action]) => action === 'security.fallback',
      );
      expect(securityFallbackCalls.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns TOOLS_NOT_FOUND when the tool is missing from registry', async () => {
    const registry = new ToolRegistry();
    const result = await executeToolCall(
      { id: 'tc-1', name: 'nonexistent_tool', arguments: {} },
      registry,
      { sessionId: 's1', sandbox: '/tmp', audit: vi.fn() },
    );
    const parsed = JSON.parse(result.result);
    expect(parsed.code).toBe('TOOLS_NOT_FOUND');
    expect(parsed.message).toContain('nonexistent_tool');
  });

  it('signal in ctx is always defined even when caller provides no signal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zai-null-sec-signal-'));
    try {
      const filePath = join(dir, 'sample.txt');
      writeFileSync(filePath, 'x');
      const registry = ToolRegistry.createDefault();

      let capturedSignal: AbortSignal | undefined;
      // Patch a wrapper tool to capture ctx.signal — verify it is never undefined.
      const tool = registry.get('file_read')!;
      const original = tool.execute.bind(tool);
      (tool as { execute: typeof original }).execute = async (params, ctx) => {
        capturedSignal = ctx.signal;
        return original(params, ctx);
      };

      await executeToolCall(
        { id: 'tc-1', name: 'file_read', arguments: { path: filePath } },
        registry,
        { sessionId: 's1', sandbox: dir, audit: vi.fn() },
      );

      expect(capturedSignal).toBeDefined();
      expect(typeof capturedSignal!.aborted).toBe('boolean');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
