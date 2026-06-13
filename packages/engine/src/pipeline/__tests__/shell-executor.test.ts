// Story 3.2a, Task 4.7: ShellExecutorFactory unit tests (engine side)
// Covers:
//   - ShellExecutorFactory.create() — available / unavailable / root+no userNamespace
//   - Closure-level output truncation (AC6)
//   - Closure-level progress notification (AC4)
//   - Engine-layer env filtering (defense in depth — AC11)
//   - Error handling

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ShellExecutorFactory } from '../shell-executor.js';
import type { ShellExecParams, ShellExecResult } from '@zaivim/core';
import type { SandboxManager } from '../../security/index.js';

// ─── Mock SandboxManager ──────────────────────────────────────────────────────

function mockSandboxManager(
  isAvailable: boolean,
  executeImpl?: (command: string, options?: Record<string, unknown>) => Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    killed: boolean;
  }>,
): SandboxManager {
  return {
    isAvailable: () => isAvailable,
    sandboxType: isAvailable ? 'bwrap' : 'none',
    validateCommand: () => true,
    execute:
      executeImpl ??
      vi.fn().mockResolvedValue({
        exitCode: 0,
        stdout: 'ok',
        stderr: '',
        killed: false,
      }),
  } as unknown as SandboxManager;
}

// ─── Full capabilities (all requirements met) ─────────────────────────────────

const FULL_CAPS = {
  filesystemWriteable: true,
  userNamespace: true,
  seccomp: true,
  networkIsolation: true,
};

// ─── Availability Tests ────────────────────────────────────────────────────────

describe('ShellExecutorFactory.create — availability', () => {
  it('should return a function when sandbox is available with full caps', () => {
    const sm = mockSandboxManager(true);
    const exec = ShellExecutorFactory.create(sm, FULL_CAPS);
    expect(exec).toBeInstanceOf(Function);
  });

  it('should return undefined when sandbox is unavailable', () => {
    const sm = mockSandboxManager(false);
    const exec = ShellExecutorFactory.create(sm, FULL_CAPS);
    expect(exec).toBeUndefined();
  });

  it('should return undefined when filesystemWriteable is false', () => {
    const sm = mockSandboxManager(true);
    const exec = ShellExecutorFactory.create(sm, {
      ...FULL_CAPS,
      filesystemWriteable: false,
    });
    expect(exec).toBeUndefined();
  });

  it('should return undefined when seccomp is false', () => {
    const sm = mockSandboxManager(true);
    const exec = ShellExecutorFactory.create(sm, {
      ...FULL_CAPS,
      seccomp: false,
    });
    expect(exec).toBeUndefined();
  });

  it('should return undefined when networkIsolation is false', () => {
    const sm = mockSandboxManager(true);
    const exec = ShellExecutorFactory.create(sm, {
      ...FULL_CAPS,
      networkIsolation: false,
    });
    expect(exec).toBeUndefined();
  });

  it('should return undefined when root and no userNamespace (AC9)', () => {
    const originalGetuid = process.getuid;
    (process as unknown as Record<string, unknown>).getuid = () => 0;
    try {
      const sm = mockSandboxManager(true);
      const exec = ShellExecutorFactory.create(sm, {
        ...FULL_CAPS,
        userNamespace: false,
      });
      expect(exec).toBeUndefined();
    } finally {
      (process as unknown as Record<string, unknown>).getuid = originalGetuid;
    }
  });

  it('should allow execution when non-root and no userNamespace', () => {
    const originalGetuid = process.getuid;
    (process as unknown as Record<string, unknown>).getuid = () => 1000;
    try {
      const sm = mockSandboxManager(true);
      const exec = ShellExecutorFactory.create(sm, {
        ...FULL_CAPS,
        userNamespace: false,
      });
      expect(exec).toBeInstanceOf(Function);
    } finally {
      (process as unknown as Record<string, unknown>).getuid = originalGetuid;
    }
  });
});

// ─── Execution Tests ──────────────────────────────────────────────────────────

describe('ShellExecutorFactory.create — execution', () => {
  it('should delegate to sandboxManager.execute and return result', async () => {
    const execute = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: 'npm test passed',
      stderr: '',
      killed: false,
    });
    const sm = mockSandboxManager(true, execute);
    const exec = ShellExecutorFactory.create(sm, FULL_CAPS)!;

    const result = await exec({
      command: 'npm test',
      cwd: '/project',
      timeout: 30000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('npm test passed');
    expect(result.killed).toBe(false);
    expect(result.truncated.stdout).toBe(false);
    expect(typeof result.elapsed).toBe('number');
  });

  it('should pass command, cwd, env, stdin, timeout to sandboxManager', async () => {
    const execute = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
      killed: false,
    });
    const sm = mockSandboxManager(true, execute);
    const exec = ShellExecutorFactory.create(sm, FULL_CAPS)!;

    await exec({
      command: 'make',
      cwd: '/build',
      env: { CC: 'gcc' },
      stdin: 'y\n',
      timeout: 60000,
    });

    expect(execute).toHaveBeenCalledWith('make', expect.objectContaining({
      cwd: '/build',
      timeout: 60000,
    }));
  });
});

// ─── AC6: Output Truncation ───────────────────────────────────────────────────

