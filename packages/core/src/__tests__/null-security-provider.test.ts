// Story 3.3, Task 1.4: NullSecurityProvider unit tests
// Verifies all ISecurityProvider members return allowed/true and emit warnings.

import { describe, it, expect, vi } from 'vitest';
import { NullSecurityProvider } from '../security/null-provider.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('NullSecurityProvider', () => {
  it('sandboxType is "none"', () => {
    const provider = new NullSecurityProvider();
    expect(provider.sandboxType).toBe('none');
  });

  it('preExecute returns allowed with harmLevel C and warns', async () => {
    const warn = vi.fn();
    const provider = new NullSecurityProvider({ logger: { warn } });
    const decision = await provider.preExecute('shell_exec', { command: 'rm -rf /' });
    expect(decision.allowed).toBe(true);
    expect(decision.harmLevel).toBe('C');
    expect(decision.reason).toMatch(/NullSecurityProvider/);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('fallback in use'));
  });

  it('postExecute is non-blocking and logs warning', async () => {
    const warn = vi.fn();
    const provider = new NullSecurityProvider({ logger: { warn } });
    await expect(
      provider.postExecute('file_write', { success: true, output: 'ok' }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it('getStatus returns a complete SecurityStatus', () => {
    const provider = new NullSecurityProvider();
    const status = provider.getStatus();
    expect(status.sandboxMode).toBe('null');
    expect(status.filesystemRestricted).toBe(false);
    expect(status.networkIsolated).toBe(false);
    expect(status.isOperational).toBe(false);
    expect(status.details).toEqual(
      expect.arrayContaining([expect.stringContaining('NullSecurityProvider')]),
    );
    expect(['linux', 'macos', 'windows', 'unknown']).toContain(status.platform);
  });

  it('isSandboxAvailable returns false', () => {
    const provider = new NullSecurityProvider();
    expect(provider.isSandboxAvailable()).toBe(false);
  });

  it('openFile(read) returns a usable SafeFileHandle', async () => {
    const warn = vi.fn();
    const dir = mkdtempSync(join(tmpdir(), 'zai-null-sec-'));
    try {
      const filePath = join(dir, 'sample.txt');
      writeFileSync(filePath, 'hello world');
      const provider = new NullSecurityProvider({ logger: { warn } });
      const handle = await provider.openFile(filePath, 'read');
      expect(handle.validatedPath).toBe(filePath);
      const content = await handle.read('utf-8');
      expect(content).toBe('hello world');
      await handle.close();
      expect(warn).toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('openFile(write) returns a WriteApproval and warns', async () => {
    const warn = vi.fn();
    const provider = new NullSecurityProvider({ logger: { warn } });
    const approval = await provider.openFile('/tmp/whatever.txt', 'write');
    expect(approval.validatedPath).toBeDefined();
    expect(approval.resolvedPath).toBeDefined();
    expect(warn).toHaveBeenCalled();
  });

  it('validatePath returns true (deprecated passthrough)', () => {
    const warn = vi.fn();
    const provider = new NullSecurityProvider({ logger: { warn } });
    expect(provider.validatePath('/etc/passwd', 'read')).toBe(true);
    expect(warn).toHaveBeenCalled();
  });

  it('proposeChange resolves true (deprecated passthrough)', async () => {
    const warn = vi.fn();
    const provider = new NullSecurityProvider({ logger: { warn } });
    const result = await provider.proposeChange({
      path: '/dangerous',
      operation: 'delete',
      reason: 'test',
    });
    expect(result).toBe(true);
    expect(warn).toHaveBeenCalled();
  });

  it('falls back to console.warn when logger is omitted', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const provider = new NullSecurityProvider();
      await provider.preExecute('file_read', {});
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('logger throwing does not bubble up', async () => {
    const provider = new NullSecurityProvider({
      logger: { warn: () => { throw new Error('boom'); } },
    });
    await expect(provider.preExecute('file_read', {})).resolves.toMatchObject({
      allowed: true,
    });
  });
});
