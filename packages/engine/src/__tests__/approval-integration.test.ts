// @zaivim/engine — ApprovalManager integration tests (Story 3.5)
// Tests the full file_write → submit → accept/reject flow via ToolExecutor.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ApprovalManager } from '../pipeline/approval-manager.js';
import { fileWriteTool } from '@zaivim/tools';
import type { ToolContext, FileChangeProposal, PendingApproval } from '@zaivim/core';

// ─── Helpers ───────────────────────────────────────────────────────────────────

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'approval-int-'));
});

afterEach(() => {
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function createManager() {
  const onAudit = vi.fn();
  const onEmit = vi.fn();
  return {
    manager: new ApprovalManager({ onAudit, onEmit }),
    onAudit,
    onEmit,
  };
}

/**
 * Create a ToolContext with requestApproval wired to an ApprovalManager.
 */
function createCtxWithApproval(
  manager: ApprovalManager,
  overrides?: Partial<ToolContext>,
): ToolContext {
  return {
    sessionId: overrides?.sessionId ?? 'test-session',
    sandbox: tempDir,
    signal: new AbortController().signal,
    security: createMockSecurity(tempDir),
    audit: vi.fn(),
    spawn: vi.fn() as any,
    requestApproval: async (proposal: FileChangeProposal): Promise<PendingApproval> => {
      return manager.submit(proposal);
    },
    ...overrides,
  };
}

function createMockSecurity(baseDir: string): any {
  return {
    sandboxType: 'none' as const,
    openFile: vi.fn().mockImplementation(async (path: string, op: string) => {
      if (op === 'read') {
        return { validatedPath: baseDir, read: vi.fn().mockResolvedValue(''), close: vi.fn() };
      }
      const targetFile = path.startsWith('/') ? path : join(baseDir, path);
      // Ensure parent dir exists
      mkdirSync(join(baseDir, 'src'), { recursive: true });
      return { validatedPath: targetFile, resolvedPath: targetFile };
    }),
    preExecute: vi.fn().mockResolvedValue({ allowed: true, harmLevel: 'B', reason: 'test' }),
    postExecute: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn(),
    isSandboxAvailable: vi.fn().mockReturnValue(false),
    validatePath: vi.fn().mockReturnValue(true),
    proposeChange: vi.fn().mockResolvedValue(true),
  };
}

/** Initialize a file in temp dir that can be "modified" */
function initTestFile(subPath: string, content = 'original'): void {
  const fullPath = join(tempDir, subPath);
  mkdirSync(join(tempDir, subPath.replace(/\/[^/]+$/, '')), { recursive: true });
  writeFileSync(fullPath, content, 'utf-8');
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('Approval Integration — file_write with requestApproval', () => {
  it('file_write with requestApproval returns pending=true and changeId', async () => {
    const { manager } = createManager();
    const ctx = createCtxWithApproval(manager);
    initTestFile('src/test.ts');

    const result = await fileWriteTool.execute(
      { path: 'src/test.ts', content: 'new content' },
      ctx,
    );

    expect(result.pending).toBe(true);
    expect(result.changeId).toBeTruthy();
    expect(result.proposal).toBeDefined();
  });

  it('file_write without requestApproval writes immediately (backward compat)', async () => {
    const ctx: ToolContext = {
      sessionId: 'test-session',
      sandbox: tempDir,
      signal: new AbortController().signal,
      security: createMockSecurity(tempDir),
      audit: vi.fn(),
      spawn: vi.fn() as any,
    };

    const result = await fileWriteTool.execute(
      { path: `${tempDir}/newfile.ts`, content: 'test content' },
      ctx,
    );

    expect(result.pending).toBeUndefined();
    expect(result.changeId).toBeUndefined();
    expect(result.size).toBeGreaterThan(0);
  });

  it('accept flow: pending → accepted → cleanup', async () => {
    const { manager, onEmit } = createManager();
    const ctx = createCtxWithApproval(manager);
    initTestFile('src/test.ts');
    const result = await fileWriteTool.execute(
      { path: 'src/test.ts', content: 'new content' },
      ctx,
    );

    expect(result.pending).toBe(true);

    await manager.accept(result.changeId!);

    expect(onEmit).toHaveBeenCalledWith('approval.resolved', expect.objectContaining({
      changeId: result.changeId,
      status: 'accepted',
    }));
  });

  it('reject flow: pending → rejected → cleanup', async () => {
    const { manager, onEmit } = createManager();
    const ctx = createCtxWithApproval(manager);
    initTestFile('src/test.ts');
    const result = await fileWriteTool.execute(
      { path: 'src/test.ts', content: 'new content' },
      ctx,
    );

    expect(result.pending).toBe(true);

    await manager.reject(result.changeId!);

    expect(onEmit).toHaveBeenCalledWith('approval.resolved', expect.objectContaining({
      changeId: result.changeId,
      status: 'rejected',
    }));
  });

  it('approval.request event includes full proposal context', async () => {
    const { manager, onEmit } = createManager();
    const ctx = createCtxWithApproval(manager);
    initTestFile('src/test.ts');
    await fileWriteTool.execute(
      { path: 'src/test.ts', content: 'new content' },
      ctx,
    );

    expect(onEmit).toHaveBeenCalledWith('approval.request', expect.objectContaining({
      type: 'approval.request',
      changeId: expect.any(String),
      sessionId: 'test-session',
    }));
  });

  it('listPending shows submitted approvals', async () => {
    const { manager } = createManager();
    const ctx = createCtxWithApproval(manager);
    initTestFile('src/a.ts');
    initTestFile('src/b.ts');
    await fileWriteTool.execute({ path: 'src/a.ts', content: 'a' }, ctx);
    await fileWriteTool.execute({ path: 'src/b.ts', content: 'b' }, ctx);

    expect(manager.listPending().length).toBe(2);
  });
});

describe('Approval Integration — Agent pause coordination', () => {
  it('getAgentPendingCount reflects submitted approvals', async () => {
    const { manager } = createManager();
    const ctx = createCtxWithApproval(manager);
    initTestFile('src/a.ts');
    initTestFile('src/b.ts');

    await fileWriteTool.execute({ path: 'src/a.ts', content: 'a' }, ctx);
    await fileWriteTool.execute({ path: 'src/b.ts', content: 'b' }, ctx);

    expect(manager.getAgentPendingCount('unknown')).toBe(2);
  });
});

describe('Approval Integration — Batch operations', () => {
  it('batch accept multiple approvals and cleanup', async () => {
    const { manager } = createManager();
    const ctx = createCtxWithApproval(manager);
    initTestFile('src/a.ts');
    initTestFile('src/b.ts');

    const r1 = await fileWriteTool.execute({ path: 'src/a.ts', content: 'a' }, ctx);
    const r2 = await fileWriteTool.execute({ path: 'src/b.ts', content: 'b' }, ctx);

    expect(manager.listPending().length).toBe(2);

    await manager.batchAccept([r1.changeId!, r2.changeId!]);

    expect(manager.listPending().length).toBe(0);
  });
});
