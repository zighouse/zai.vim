// =============================================================================
// @zaivim/engine — Sub-sandbox integration tests (Story 3.4)
//
// Exercises the ToolExecutor → SubSandboxProvider → bwrap pipeline by
// constructing a high-risk tool and verifying that executeToolCall routes
// through the SubSandboxManager rather than the primary sandbox.
//
// Real bwrap execution is gated by `canRunBwrap`; on non-Linux dev machines
// the bwrap-execution tests are skipped (the routing/audit/concurrency tests
// still run via mocks).
// =============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('node:os', async (importActual) => {
  const actual = await importActual<typeof import('node:os')>();
  return {
    ...actual,
    freemem: vi.fn(actual.freemem),
    loadavg: vi.fn(actual.loadavg),
    cpus: vi.fn(actual.cpus),
    platform: actual.platform,
  };
});

import { executeToolCall, type ToolExecutorOptions } from '../pipeline/tool-executor.js';
import { ToolRegistry } from '@zaivim/tools';
import type { ToolDefinition } from '@zaivim/core';
import { NullSecurityProvider } from '@zaivim/core';
import { SubSandboxManager } from '../security/sub-sandbox-manager.js';
import * as os from 'node:os';
import * as fs from 'node:fs';

const isLinux = process.platform === 'linux';
const bwrapInstalled = (() => {
  try {
    return fs.existsSync('/usr/bin/bwrap') || fs.existsSync('/bin/bwrap');
  } catch {
    return false;
  }
})();
const canRunBwrap = isLinux && bwrapInstalled;

/** Build a high-risk shell tool that mirrors shell_execute's signature. */
function makeHighRiskShellTool(): ToolDefinition {
  return {
    name: 'shell_execute_high_risk',
    description: 'High-risk shell command execution routed to an isolated sub-sandbox.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute' },
        cwd: { type: 'string', description: 'Working directory' },
        env: { type: 'object', description: 'Environment variables' },
        stdin: { type: 'string', description: 'Stdin to pipe' },
        timeout: { type: 'number', description: 'Timeout in ms' },
      },
      required: ['command'],
    },
    harmLevel: 'B',
    highRisk: true,
    // The executor never calls this — highRisk routes through executeHighRiskTool
    async execute() {
      throw new Error('high-risk tool should not reach the default execute() path');
    },
  };
}

function makeNormalTool(): ToolDefinition {
  return {
    name: 'echo_tool',
    description: 'A normal non-high-risk tool.',
    parameters: {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
    },
    async execute(params: { message: string }) {
      return { echoed: params.message };
    },
  };
}

function buildOptions(
  overrides: Partial<ToolExecutorOptions> & { auditLog?: Array<{ action: string; detail: Record<string, unknown> }> } = {},
): ToolExecutorOptions {
  const auditLog = overrides.auditLog ?? [];
  return {
    sessionId: 'test-session',
    sandbox: '/workspace',
    security: new NullSecurityProvider(),
    audit: (action, detail) => auditLog.push({ action, detail }),
    emit: () => {},
    ...overrides,
  };
}

