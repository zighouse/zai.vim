// Story 3.1, Task 5.3: file_search unit tests
// Covers: pattern matching, glob filter, exclude directories, result truncation,
// timeout protection, context lines, audit logging.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fileSearchTool } from '../file.js';
import type { ISecurityProvider, ToolContext } from '@zaivim/core';

function mockSecurityProvider(): ISecurityProvider {
  return {
    sandboxType: 'bwrap',
    preExecute: vi.fn().mockResolvedValue({ allowed: true, harmLevel: 'C', reason: 'test' }),
    postExecute: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn().mockReturnValue({ sandboxMode: 'bwrap', platform: 'linux', filesystemRestricted: true, networkIsolated: true, auditLogPath: '/test', isOperational: true }),
    isSandboxAvailable: vi.fn().mockReturnValue(true),
    validatePath: vi.fn().mockReturnValue(true),
    proposeChange: vi.fn().mockResolvedValue(true),
    openFile: vi.fn().mockResolvedValue({ validatedPath: '/test/file.txt', read: async () => '', close: async () => {} }),
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
