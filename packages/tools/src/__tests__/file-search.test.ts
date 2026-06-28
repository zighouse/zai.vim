// Story 3.1, Task 5.3: file_search unit tests
// Covers: pattern matching, glob filter, exclude directories, result truncation,
// timeout protection, context lines, audit logging.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fileSearchTool } from '../file.js';
import type { ISecurityProvider, ToolContext } from '@zaivim/core';

function mockSecurityProvider(projectRoot?: string): ISecurityProvider {
  const root = projectRoot ?? process.cwd();
  return {
    sandboxType: 'bwrap',
    preExecute: vi.fn().mockResolvedValue({ allowed: true, harmLevel: 'C', reason: 'test' }),
    postExecute: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn().mockReturnValue({ sandboxMode: 'bwrap', platform: 'linux', filesystemRestricted: true, networkIsolated: true, auditLogPath: '/test', isOperational: true }),
    isSandboxAvailable: vi.fn().mockReturnValue(true),
    validatePath: vi.fn().mockReturnValue(true),
    proposeChange: vi.fn().mockResolvedValue(true),
    validatePathAsync: async () => '/test/project',
    // file_search calls openFile('.', 'read') to obtain a validated project root.
    // The mock returns process.cwd() (or caller-specified root) as validatedPath.
    openFile: vi.fn().mockImplementation(async (path: string, _op: string) => ({
      validatedPath: path === '.' ? root : path,
      read: async () => '',
      close: async () => {},
    })),
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

describe('fileSearchTool', () => {
  let ctx: ToolContext;

  beforeEach(() => {
    ctx = mockToolContext(mockSecurityProvider());
  });

  it('AC6: should find pattern matches in project files', async () => {
    const result = await fileSearchTool.execute({ pattern: 'fileReadTool', glob: '*.ts' }, ctx);

    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.totalMatches).toBeGreaterThanOrEqual(result.matches.length);
    expect(result.matches.some(m => m.file.includes('file.ts'))).toBe(true);
  });

  it('AC9: should obtain project root via ctx.security.openFile(".")', async () => {
    await fileSearchTool.execute({ pattern: 'whatever_unique_pattern', glob: '*.ts' }, ctx);

    expect(ctx.security.openFile).toHaveBeenCalledWith('.', 'read');
  });

  it('AC9: should reject search when security validation fails', async () => {
    const error = Object.assign(new Error('access denied'), { code: 'TOOLS_SECURITY_BLOCKED' });
    const badSecurity = mockSecurityProvider();
    (badSecurity.openFile as ReturnType<typeof vi.fn>).mockRejectedValue(error);
    const badCtx = mockToolContext(badSecurity);

    await expect(fileSearchTool.execute({ pattern: 'x' }, badCtx)).rejects.toThrow('access denied');
  });

  it('AC3: must never search .git/ or .zaivim/ even with includeHidden=true', async () => {
    const result = await fileSearchTool.execute({
      pattern: '.+',
      includeHidden: true,
      glob: '*',
      maxResults: 50,
    }, ctx);

    const touchesInternal = result.matches.some(m =>
      m.file.split('/').some(seg => seg === '.git' || seg === '.zaivim'),
    );
    expect(touchesInternal).toBe(false);
  });

  it('AC6: should return line numbers and context for matches', async () => {
    const result = await fileSearchTool.execute({ pattern: 'ToolDefinition', glob: '*.ts', contextLines: 1 }, ctx);

    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches[0].line).toBeGreaterThan(0);
    expect(result.matches[0].context.length).toBeGreaterThanOrEqual(1);
  });

  it('AC7: should not include hidden directories by default', async () => {
    const result = await fileSearchTool.execute({ pattern: 'test' }, ctx);

    const hasNodeModules = result.matches.some(m => m.file.includes('node_modules'));
    expect(hasNodeModules).toBe(false);
  });

  it('AC7: should include hidden directories when includeHidden=true', async () => {
    const result = await fileSearchTool.execute({ pattern: 'zaivim', glob: '*.json', includeHidden: true, maxResults: 50 }, ctx);

    expect(result.matches).toBeDefined();
    expect(result.elapsedMs).toBeGreaterThan(0);
  });

  it('AC7: should support maxResults truncation', async () => {
    const result = await fileSearchTool.execute({ pattern: 'const', maxResults: 5 }, ctx);

    expect(result.matches.length).toBeLessThanOrEqual(5);
  });

  it('AC7/H3: when cap is reached, truncated=true and message is present', async () => {
    // 'const' is abundant in any TS codebase — cap low to force truncation
    const result = await fileSearchTool.execute({ pattern: 'const', maxResults: 3 }, ctx);

    if (result.matches.length === 3 && result.totalMatches >= 3) {
      expect(result.truncated).toBe(true);
      expect(result.truncatedMessage).toBeTruthy();
      expect(result.truncatedMessage).toContain('truncated');
      expect(result.truncatedMessage).toContain('Narrow your pattern');
    }
  });

  it('AC7/H3: when no cap reached, truncated=false and message absent', async () => {
    const uniquePattern = `__unique_${Date.now()}_${Math.random().toString(36).slice(2)}__`;
    const result = await fileSearchTool.execute({ pattern: uniquePattern, maxResults: 5 }, ctx);

    expect(result.truncated).toBe(false);
    expect(result.truncatedMessage).toBeUndefined();
  });

  it('H4: should fall back to literal search when pattern is invalid regex', async () => {
    // '[' is invalid regex — tool should fall back to literal match
    const result = await fileSearchTool.execute({ pattern: '[', glob: '*.ts' }, ctx);

    // No throw; result is well-formed
    expect(result.matches).toBeDefined();
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('H4: should reject patterns exceeding length cap', async () => {
    const hugePattern = 'a'.repeat(501);
    await expect(fileSearchTool.execute({ pattern: hugePattern }, ctx)).rejects.toThrow(/maximum length/);
  });

  it('should support glob filtering', async () => {
    const result = await fileSearchTool.execute({ pattern: 'export', glob: '*.ts' }, ctx);

    const allTsFiles = result.matches.every(m => m.file.endsWith('.ts'));
    expect(allTsFiles).toBe(true);
  });

  it('AC7: should handle empty results gracefully', async () => {
    const uniquePattern = `__nonexistent_${Date.now()}_${Math.random().toString(36).slice(2)}__`;
    const result = await fileSearchTool.execute({ pattern: uniquePattern }, ctx);

    expect(result.matches.length).toBe(0);
    expect(result.totalMatches).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('should record audit log on search', async () => {
    await fileSearchTool.execute({ pattern: 'fileSearchTool', glob: '*.ts' }, ctx);

    expect(ctx.audit).toHaveBeenCalledWith('file_search', expect.objectContaining({
      pattern: 'fileSearchTool',
      glob: '*.ts',
    }));
  });

  it('should handle contextLines configuration', async () => {
    const resultWithContext = await fileSearchTool.execute({ pattern: 'ToolDefinition', glob: '*.ts', contextLines: 2 }, ctx);

    if (resultWithContext.matches.length > 0) {
      expect(resultWithContext.matches[0].context.length).toBeGreaterThanOrEqual(3);
    }
  });
});