describe('ToolExecutor → SubSandboxProvider routing (Story 3.4)', () => {
  beforeEach(() => {
    vi.mocked(os.freemem).mockImplementation(() => 1024 * 1024 * 1024); // 1GB
    vi.mocked(os.loadavg).mockImplementation(() => [0, 0, 0] as [number, number, number]);
    vi.mocked(os.cpus).mockImplementation(() => [
      { model: 'mock', speed: 0, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } },
    ]);
  });

  describe('high-risk routing', () => {
    it('returns ISOLATED_UNAVAILABLE when subSandboxManager is not injected', async () => {
      const registry = makeRegistry(makeHighRiskShellTool());
      const result = await executeToolCall(
        { id: 'tc1', name: 'shell_execute_high_risk', arguments: { command: 'echo hello' } },
        registry,
        buildOptions({ subSandboxManager: undefined }),
      );
      const parsed = JSON.parse(result.result);
      expect(parsed.code).toBe('ISOLATED_UNAVAILABLE');
      expect(result.timedOut).toBe(false);
    });

    it('returns TOOLS_INVALID_PARAMS when high-risk tool called without command', async () => {
      const manager = new SubSandboxManager({ workspaceDir: '/workspace' });
      const registry = makeRegistry(makeHighRiskShellTool());
      const result = await executeToolCall(
        { id: 'tc1', name: 'shell_execute_high_risk', arguments: {} },
        registry,
        buildOptions({ subSandboxManager: manager }),
      );
      const parsed = JSON.parse(result.result);
      expect(parsed.code).toBe('TOOLS_INVALID_PARAMS');
      await manager.destroyAll();
    });

    it('does NOT route non-high-risk tools to the sub-sandbox', async () => {
      const manager = new SubSandboxManager({ workspaceDir: '/workspace' });
      const registry = makeRegistry(makeNormalTool());
      const result = await executeToolCall(
        { id: 'tc1', name: 'echo_tool', arguments: { message: 'hi' } },
        registry,
        buildOptions({ subSandboxManager: manager }),
      );
      const parsed = JSON.parse(result.result);
      expect(parsed.echoed).toBe('hi');
      // No sub-sandbox should have been created
      expect(manager.activeCount).toBe(0);
      await manager.destroyAll();
    });
  });

  describe('concurrency cap (AC5) at executeToolCall layer', () => {
    it('returns ISOLATED_CONCURRENCY_LIMIT when active set is full', async () => {
      const manager = new SubSandboxManager({
        workspaceDir: '/workspace',
        config: { maxConcurrency: 1 },
      });
      // Pre-create one sandbox to fill the cap
      const holder = manager.create();
      const registry = makeRegistry(makeHighRiskShellTool());
      const result = await executeToolCall(
        { id: 'tc1', name: 'shell_execute_high_risk', arguments: { command: 'echo hello' } },
        registry,
        buildOptions({ subSandboxManager: manager }),
      );
      const parsed = JSON.parse(result.result);
      expect(parsed.code).toBe('ISOLATED_CONCURRENCY_LIMIT');
      await manager.destroy(holder.sandboxId);
      await manager.destroyAll();
    });

    it('releases a slot after destroy, allowing further create', async () => {
      const manager = new SubSandboxManager({
        workspaceDir: '/workspace',
        config: { maxConcurrency: 1 },
      });
      const a = manager.create();
      await manager.destroy(a.sandboxId);
      // Now create() should succeed again
      expect(() => manager.create()).not.toThrow();
      await manager.destroyAll();
    });
  });

  describe('resource refusal (AC4) at executeToolCall layer', () => {
    it('returns RESOURCE_INSUFFICIENT when host memory is low', async () => {
      vi.mocked(os.freemem).mockImplementation(() => 10 * 1024 * 1024); // 10MB
      const manager = new SubSandboxManager({ workspaceDir: '/workspace' });
      const registry = makeRegistry(makeHighRiskShellTool());
      const result = await executeToolCall(
        { id: 'tc1', name: 'shell_execute_high_risk', arguments: { command: 'echo hello' } },
        registry,
        buildOptions({ subSandboxManager: manager }),
      );
      const parsed = JSON.parse(result.result);
      expect(parsed.code).toBe('RESOURCE_INSUFFICIENT');
      await manager.destroyAll();
    });
  });

  // Real bwrap execution — gated by platform + binary presence
  describe.skipIf(!canRunBwrap)('real bwrap dispatch', () => {
    it('routes high-risk command through SubSandboxProvider', async () => {
      const auditLog: Array<{ action: string; detail: Record<string, unknown> }> = [];
      const manager = new SubSandboxManager({
        workspaceDir: '/workspace',
        onAudit: (action, detail) => auditLog.push({ action, detail }),
      });
      const registry = makeRegistry(makeHighRiskShellTool());
      const result = await executeToolCall(
        { id: 'tc1', name: 'shell_execute_high_risk', arguments: { command: 'echo from-sub-sandbox' } },
        registry,
        buildOptions({ subSandboxManager: manager, auditLog }),
      );
      const parsed = JSON.parse(result.result);
      expect(parsed.exitCode).toBe(0);
      expect(parsed.stdout.trim()).toBe('from-sub-sandbox');
      expect(parsed.isolated).toBe(true);
      expect(typeof parsed.sandboxId).toBe('string');
      expect(auditLog.some((c) => c.action === 'isolated.dispatch')).toBe(true);
      expect(auditLog.some((c) => c.action === 'isolated.execute')).toBe(true);
      await manager.destroyAll();
    });

    it('returns ISOLATED_TIMEOUT when command exceeds the timeout', async () => {
      const manager = new SubSandboxManager({ workspaceDir: '/workspace' });
      const registry = makeRegistry(makeHighRiskShellTool());
      const result = await executeToolCall(
        { id: 'tc1', name: 'shell_execute_high_risk', arguments: { command: 'sleep 30', timeout: 5_000 } },
        registry,
        buildOptions({ subSandboxManager: manager }),
      );
      const parsed = JSON.parse(result.result);
      expect(parsed.code).toBe('ISOLATED_TIMEOUT');
      expect(result.timedOut).toBe(true);
      await manager.destroyAll();
    }, 15_000);
  });

  describe('regression (AC4: non-high-risk tools unaffected)', () => {
    it('non-high-risk tool executes normally when subSandboxManager is absent', async () => {
      const registry = makeRegistry(makeNormalTool());
      const result = await executeToolCall(
        { id: 'tc1', name: 'echo_tool', arguments: { message: 'no-sub' } },
        registry,
        buildOptions({ subSandboxManager: undefined }),
      );
      const parsed = JSON.parse(result.result);
      expect(parsed.echoed).toBe('no-sub');
    });

    it('multiple non-high-risk tools run sequentially without sub-sandbox', async () => {
      const manager = new SubSandboxManager({ workspaceDir: '/workspace' });
      const registry = makeRegistry(makeNormalTool());
      for (let i = 0; i < 5; i++) {
        const result = await executeToolCall(
          { id: `tc-${i}`, name: 'echo_tool', arguments: { message: `iter-${i}` } },
          registry,
          buildOptions({ subSandboxManager: manager }),
        );
        const parsed = JSON.parse(result.result);
        expect(parsed.echoed).toBe(`iter-${i}`);
      }
      expect(manager.activeCount).toBe(0);
      await manager.destroyAll();
    });

    it('repeated high-risk calls do not exhaust the concurrency cap (CR-1 regression)', async () => {
      // CR-1 regression: the `using subSandbox = manager.create()` disposal path
      // must release the slot in the manager's #sandboxes map. Without that,
      // every high-risk call leaks a slot and the N+1th call (where N is
      // maxConcurrency) fails with ISOLATED_CONCURRENCY_LIMIT even though no
      // sandbox is actually running.
      const manager = new SubSandboxManager({
        workspaceDir: '/workspace',
        config: { maxConcurrency: 3 },
      });
      const registry = makeRegistry(makeHighRiskShellTool());
      // Run well past maxConcurrency so any slot leak trips the cap.
      for (let i = 0; i < 10; i++) {
        const result = await executeToolCall(
          { id: `tc-${i}`, name: 'shell_execute_high_risk', arguments: { command: 'echo hello' } },
          registry,
          buildOptions({ subSandboxManager: manager }),
        );
        const parsed = JSON.parse(result.result);
        // Whether the underlying bwrap ran or returned ISOLATED_UNAVAILABLE
        // (non-Linux CI), the manager must NEVER refuse with the concurrency
        // cap — that would indicate a leaked slot.
        expect(parsed.code).not.toBe('ISOLATED_CONCURRENCY_LIMIT');
        // Slot must be released synchronously enough that the next iteration
        // sees an empty active set.
        expect(manager.activeCount).toBe(0);
      }
      await manager.destroyAll();
    });
  });
});

function makeRegistry(...tools: ToolDefinition[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);
  return registry;
}
