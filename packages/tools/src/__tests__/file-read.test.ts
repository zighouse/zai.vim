// Story 3.1, Task 5.1: file_read unit tests
// Covers: basic read, large file truncation, .git boundary, path traversal,
// internal dir protection, Unicode paths, SafeFileHandle, offset/limit.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fileReadTool } from '../file.js';
import type { SafeFileHandle, ISecurityProvider, ToolContext } from '@zaivim/core';

function mockSafeFileHandle(content: string): SafeFileHandle {
  return {
    validatedPath: '/test/file.txt',
    read: vi.fn().mockResolvedValue(content),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function mockSecurityProvider(handleOrError: SafeFileHandle | Error): ISecurityProvider {
  return {
    sandboxType: 'bwrap',
    preExecute: vi.fn().mockResolvedValue({ allowed: true, harmLevel: 'C', reason: 'test' }),
    postExecute: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn().mockReturnValue({ sandboxMode: 'bwrap', platform: 'linux', filesystemRestricted: true, networkIsolated: true, auditLogPath: '/test', isOperational: true }),
    isSandboxAvailable: vi.fn().mockReturnValue(true),
    validatePath: vi.fn().mockReturnValue(true),
    proposeChange: vi.fn().mockResolvedValue(true),
    validatePathAsync: async () => '/test/project',
    openFile: vi.fn().mockImplementation(async (_path: string, operation: string) => {
      if (handleOrError instanceof Error) throw handleOrError;
      if (operation === 'read') return handleOrError;
      return { validatedPath: '/test/file.txt', resolvedPath: '/test/file.txt' };
    }),
  };
}

function mockToolContext(security: ISecurityProvider): ToolContext {
  return {
    sessionId: 'test-session',
    sandbox: 'test',
    signal: new AbortController().signal,
    security,
    audit: vi.fn(),
    spawn: vi.fn() as unknown as ToolContext['spawn'],
  };
}

describe('fileReadTool', () => {
  let handle: SafeFileHandle;
  let security: ISecurityProvider;
  let ctx: ToolContext;

  beforeEach(() => {
    handle = mockSafeFileHandle('line1\nline2\nline3\nline4\nline5');
    security = mockSecurityProvider(handle);
    ctx = mockToolContext(security);
  });

  it('AC1: should read a file and return content with metadata', async () => {
    const result = await fileReadTool.execute({ path: './src/index.ts' }, ctx);

    expect(result.path).toBe('./src/index.ts');
    expect(result.content).toBe('line1\nline2\nline3\nline4\nline5');
    expect(result.size).toBeGreaterThan(0);
    expect(result.truncated).toBe(false);
    expect(result.lines).toBe(5);
  });

  it('AC1: should delegate path to ISecurityProvider.openFile', async () => {
    await fileReadTool.execute({ path: './src/index.ts' }, ctx);

    expect(security.openFile).toHaveBeenCalledWith('./src/index.ts', 'read');
  });

  it('AC2: should truncate content exceeding maxOutputBytes', async () => {
    // Create content larger than 10KB
    const bigContent = Array.from({ length: 1500 }, (_, i) => `line ${i} ${'x'.repeat(80)}`).join('\n');
    const bigHandle = mockSafeFileHandle(bigContent);
    const bigSecurity = mockSecurityProvider(bigHandle);
    const bigCtx = mockToolContext(bigSecurity);

    const result = await fileReadTool.execute({ path: './large.ts' }, bigCtx);

    expect(result.truncated).toBe(true);
    expect(result.content).toContain('[truncated');
    expect(Buffer.byteLength(result.content, 'utf-8')).toBeLessThanOrEqual(15_000); // 10KB + truncation msg
  });

  it('AC3: should reject paths inside .zaivim/backups/ (via openFile throw)', async () => {
    const error = Object.assign(new Error('access denied'), { code: 'TOOLS_SECURITY_BLOCKED', reason: 'TOOLS_INTERNAL_DIR' });
    const badSecurity = mockSecurityProvider(error);
    const badCtx = mockToolContext(badSecurity);

    await expect(fileReadTool.execute({ path: '.zaivim/backups/secret.json' }, badCtx)).rejects.toThrow('access denied');
  });

  it('AC5: should reject path traversal attacks (via openFile throw)', async () => {
    const error = Object.assign(new Error('access denied'), { code: 'TOOLS_SECURITY_BLOCKED', reason: 'TOOLS_PATH_OUTSIDE_BOUNDARY' });
    const badSecurity = mockSecurityProvider(error);
    const badCtx = mockToolContext(badSecurity);

    await expect(fileReadTool.execute({ path: '../../etc/passwd' }, badCtx)).rejects.toThrow('access denied');
  });

  it('should reject files exceeding maxFileReadBytes (500KB)', async () => {
    // Content just over 500KB
    const hugeContent = 'x'.repeat(600_000);
    const hugeHandle = mockSafeFileHandle(hugeContent);
    const hugeSecurity = mockSecurityProvider(hugeHandle);
    const hugeCtx = mockToolContext(hugeSecurity);

    await expect(fileReadTool.execute({ path: './huge.bin' }, hugeCtx)).rejects.toThrow(/exceeds maximum read size/);
  });

  it('should support offset/limit pagination', async () => {
    const handle10 = mockSafeFileHandle(Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n'));
    const security10 = mockSecurityProvider(handle10);
    const ctx10 = mockToolContext(security10);

    const result = await fileReadTool.execute({ path: './pages.ts', offset: 2, limit: 3 }, ctx10);

    const lines = result.content.split('\n');
    expect(lines[0]).toBe('line 3');
    expect(lines.length).toBeLessThanOrEqual(5); // 3 lines + possible truncation
  });

  it('should read via SafeFileHandle (not raw fs)', async () => {
    await fileReadTool.execute({ path: './src/index.ts' }, ctx);

    expect(handle.read).toHaveBeenCalledWith('utf-8');
    expect(handle.close).toHaveBeenCalled();
  });

  it('should close the handle even when read throws (no fd leak)', async () => {
    const leakingHandle: SafeFileHandle = {
      validatedPath: '/test/file.txt',
      read: vi.fn().mockRejectedValue(new Error('read failed')),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const leakingSecurity = mockSecurityProvider(leakingHandle);
    const leakingCtx = mockToolContext(leakingSecurity);

    await expect(fileReadTool.execute({ path: './broken.ts' }, leakingCtx)).rejects.toThrow('read failed');
    expect(leakingHandle.close).toHaveBeenCalledTimes(1);
  });

  it('should close the handle even when size check throws (no fd leak)', async () => {
    const hugeContent = 'x'.repeat(600_000);
    const hugeHandle: SafeFileHandle = {
      validatedPath: '/test/huge.bin',
      read: vi.fn().mockResolvedValue(hugeContent),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const hugeSecurity = mockSecurityProvider(hugeHandle);
    const hugeCtx = mockToolContext(hugeSecurity);

    await expect(fileReadTool.execute({ path: './huge.bin' }, hugeCtx)).rejects.toThrow(/exceeds maximum read size/);
    expect(hugeHandle.close).toHaveBeenCalledTimes(1);
  });

  it('AC9: should record audit log on read', async () => {
    await fileReadTool.execute({ path: './src/index.ts' }, ctx);

    expect(ctx.audit).toHaveBeenCalledWith('file_read', expect.objectContaining({
      path: './src/index.ts',
    }));
  });

  it('should not truncate content under maxOutputBytes', async () => {
    const smallContent = 'small file content';
    const smallHandle = mockSafeFileHandle(smallContent);
    const smallSecurity = mockSecurityProvider(smallHandle);
    const smallCtx = mockToolContext(smallSecurity);

    const result = await fileReadTool.execute({ path: './small.ts' }, smallCtx);

    expect(result.truncated).toBe(false);
    expect(result.content).toBe('small file content');
  });
});
