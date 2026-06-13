// Story 3.1, Task 5.2: file_write unit tests
// Covers: new file creation, overwrite (backup+diff), path validation rejection,
// rollback from proposal, directory auto-creation, audit logging.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileWriteTool, generateDiff } from '../file.js';
import type { WriteApproval, ISecurityProvider, ToolContext } from '@zaivim/core';

/**
 * Mock ISecurityProvider. For '.' reads, returns the caller-specified
 * projectRoot (defaults to process.cwd()) so file_write can compute the
 * session-scoped backup directory under that root. For target-path writes,
 * returns the provided WriteApproval (or throws if Error).
 */
function mockSecurityProvider(
  approvalOrError: WriteApproval | Error,
  projectRoot: string = process.cwd(),
): ISecurityProvider {
  return {
    sandboxType: 'bwrap',
    preExecute: vi.fn().mockResolvedValue({ allowed: true, harmLevel: 'B', reason: 'test' }),
    postExecute: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn().mockReturnValue({ sandboxMode: 'bwrap', platform: 'linux', filesystemRestricted: true, networkIsolated: true, auditLogPath: '/test', isOperational: true }),
    isSandboxAvailable: vi.fn().mockReturnValue(true),
    validatePath: vi.fn().mockReturnValue(true),
    proposeChange: vi.fn().mockResolvedValue(true),
    openFile: vi.fn().mockImplementation(async (path: string, operation: string) => {
      if (approvalOrError instanceof Error) throw approvalOrError;
      if (operation === 'read') {
        // file_write calls openFile('.', 'read') to resolve projectRoot
        const root = path === '.' ? projectRoot : path;
        return { validatedPath: root, read: async () => '', close: async () => {} };
      }
      return approvalOrError;
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

describe('fileWriteTool', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'file-write-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('AC4: should create a new file', async () => {
    const filePath = join(tmpDir, 'new-file.ts');
    const approval = { validatedPath: filePath, resolvedPath: filePath };
    const security = mockSecurityProvider(approval, tmpDir);
    const ctx = mockToolContext(security);

    const result = await fileWriteTool.execute({ path: filePath, content: 'const x = 1;' }, ctx);

    expect(result.path).toBe(filePath);
    expect(result.proposal).toBeUndefined(); // New file, no proposal
    expect(result.size).toBeGreaterThan(0);
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, 'utf-8')).toBe('const x = 1;');
  });

  it('AC8: should backup existing file on overwrite and generate diff', async () => {
    const filePath = join(tmpDir, 'existing.ts');
    writeFileSync(filePath, 'const x = 1;', 'utf-8');

    const approval = { validatedPath: filePath, resolvedPath: filePath };
    const security = mockSecurityProvider(approval, tmpDir);
    const ctx = mockToolContext(security);

    const result = await fileWriteTool.execute({ path: filePath, content: 'const x = 2;' }, ctx);

    // Verify proposal exists
    expect(result.proposal).toBeDefined();
    expect(result.proposal!.operation).toBe('modify');
    expect(result.proposal!.originalPath).toBe(filePath);
    expect(result.proposal!.backupPath).toBeTruthy();
    expect(result.proposal!.diff).toContain('const x = 1;');
    expect(result.proposal!.diff).toContain('const x = 2;');
    expect(result.proposal!.proposedContent).toBe('const x = 2;');

    // Verify file content updated
    expect(readFileSync(filePath, 'utf-8')).toBe('const x = 2;');

    // Verify backup was created
    expect(existsSync(result.proposal!.backupPath)).toBe(true);
    expect(readFileSync(result.proposal!.backupPath, 'utf-8')).toBe('const x = 1;');
  });

  it('AC8: backup should be session-scoped under project root (not next to target)', async () => {
    const subDir = join(tmpDir, 'src');
    mkdirSync(subDir, { recursive: true });
    const filePath = join(subDir, 'module.ts');
    writeFileSync(filePath, 'original', 'utf-8');

    const approval = { validatedPath: filePath, resolvedPath: filePath };
    const security = mockSecurityProvider(approval, tmpDir);
    const ctx = mockToolContext(security);

    const result = await fileWriteTool.execute({ path: filePath, content: 'updated' }, ctx);

    const backupPath = result.proposal!.backupPath!;
    // Backup must live under {projectRoot}/.zaivim/backups/{sessionId}/...
    expect(backupPath).toContain(join('.zaivim', 'backups', 'test-session'));
    expect(backupPath).not.toContain(join('src', '.zaivim'));
    // The target's sibling directory should NOT have a .zaivim subdir
    expect(existsSync(join(subDir, '.zaivim'))).toBe(false);
  });

  it('should reject write for paths outside project boundary', async () => {
    const error = Object.assign(new Error('access denied'), { code: 'TOOLS_SECURITY_BLOCKED', reason: 'TOOLS_PATH_OUTSIDE_BOUNDARY' });
    const security = mockSecurityProvider(error);
    const ctx = mockToolContext(security);

    await expect(fileWriteTool.execute({ path: '../../etc/passwd', content: 'hacked' }, ctx)).rejects.toThrow('access denied');
  });

  it('AC8: should support rollback from backup', async () => {
    const filePath = join(tmpDir, 'rollback-test.ts');
    writeFileSync(filePath, 'original content', 'utf-8');

    const approval = { validatedPath: filePath, resolvedPath: filePath };
    const security = mockSecurityProvider(approval, tmpDir);
    const ctx = mockToolContext(security);

    const result = await fileWriteTool.execute({ path: filePath, content: 'modified content' }, ctx);

    // Verify modified
    expect(readFileSync(filePath, 'utf-8')).toBe('modified content');

    // Rollback: copy backup back
    const backupPath = result.proposal!.backupPath;
    writeFileSync(filePath, readFileSync(backupPath, 'utf-8'), 'utf-8');

    // Verify rollback
    expect(readFileSync(filePath, 'utf-8')).toBe('original content');
  });

  it('should auto-create parent directories', async () => {
    const nestedPath = join(tmpDir, 'subdir', 'nested', 'deep-file.ts');
    const approval = { validatedPath: nestedPath, resolvedPath: nestedPath };
    const security = mockSecurityProvider(approval, tmpDir);
    const ctx = mockToolContext(security);

    await fileWriteTool.execute({ path: nestedPath, content: 'nested' }, ctx);

    expect(existsSync(nestedPath)).toBe(true);
    expect(readFileSync(nestedPath, 'utf-8')).toBe('nested');
  });

  it('AC4: should record audit log on write', async () => {
    const filePath = join(tmpDir, 'audit-test.ts');
    const approval = { validatedPath: filePath, resolvedPath: filePath };
    const security = mockSecurityProvider(approval, tmpDir);
    const ctx = mockToolContext(security);

    await fileWriteTool.execute({ path: filePath, content: 'audit me' }, ctx);

    expect(ctx.audit).toHaveBeenCalledWith('file_write', expect.objectContaining({
      path: filePath,
      isNew: true,
    }));
  });

  it('should create new file (no backup) when file does not exist', async () => {
    const filePath = join(tmpDir, 'brand-new.ts');

    const approval = { validatedPath: filePath, resolvedPath: filePath };
    const security = mockSecurityProvider(approval, tmpDir);
    const ctx = mockToolContext(security);

    const result = await fileWriteTool.execute({ path: filePath, content: 'new file' }, ctx);

    expect(result.proposal).toBeUndefined();
    expect(existsSync(filePath)).toBe(true);
  });

  it('should write atomically — no .tmp leftover after success', async () => {
    const filePath = join(tmpDir, 'atomic.ts');

    const approval = { validatedPath: filePath, resolvedPath: filePath };
    const security = mockSecurityProvider(approval, tmpDir);
    const ctx = mockToolContext(security);

    await fileWriteTool.execute({ path: filePath, content: 'atomic content' }, ctx);

    expect(readFileSync(filePath, 'utf-8')).toBe('atomic content');
    const leftovers = readdirSync(tmpDir).filter(f => f.includes('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('should write atomically — overwrite should not leave .tmp leftover', async () => {
    const filePath = join(tmpDir, 'atomic-overwrite.ts');
    writeFileSync(filePath, 'v1', 'utf-8');

    const approval = { validatedPath: filePath, resolvedPath: filePath };
    const security = mockSecurityProvider(approval, tmpDir);
    const ctx = mockToolContext(security);

    await fileWriteTool.execute({ path: filePath, content: 'v2' }, ctx);

    expect(readFileSync(filePath, 'utf-8')).toBe('v2');
    const leftovers = readdirSync(tmpDir).filter(f => f.includes('.tmp'));
    expect(leftovers).toEqual([]);
  });
});

describe('generateDiff', () => {
  it('should generate a unified diff between two strings', () => {
    const original = 'line1\nline2\nline3';
    const proposed = 'line1\nmodified\nline3';

    const diff = generateDiff(original, proposed, 'test.ts');

    expect(diff).toContain('test.ts');
    expect(diff).toContain('-line2');
    expect(diff).toContain('+modified');
  });

  it('should handle identical content', () => {
    const content = 'same\ncontent';
    const diff = generateDiff(content, content, 'same.ts');

    expect(diff).toBeTruthy();
    // For identical content, no hunk markers (@@) should be present
    expect(diff).not.toContain('@@');
  });
});
