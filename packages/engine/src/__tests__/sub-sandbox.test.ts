// =============================================================================
// @zaivim/engine — SubSandboxProvider unit tests (Story 3.4)
//
// These tests focus on lifecycle, error mapping, and resource-refusal logic.
// Real bwrap execution is gated by `process.platform === 'linux'` and bwrap
// availability, so the suite uses describe.skipIf to keep CI green on
// non-Linux dev machines.
//
// ESM note: vi.spyOn cannot redefine node:os exports — we use vi.mock instead.
// =============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Default mock — pass-through. Individual tests override via mockReturnValue.
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

import { SubSandboxProvider, DEFAULT_SUBSANDBOX_CONFIG } from '../security/sub-sandbox.js';
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

describe('SubSandboxProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset os mocks to actual implementations by default
    vi.mocked(os.freemem).mockImplementation(() => 1024 * 1024 * 1024); // 1GB
    vi.mocked(os.loadavg).mockImplementation(() => [0, 0, 0] as [number, number, number]);
    vi.mocked(os.cpus).mockImplementation(() => [
      { model: 'mock', speed: 0, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } },
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('construction and lifecycle', () => {
    it('assigns a unique sandboxId', () => {
      const a = new SubSandboxProvider('/workspace');
      const b = new SubSandboxProvider('/workspace');
      expect(a.sandboxId).toBeTruthy();
      expect(b.sandboxId).toBeTruthy();
      expect(a.sandboxId).not.toBe(b.sandboxId);
    });

    it('exposes the merged config', () => {
      const provider = new SubSandboxProvider('/workspace', {
        defaultTimeoutMs: 10_000,
        minFreeMemoryMB: 250,
      });
      expect(provider.config.defaultTimeoutMs).toBe(10_000);
      expect(provider.config.minFreeMemoryMB).toBe(250);
      expect(provider.config.maxConcurrency).toBe(DEFAULT_SUBSANDBOX_CONFIG.maxConcurrency);
    });

    it('is not destroyed immediately after construction', () => {
      const provider = new SubSandboxProvider('/workspace');
      expect(provider.isDestroyed).toBe(false);
    });

    it('destroy() marks the provider destroyed', async () => {
      const provider = new SubSandboxProvider('/workspace');
      await provider.destroy();
      expect(provider.isDestroyed).toBe(true);
    });

    it('destroy() is idempotent (multiple calls do not throw)', async () => {
      const provider = new SubSandboxProvider('/workspace');
      await provider.destroy();
      await expect(provider.destroy()).resolves.toBeUndefined();
      await expect(provider.destroy()).resolves.toBeUndefined();
      expect(provider.isDestroyed).toBe(true);
    });

    it('[Symbol.dispose] invokes destroy', async () => {
      const provider = new SubSandboxProvider('/workspace');
      provider[Symbol.dispose]();
      await new Promise((r) => setImmediate(r));
      expect(provider.isDestroyed).toBe(true);
    });
  });

  describe('destroyed provider rejects execution', () => {
    it('throws ISOLATED_ALREADY_DESTROYED when executeIsolated is called after destroy', async () => {
      const provider = new SubSandboxProvider('/workspace');
      await provider.destroy();
      await expect(provider.executeIsolated('echo hello')).rejects.toMatchObject({
        code: 'ISOLATED_ALREADY_DESTROYED',
      });
    });
  });

  describe('input validation', () => {
    it('rejects empty command with TOOLS_INVALID_PARAMS', async () => {
      const provider = new SubSandboxProvider('/workspace', { memoryCheckEnabled: false });
      await expect(provider.executeIsolated('')).rejects.toMatchObject({
        code: 'TOOLS_INVALID_PARAMS',
      });
      await provider.destroy();
    });

    it('rejects non-string command with TOOLS_INVALID_PARAMS', async () => {
      const provider = new SubSandboxProvider('/workspace', { memoryCheckEnabled: false });
      await expect(provider.executeIsolated(undefined as unknown as string)).rejects.toMatchObject({
        code: 'TOOLS_INVALID_PARAMS',
      });
      await provider.destroy();
    });
  });

  describe('memory pre-check (AC4)', () => {
    it('rejects execution when freemem() median is below threshold', async () => {
      vi.mocked(os.freemem).mockReturnValue(10 * 1024 * 1024); // 10MB < default 100MB
      const audit: Array<{ action: string; detail: Record<string, unknown> }> = [];
      const provider = new SubSandboxProvider('/workspace', undefined, (a, d) => audit.push({ action: a, detail: d }));
      await expect(provider.executeIsolated('echo hello')).rejects.toMatchObject({
        code: 'RESOURCE_INSUFFICIENT',
      });
      expect(audit.some((c) => c.action === 'isolated.resource_insufficient')).toBe(true);
      await provider.destroy();
    });

    it('samples freemem 3 times and takes the median', async () => {
      // Return 100MB, 200MB, 300MB → median = 200MB ≥ 100MB threshold
      vi.mocked(os.freemem)
        .mockReturnValueOnce(100 * 1024 * 1024)
        .mockReturnValueOnce(200 * 1024 * 1024)
        .mockReturnValueOnce(300 * 1024 * 1024)
        .mockReturnValue(500 * 1024 * 1024);

      const provider = new SubSandboxProvider('/workspace');
      try {
        await provider.executeIsolated('echo hello');
      } catch {
        // expected — bwrap missing on non-Linux or other failures
      }
      expect(os.freemem.mock.calls.length).toBeGreaterThanOrEqual(3);
      await provider.destroy();
    });

    it('memory check disabled → does not call freemem', async () => {
      vi.mocked(os.freemem).mockReturnValue(0);
      const provider = new SubSandboxProvider('/workspace', { memoryCheckEnabled: false });
      try {
        await provider.executeIsolated('echo hello');
      } catch {
        // expected — bwrap missing on non-Linux or other failures
      }
      expect(os.freemem).not.toHaveBeenCalled();
      await provider.destroy();
    });
  });

  describe('load pre-check (Pre-mortem PM4)', () => {
    it('rejects execution when 1m loadavg > 2x cpu count', async () => {
      vi.mocked(os.freemem).mockReturnValue(1024 * 1024 * 1024);
      vi.mocked(os.loadavg).mockReturnValue([100, 50, 25] as [number, number, number]);
      vi.mocked(os.cpus).mockReturnValue([
        { model: 'mock', speed: 0, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } },
      ]);

      const provider = new SubSandboxProvider('/workspace');
      await expect(provider.executeIsolated('echo hello')).rejects.toMatchObject({
        code: 'RESOURCE_INSUFFICIENT',
      });
      await provider.destroy();
    });
  });

  // Real bwrap execution — gated by platform + binary presence
  describe.skipIf(!canRunBwrap)('real bwrap execution', () => {
    it('runs a simple command and returns stdout', async () => {
      const provider = new SubSandboxProvider('/workspace');
      const result = await provider.executeIsolated('echo hello');
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('hello');
      expect(result.killed).toBe(false);
      expect(result.timedOut).toBe(false);
      await provider.destroy();
    });

    it('honours non-zero exit codes', async () => {
      const provider = new SubSandboxProvider('/workspace');
      const result = await provider.executeIsolated('exit 7');
      expect(result.exitCode).toBe(7);
      await provider.destroy();
    });

    it('writes stdin to the child process', async () => {
      const provider = new SubSandboxProvider('/workspace');
      const result = await provider.executeIsolated('cat', { stdin: 'piped-input' });
      expect(result.stdout).toContain('piped-input');
      await provider.destroy();
    });

    it('records isolated.execute audit on success', async () => {
      const audit: Array<{ action: string; detail: Record<string, unknown> }> = [];
      const provider = new SubSandboxProvider('/workspace', undefined, (a, d) => audit.push({ action: a, detail: d }));
      await provider.executeIsolated('echo audited');
      expect(audit.some((c) => c.action === 'isolated.execute')).toBe(true);
      await provider.destroy();
    });

    it('times out when command exceeds timeout', async () => {
      const provider = new SubSandboxProvider('/workspace', { defaultTimeoutMs: 5_000 });
      const result = await provider.executeIsolated('sleep 30', { timeout: 5_000 });
      expect(result.timedOut).toBe(true);
      expect(result.killed).toBe(true);
      await provider.destroy();
    }, 15_000);
  });

  describe('audit trail', () => {
    it('records isolated.cleanup on destroy', async () => {
      const audit: Array<{ action: string; detail: Record<string, unknown> }> = [];
      const provider = new SubSandboxProvider('/workspace', undefined, (a, d) => audit.push({ action: a, detail: d }));
      await provider.destroy();
      const cleanup = audit.find((c) => c.action === 'isolated.cleanup');
      expect(cleanup).toBeDefined();
      expect(cleanup?.detail.sandboxId).toBe(provider.sandboxId);
    });
  });
});

