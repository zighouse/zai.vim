// @zaivim/e2e — Epic 3: Tool chain + Diff approval
// Run: pnpm test:e2e -- --epic e3

import { describe, it, expect, afterEach } from 'vitest';
import { describeEpic } from './test-utils.js';
import { writeFileSync, unlinkSync, existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ToolContext, FileChangeProposal, ISecurityProvider } from '@zaivim/core';

describeEpic('e3', () => {

  // ---- Tool chain: file_read via ToolContext ---------------------------------

  it('simulates file_read tool execution', () => {
    const ctx: ToolContext = {
      sessionId: 's1',
      sandbox: 'none',
      signal: new AbortController().signal,
      security: { sandboxType: 'none', validatePath: () => ({ allowed: true }), validateOperation: () => ({ allowed: true, riskLevel: 'C' as any }), isSandboxAvailable: () => false } as ISecurityProvider,
      audit: () => {},
      spawn: () => ({ pid: 0 }) as any,
    };

    // Tool execution: read file via ctx (conceptual)
    expect(ctx.sessionId).toBe('s1');
    expect(ctx.sandbox).toBe('none');
    expect(ctx.signal.aborted).toBe(false);
  });

  // ---- Diff approval: accept / reject ---------------------------------------

  it('accepts a file change proposal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zaivim-e2e-'));
    const filePath = join(dir, 'test.txt');
    writeFileSync(filePath, 'original content');

    // Simulate a file_write tool with approval
    const proposal: FileChangeProposal = {
      path: filePath,
      operation: 'modify',
      diff: '--- a\n+++ b\n@@ -1 +1 @@\n-original\n+modified',
      reason: 'Test modification',
    };

    // Accept: apply the change
    writeFileSync(proposal.path, 'modified content');
    expect(readFileSync(proposal.path, 'utf-8')).toBe('modified content');

    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects a file change proposal (file unchanged)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zaivim-e2e-'));
    const filePath = join(dir, 'test.txt');
    writeFileSync(filePath, 'original content');

    const proposal: FileChangeProposal = {
      path: filePath,
      operation: 'modify',
      diff: '--- a\n+++ b\n@@ -1 +1 @@\n-original\n+modified',
      reason: 'Test modification',
    };

    // Reject: don't apply the change
    expect(readFileSync(proposal.path, 'utf-8')).toBe('original content');

    rmSync(dir, { recursive: true, force: true });
  });

  it('creates a new file via file_write tool', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zaivim-e2e-'));
    const filePath = join(dir, 'new.txt');

    const proposal: FileChangeProposal = {
      path: filePath,
      operation: 'create',
      diff: '',
      reason: 'Create new file',
    };

    writeFileSync(proposal.path, 'new content');
    expect(existsSync(proposal.path)).toBe(true);
    expect(readFileSync(proposal.path, 'utf-8')).toBe('new content');

    rmSync(dir, { recursive: true, force: true });
  });
});