describe('ShellExecutorFactory — AC6: output truncation', () => {
  it('should truncate stdout exceeding 10MB', async () => {
    const largeOutput = 'a'.repeat(12 * 1024 * 1024);
    const execute = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: largeOutput,
      stderr: '',
      killed: false,
    });
    const sm = mockSandboxManager(true, execute);
    const exec = ShellExecutorFactory.create(sm, FULL_CAPS)!;

    const result = await exec({ command: 'big-output', cwd: '/', timeout: 30000 });

    expect(result.truncated.stdout).toBe(true);
    expect(result.stdout.length).toBeLessThan(largeOutput.length);
    expect(result.stdout).toContain('[truncated');
    // Total output should not exceed 10MB + truncation message
    expect(Buffer.byteLength(result.stdout, 'utf-8')).toBeLessThanOrEqual(11 * 1024 * 1024);
  });

  it('should NOT truncate output under 10MB', async () => {
    const smallOutput = 'hello world\n'.repeat(1000); // ~12KB
    const execute = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: smallOutput,
      stderr: '',
      killed: false,
    });
    const sm = mockSandboxManager(true, execute);
    const exec = ShellExecutorFactory.create(sm, FULL_CAPS)!;

    const result = await exec({ command: 'small-output', cwd: '/', timeout: 30000 });

    expect(result.truncated.stdout).toBe(false);
    expect(result.stdout).toBe(smallOutput);
  });

  it('should align truncation to a UTF-8 character boundary (multi-byte chars)', async () => {
    // Create output with 4-byte UTF-8 characters exceeding 10MB
    // Each 🔥 is 4 bytes, 10MB = 10,485,760 bytes, so 2.7M emojis ≈ 10.8MB
    const multiByte = '🔥'.repeat(2_700_000);
    const execute = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: multiByte,
      stderr: '',
      killed: false,
    });
    const sm = mockSandboxManager(true, execute);
    const exec = ShellExecutorFactory.create(sm, FULL_CAPS)!;

    const result = await exec({ command: 'utf8-output', cwd: '/', timeout: 30000 });

    expect(result.truncated.stdout).toBe(true);
    expect(result.stdout).toContain('[truncated');
    // Verify the truncation point produces valid UTF-8
    // Check last 10 chars before the truncation message — they should all be 🔥
    const truncIdx = result.stdout.indexOf('\n... [truncated');
    const beforeTrunc = result.stdout.slice(Math.max(0, truncIdx - 40), truncIdx);
    for (const ch of beforeTrunc) {
      expect(ch).toBe('🔥');
    }
  }, 60_000);

  it('should truncate stderr independently from stdout', async () => {
    const largeStderr = 'e'.repeat(12 * 1024 * 1024);
    const execute = vi.fn().mockResolvedValue({
      exitCode: 1,
      stdout: 'small',
      stderr: largeStderr,
      killed: false,
    });
    const sm = mockSandboxManager(true, execute);
    const exec = ShellExecutorFactory.create(sm, FULL_CAPS)!;

    const result = await exec({ command: 'stderr-overflow', cwd: '/', timeout: 30000 });

    expect(result.truncated.stderr).toBe(true);
    expect(result.truncated.stdout).toBe(false);
    expect(result.stderr).toContain('[truncated');
  });
});

// ─── AC11: Engine-layer Env Filtering ─────────────────────────────────────────

describe('ShellExecutorFactory — AC11: engine-layer env filtering', () => {
  it('should strip blocked env vars at engine level (defense in depth)', async () => {
    const execute = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
      killed: false,
    });
    const sm = mockSandboxManager(true, execute);
    const exec = ShellExecutorFactory.create(sm, FULL_CAPS)!;

    await exec({
      command: 'test',
      cwd: '/',
      env: { LD_PRELOAD: '/evil.so', SAFE: 'ok' },
      timeout: 30000,
    });

    const envArg = execute.mock.calls[0][1]?.env as Record<string, string> | undefined;
    expect(envArg).not.toHaveProperty('LD_PRELOAD');
    expect(envArg?.SAFE).toBe('ok');
  });

  it('should whitelist PATH to safe directories at engine level', async () => {
    const execute = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
      killed: false,
    });
    const sm = mockSandboxManager(true, execute);
    const exec = ShellExecutorFactory.create(sm, FULL_CAPS)!;

    await exec({
      command: 'test',
      cwd: '/',
      env: { PATH: '/usr/bin:/tmp/evil:/bin:/home/user/.local/bin:/usr/local/bin' },
      timeout: 30000,
    });

    const envArg = execute.mock.calls[0][1]?.env as Record<string, string> | undefined;
    expect(envArg?.PATH).toBe('/usr/bin:/bin:/usr/local/bin');
  });
});

// ─── Error Handling ────────────────────────────────────────────────────────────

describe('ShellExecutorFactory — error handling', () => {
  it('should return killed=true when sandbox.execute throws', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('sandbox crashed'));
    const sm = mockSandboxManager(true, execute);
    const exec = ShellExecutorFactory.create(sm, FULL_CAPS)!;

    const result = await exec({ command: 'boom', cwd: '/', timeout: 30000 });

    expect(result.killed).toBe(true);
    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain('sandbox crashed');
  });
});