describe('SubSandboxManager', () => {
  describe('concurrency cap (AC5)', () => {
    it('create() returns distinct SubSandboxProvider instances', () => {
      const manager = new SubSandboxManager({
        workspaceDir: '/workspace',
        config: { maxConcurrency: 5 },
      });
      const a = manager.create();
      const b = manager.create();
      expect(a.sandboxId).not.toBe(b.sandboxId);
      expect(manager.activeCount).toBe(2);
    });

    it('create() refuses when active set reaches maxConcurrency', () => {
      const manager = new SubSandboxManager({
        workspaceDir: '/workspace',
        config: { maxConcurrency: 2 },
      });
      manager.create();
      manager.create();
      // Match either the error code or substring of the message
      expect(() => manager.create()).toThrowError(/ISOLATED_CONCURRENCY|max/i);
    });

    it('destroy() frees a slot, allowing further create()', async () => {
      const manager = new SubSandboxManager({
        workspaceDir: '/workspace',
        config: { maxConcurrency: 2 },
      });
      const a = manager.create();
      manager.create();
      expect(manager.activeCount).toBe(2);
      await manager.destroy(a.sandboxId);
      expect(manager.activeCount).toBe(1);
      expect(() => manager.create()).not.toThrow();
    });

    it('default maxConcurrency is 5', () => {
      const manager = new SubSandboxManager({ workspaceDir: '/workspace' });
      expect(manager.maxConcurrency).toBe(5);
    });

    it('destroy() is idempotent for unknown sandboxIds', async () => {
      const manager = new SubSandboxManager({ workspaceDir: '/workspace' });
      await expect(manager.destroy('nonexistent')).resolves.toBeUndefined();
    });

    it('destroyAll() empties the active set', async () => {
      const manager = new SubSandboxManager({
        workspaceDir: '/workspace',
        config: { maxConcurrency: 3 },
      });
      manager.create();
      manager.create();
      manager.create();
      expect(manager.activeCount).toBe(3);
      await manager.destroyAll();
      expect(manager.activeCount).toBe(0);
    });

    it('records isolated.concurrency_rejected audit when refusing', () => {
      const audit: Array<{ action: string; detail: Record<string, unknown> }> = [];
      const manager = new SubSandboxManager({
        workspaceDir: '/workspace',
        config: { maxConcurrency: 1 },
        onAudit: (a, d) => audit.push({ action: a, detail: d }),
      });
      manager.create();
      expect(() => manager.create()).toThrow();
      expect(audit.some((c) => c.action === 'isolated.concurrency_rejected')).toBe(true);
    });

    it('records isolated.create and isolated.destroy audit events', async () => {
      const audit: Array<{ action: string; detail: Record<string, unknown> }> = [];
      const manager = new SubSandboxManager({
        workspaceDir: '/workspace',
        onAudit: (a, d) => audit.push({ action: a, detail: d }),
      });
      const sub = manager.create();
      expect(audit.some((c) => c.action === 'isolated.create')).toBe(true);
      await manager.destroy(sub.sandboxId);
      expect(audit.some((c) => c.action === 'isolated.destroy')).toBe(true);
    });

    it('listActiveIds returns current sandbox ids', async () => {
      const manager = new SubSandboxManager({
        workspaceDir: '/workspace',
        config: { maxConcurrency: 3 },
      });
      const a = manager.create();
      const b = manager.create();
      const ids = manager.listActiveIds();
      expect(ids).toHaveLength(2);
      expect(ids).toContain(a.sandboxId);
      expect(ids).toContain(b.sandboxId);
      await manager.destroyAll();
    });
  });
});
