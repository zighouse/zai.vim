// =============================================================================
// @zaivim/engine — Agent cancel cascade termination tests
// Story 2.4, Task 1: Agent cancel stops child processes (AC: #2, #7)
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AsyncGeneratorAgent, type AgentDeps } from '../agent/index.js';
import type { ISecurityProvider, ISessionStore, ToolContext } from '@zaivim/core';
import { EventEmitter } from 'node:events';
import * as childProcess from 'node:child_process';

// Hoisted mock for child_process.spawn
const mockSpawn = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>();
  return { ...actual, spawn: mockSpawn };
});

// ---- Mocks ----

function createMockSecurity(): ISecurityProvider {
  return {
    sandboxType: 'none',
    preExecute: vi.fn().mockResolvedValue({ allowed: true, harmLevel: 'C', reason: 'mock' }),
    postExecute: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn().mockReturnValue({
      sandboxMode: 'null',
      platform: 'linux',
      filesystemRestricted: false,
      networkIsolated: false,
      auditLogPath: 'memory',
      isOperational: false,
    }),
    isSandboxAvailable: vi.fn().mockReturnValue(true),
    validatePath: vi.fn().mockReturnValue(true),
    proposeChange: vi.fn().mockResolvedValue(true),
  };
}

function createMockSessionStore(): ISessionStore {
  const sessions = new Map<string, { messages: unknown[] }>();
  return {
    create: vi.fn().mockImplementation(() => 'test-session'),
    get: vi.fn().mockImplementation((id: string) => sessions.get(id) ?? null),
    close: vi.fn().mockResolvedValue(undefined),
    pushMessage: vi.fn(),
    list: vi.fn().mockReturnValue([]),
    recover: vi.fn(),
    updateSessionMeta: vi.fn(),
  };
}

function createMockAuditor() {
  return {
    write: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockChildProcess(pid: number) {
  const proc = new EventEmitter() as any;
  proc.pid = pid;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write: vi.fn(), end: vi.fn() };
  proc.kill = vi.fn();
  return proc as import('node:child_process').ChildProcess;
}

describe('Story 2.4 Task 1: Agent cancel cascade termination', () => {
  let deps: AgentDeps;
  let auditor: ReturnType<typeof createMockAuditor>;
  let security: ISecurityProvider;
  let sessionStore: ISessionStore;
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    auditor = createMockAuditor();
    security = createMockSecurity();
    sessionStore = createMockSessionStore();
    deps = {
      providerRegistry: { get: vi.fn() } as any,
      sessionStore,
      securityProvider: security,
      auditor: auditor as any,
      tools: [],
    };
    killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {});
  });

  afterEach(() => {
    killSpy.mockRestore();
    mockSpawn.mockReset();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ---- Task 1.1 & 1.2: PID tracking ----

  it('should track spawned process PIDs (Task 1.1, 1.2)', () => {
    const agent = new AsyncGeneratorAgent(
      { name: 'test', systemPrompt: 'test' },
      deps,
    );

    agent.trackProcess(12345);
    agent.trackProcess(67890);
    agent.cancel('test');

    // kill(pid, 0) called for both PIDs (verification before SIGTERM)
    expect(killSpy).toHaveBeenCalledWith(12345, 0);
    expect(killSpy).toHaveBeenCalledWith(67890, 0);
  });

  it('should untrack process on normal completion (Task 1.2)', () => {
    const agent = new AsyncGeneratorAgent(
      { name: 'test', systemPrompt: 'test' },
      deps,
    );

    agent.trackProcess(12345);
    agent.untrackProcess(12345);
    agent.cancel('test');

    // 12345 should NOT receive SIGTERM (was untracked)
    const sigtermCalls = killSpy.mock.calls.filter(
      (c: any[]) => c[1] === 'SIGTERM',
    );
    expect(sigtermCalls).toHaveLength(0);
  });

  // ---- Task 1.3: Cascade termination via kill(-pid) ----

  it('should send SIGTERM to all tracked PIDs on cancel (Task 1.3)', () => {
    const agent = new AsyncGeneratorAgent(
      { name: 'test', systemPrompt: 'test' },
      deps,
    );

    agent.trackProcess(1001);
    agent.trackProcess(1002);
    agent.cancel('user requested');

    // kill(pid, 0) verification for each PID
    expect(killSpy).toHaveBeenCalledWith(1001, 0);
    expect(killSpy).toHaveBeenCalledWith(1002, 0);
    // SIGTERM sent to process groups
    expect(killSpy).toHaveBeenCalledWith(-1001, 'SIGTERM');
    expect(killSpy).toHaveBeenCalledWith(-1002, 'SIGTERM');
  });

  it('should schedule SIGKILL for survivors after 5s (Task 1.6, NFR25)', () => {
    const agent = new AsyncGeneratorAgent(
      { name: 'test', systemPrompt: 'test' },
      deps,
    );

    agent.trackProcess(1001);
    agent.cancel('test');

    // After 5s, SIGKILL should be sent
    vi.advanceTimersByTime(5000);

    expect(killSpy).toHaveBeenCalledWith(-1001, 'SIGKILL');
  });

  // ---- Task 1.4: Timeout timer (3600s, NFR24) ----

  it('should auto-cancel after timeout (Task 1.4, NFR24)', () => {
    const cancelSpy = vi.spyOn(AsyncGeneratorAgent.prototype, 'cancel');
    const agent = new AsyncGeneratorAgent(
      { name: 'test', systemPrompt: 'test' },
      deps,
    );

    // When timeout fires, cancel should be called
    vi.advanceTimersByTime(3600_000);

    expect(cancelSpy).toHaveBeenCalledWith('timeout: 3600s exceeded');
    cancelSpy.mockRestore();
  });

  // ---- Task 1.5: Audit on timeout cancel ----

  it('should record audit event on cancel (Task 1.5)', () => {
    const agent = new AsyncGeneratorAgent(
      { name: 'test', systemPrompt: 'test' },
      deps,
    );

    agent.cancel('timeout: 3600s exceeded');

    expect(auditor.write).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'agent.cancel',
        level: 'B',
        reason: 'timeout: 3600s exceeded',
      }),
    );
  });

  // ---- Task 1.7: Cancel idempotency ----

  it('should be idempotent — cancel() only executes once (Task 1.7)', () => {
    const agent = new AsyncGeneratorAgent(
      { name: 'test', systemPrompt: 'test' },
      deps,
    );

    agent.trackProcess(1001);
    agent.cancel('first');
    agent.cancel('second'); // Should be ignored
    agent.cancel('third');  // Should be ignored

    // SIGTERM should be called once for the process
    const sigtermCalls = killSpy.mock.calls.filter(
      (c: any[]) => c[1] === 'SIGTERM',
    );
    expect(sigtermCalls).toHaveLength(1);
  });

  // ---- Task 1.8: PID recycling safety ----

  it('should handle ESRCH when PID no longer exists (Task 1.8)', () => {
    // Make kill(pid, 0) throw ESRCH for all PIDs
    killSpy.mockImplementation((pid: any, signal?: any) => {
      if (signal === 0) {
        throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      }
    });

    const agent = new AsyncGeneratorAgent(
      { name: 'test', systemPrompt: 'test' },
      deps,
    );

    agent.trackProcess(9999);
    // Should not throw
    expect(() => agent.cancel('test')).not.toThrow();
  });

  it('should handle EPERM and still attempt SIGKILL (Task 1.11)', () => {
    // kill(pid, 0) returns EPERM → different from ESRCH
    killSpy.mockImplementation((pid: any, signal?: any) => {
      if (signal === 0) {
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      }
    });

    const agent = new AsyncGeneratorAgent(
      { name: 'test', systemPrompt: 'test' },
      deps,
    );

    agent.trackProcess(1001);
    agent.cancel('test');

    // SIGKILL should still be attempted after 5s (EPERM means PID exists but can't check)
    vi.advanceTimersByTime(5000);
    expect(killSpy).toHaveBeenCalledWith(-1001, 'SIGKILL');
  });

  // ---- Task 1.9: Process group escape fallback (setsid protection) ----

  it('should not throw during cleanup scan after cancel (Task 1.9)', () => {
    const agent = new AsyncGeneratorAgent(
      { name: 'test', systemPrompt: 'test' },
      deps,
    );

    agent.trackProcess(1001);
    agent.cancel('test');

    // Advance past the 30s cleanup scan trigger
    expect(() => vi.advanceTimersByTime(30000)).not.toThrow();
  });

  it('should log orphan alert if survivors remain after 3 scans (Task 1.13)', () => {
    const agent = new AsyncGeneratorAgent(
      { name: 'test', systemPrompt: 'test' },
      deps,
    );

    // Make kill(pid, 0) always succeed — PID stays alive (simulates orphan)
    killSpy.mockImplementation(() => {});

    agent.trackProcess(1001);
    agent.cancel('test');

    // Fast forward through 3 cascade scans (30s then 60s then 120s = 210s total)
    vi.advanceTimersByTime(300_000);

    // Should have recorded orphan detection at final (3rd) scan
    const orphanAlerts = auditor.write.mock.calls.filter(
      (c: any[]) => c[0]?.operation === 'security.orphan_processes_detected',
    );
    expect(orphanAlerts.length).toBeGreaterThanOrEqual(1);
  });

  // ---- Task 1.10: Cancel → postExecute audit chain ----

  it('should register and unregister tool calls (Task 1.10)', () => {
    const agent = new AsyncGeneratorAgent(
      { name: 'test', systemPrompt: 'test' },
      deps,
    );

    agent.registerToolCall('call-1', 'file_read');
    agent.registerToolCall('call-2', 'shell_exec');
    agent.cancel('test');

    // Both tool calls should be recorded as cancelled in audit
    const toolAudits = auditor.write.mock.calls.filter(
      (c: any[]) => c[0]?.operation === 'file_read' || c[0]?.operation === 'shell_exec',
    );
    expect(toolAudits.length).toBeGreaterThanOrEqual(2);
  });

  it('should not audit already-completed tool calls (Task 1.10)', () => {
    const agent = new AsyncGeneratorAgent(
      { name: 'test', systemPrompt: 'test' },
      deps,
    );

    agent.registerToolCall('call-1', 'file_read');
    agent.unregisterToolCall('call-1'); // Completed normally
    agent.registerToolCall('call-2', 'shell_exec');
    agent.cancel('test');

    // Only call-2 should be in active tool calls
    const fileReadAudits = auditor.write.mock.calls.filter(
      (c: any[]) => c[0]?.operation === 'file_read',
    );
    expect(fileReadAudits).toHaveLength(0);

    const shellAudits = auditor.write.mock.calls.filter(
      (c: any[]) => c[0]?.operation === 'shell_exec',
    );
    expect(shellAudits.length).toBeGreaterThanOrEqual(1);
  });

  // ---- Task 1.14: Partial cancel (independent try/catch per step) ----

  it('should complete partial cancel when one step fails (Task 1.14)', () => {
    const agent = new AsyncGeneratorAgent(
      { name: 'test', systemPrompt: 'test' },
      deps,
    );

    // Make SIGTERM step throw
    killSpy.mockImplementation(() => {
      throw new Error('mock failure');
    });

    agent.trackProcess(1001);
    agent.registerToolCall('call-1', 'file_read');

    // Should NOT throw — partial cancel should complete all steps independently
    expect(() => agent.cancel('test')).not.toThrow();
  });

  // ---- ToolContext spawn injection ----

  it('should provide spawn method in ToolContext (Task 1.3)', () => {
    const agent = new AsyncGeneratorAgent(
      { name: 'test', systemPrompt: 'test' },
      deps,
    );

    const ctx: ToolContext = agent.createToolContext('test-session');
    expect(ctx.spawn).toBeDefined();
    expect(typeof ctx.spawn).toBe('function');
  });

  it('should track processes created via ToolContext.spawn and terminate on cancel', () => {
    const childProc = createMockChildProcess(5001);
    mockSpawn.mockReturnValue(childProc);

    const agent = new AsyncGeneratorAgent(
      { name: 'test', systemPrompt: 'test' },
      deps,
    );

    const ctx: ToolContext = agent.createToolContext('test-session');
    ctx.spawn('echo', ['hello']);

    // Child process should be tracked
    agent.cancel('test');

    expect(killSpy).toHaveBeenCalledWith(5001, 0);
    expect(killSpy).toHaveBeenCalledWith(-5001, 'SIGTERM');
  });

  it('should not track zero PID (Task 1.2 edge case)', () => {
    const agent = new AsyncGeneratorAgent(
      { name: 'test', systemPrompt: 'test' },
      deps,
    );

    agent.trackProcess(0);
    agent.trackProcess(-1);
    agent.cancel('test');

    // Should not attempt to kill invalid PIDs (0 or -1)
    const sigtermCalls = killSpy.mock.calls.filter(
      (c: any[]) => c[1] === 'SIGTERM',
    );
    expect(sigtermCalls).toHaveLength(0);
  });
});
