// @zaivim/engine — ApprovalManager unit tests (Story 3.5)
// Covers AC1–AC13 with focused assertions on each acceptance criterion.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ApprovalManager } from '../pipeline/approval-manager.js';
import type { FileChangeProposal } from '@zaivim/core';

// ─── Helpers ───────────────────────────────────────────────────────────────────

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'approval-test-'));
});

afterEach(() => {
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function makeManager(opts?: Partial<import('../pipeline/approval-manager.js').ApprovalManagerOptions>) {
  const onAudit = vi.fn();
  const onEmit = vi.fn();
  return {
    manager: new ApprovalManager({
      onAudit,
      onEmit,
      defaultTimeoutMs: opts?.defaultTimeoutMs ?? 300_000,
      maxPending: opts?.maxPending ?? 10,
      maxSimilarRetries: opts?.maxSimilarRetries ?? 3,
      similarityThreshold: opts?.similarityThreshold ?? 0.8,
      ...opts,
    }),
    onAudit,
    onEmit,
  };
}

function makeProposal(overrides?: Partial<FileChangeProposal>): FileChangeProposal {
  const testFile = join(tempDir, 'src', 'index.ts');
  return {
    path: testFile,
    operation: 'modify',
    diff: '--- a/index.ts\n+++ b/index.ts\n@@ -1 +1 @@\n-old\n+new',
    reason: 'Update index.ts',
    proposedContent: 'new content',
    sessionId: 'session-1',
    agentId: 'agent-1',
    ...overrides,
  };
}

/** Initialize a file that can be "modified" in accept tests. */
function initTestFile(subPath: string, content = 'original content'): string {
  const filePath = join(tempDir, subPath);
  mkdirSync(join(tempDir, subPath.replace(/\/[^/]+$/, '')), { recursive: true });
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('ApprovalManager — AC1: Async approval model', () => {
  it('submit() returns PendingApproval with unique changeId', () => {
    const { manager } = makeManager();
    const result = manager.submit(makeProposal());

    expect(result).toBeDefined();
    expect(result.changeId).toBeTruthy();
    expect(typeof result.changeId).toBe('string');
    expect(result.changeId.length).toBeGreaterThan(10);
    expect(result.status).toBe('pending');
    expect(result.proposal).toBeDefined();
    expect(result.proposal.path).toBe(join(tempDir, 'src', 'index.ts'));
  });

  it('submit() emits approval.request event', () => {
    const { manager, onEmit } = makeManager();
    manager.submit(makeProposal());

    expect(onEmit).toHaveBeenCalledWith('approval.request', expect.objectContaining({
      type: 'approval.request',
      changeId: expect.any(String),
      timeoutMs: 300_000,
      agentId: 'agent-1',
      sessionId: 'session-1',
    }));
  });

  it('submit() records audit entry', () => {
    const { manager, onAudit } = makeManager();
    manager.submit(makeProposal());

    expect(onAudit).toHaveBeenCalledWith('approval.dispatch', expect.objectContaining({
      changeId: expect.any(String),
      tool: 'file_write',
    }));
  });
});

describe('ApprovalManager — AC2: Accept change', () => {
  it('accept() transitions status and cleans up', async () => {
    const { manager } = makeManager();
    const testFile = initTestFile('src/existing.ts');
    const { changeId } = manager.submit(makeProposal({
      path: testFile,
      proposedContent: 'updated content',
    }));
    expect(manager.getStatus(changeId)).toBe('pending');

    await manager.accept(changeId);
    expect(manager.getStatus(changeId)).toBeUndefined();
    expect(existsSync(testFile)).toBe(true);
  });

  it('accept() emits approval.resolved event', async () => {
    const { manager, onEmit } = makeManager();
    const testFile = initTestFile('src/existing.ts');
    const { changeId } = manager.submit(makeProposal({ path: testFile, proposedContent: 'updated' }));

    await manager.accept(changeId);
    expect(onEmit).toHaveBeenCalledWith('approval.resolved', expect.objectContaining({
      changeId,
      status: 'accepted',
    }));
  });

  it('accept() records audit with latency', async () => {
    const { manager, onAudit } = makeManager();
    const testFile = initTestFile('src/existing.ts');
    const { changeId } = manager.submit(makeProposal({ path: testFile, proposedContent: 'updated' }));

    await manager.accept(changeId);
    expect(onAudit).toHaveBeenCalledWith('approval.accepted', expect.objectContaining({
      changeId,
      latencyMs: expect.any(Number),
    }));
  });
});

describe('ApprovalManager — AC3: Reject change', () => {
  it('reject() transitions status to rejected', async () => {
    const { manager } = makeManager();
    const testFile = initTestFile('src/existing.ts');
    const { changeId } = manager.submit(makeProposal({ path: testFile }));

    await manager.reject(changeId);
    expect(manager.getStatus(changeId)).toBeUndefined();
  });

  it('reject() emits approval.resolved with rejected status', async () => {
    const { manager, onEmit } = makeManager();
    const testFile = initTestFile('src/existing.ts');
    const { changeId } = manager.submit(makeProposal({ path: testFile }));

    await manager.reject(changeId);
    expect(onEmit).toHaveBeenCalledWith('approval.resolved', expect.objectContaining({
      changeId,
      status: 'rejected',
    }));
  });
});

describe('ApprovalManager — AC4: Partial accept', () => {
  it('partial() resolves with partial status', async () => {
    const { manager, onEmit } = makeManager();
    const testFile = initTestFile('src/existing.ts');
    const { changeId } = manager.submit(makeProposal({ path: testFile, proposedContent: 'multi' }));

    await manager.partial(changeId, ['a.ts', 'b.ts'], ['c.ts']);
    expect(onEmit).toHaveBeenCalledWith('approval.resolved', expect.objectContaining({
      changeId,
      status: 'partial',
      acceptedFiles: ['a.ts', 'b.ts'],
      rejectedFiles: ['c.ts'],
    }));
  });

  it('partial() records audit', async () => {
    const { manager, onAudit } = makeManager();
    const testFile = initTestFile('src/existing.ts');
    const { changeId } = manager.submit(makeProposal({ path: testFile, proposedContent: 'test' }));

    await manager.partial(changeId, ['a.ts'], ['b.ts']);
    expect(onAudit).toHaveBeenCalledWith('approval.partial', expect.objectContaining({
      changeId,
      acceptFiles: 'a.ts',
      rejectFiles: 'b.ts',
    }));
  });

  it('partial with file in rejectFiles skips write', async () => {
    const { manager } = makeManager();
    const testFile = initTestFile('src/partial-skip.ts', 'original content');
    const { changeId } = manager.submit(makeProposal({ path: testFile, proposedContent: 'new content' }));

    await manager.partial(changeId, [], [testFile]);

    // File content should remain unchanged
    expect(readFileSync(testFile, 'utf-8')).toBe('original content');
  });
});

describe('ApprovalManager — AC5: Timeout auto-reject', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('timeout auto-rejects after defaultTimeoutMs', () => {
    const { manager } = makeManager({ defaultTimeoutMs: 50 });
    const { changeId } = manager.submit(makeProposal());

    expect(manager.getStatus(changeId)).toBe('pending');
    vi.advanceTimersByTime(100);
    expect(manager.getStatus(changeId)).toBeUndefined();
  });

  it('timeout emits approval.timeout event', () => {
    const { manager, onEmit } = makeManager({ defaultTimeoutMs: 50 });
    manager.submit(makeProposal());
    vi.advanceTimersByTime(100);

    expect(onEmit).toHaveBeenCalledWith('approval.timeout', expect.objectContaining({
      changeId: expect.any(String),
    }));
  });

  it('accept before timeout cancels timeout', async () => {
    const { manager, onEmit } = makeManager({ defaultTimeoutMs: 50 });
    const testFile = initTestFile('src/existing.ts');
    const { changeId } = manager.submit(makeProposal({
      path: testFile,
      proposedContent: 'updated',
    }));

    await manager.accept(changeId);
    vi.advanceTimersByTime(100);

    const timeoutCalls = onEmit.mock.calls.filter((c: unknown[]) => c[0] === 'approval.timeout');
    expect(timeoutCalls.length).toBe(0);
  });
});

describe('ApprovalManager — AC6: Same-file queue', () => {
  it('second pending for same file gets waitingFor set', () => {
    const { manager } = makeManager();
    const testFile = join(tempDir, 'same.ts');
    const r1 = manager.submit(makeProposal({ path: testFile }));
    const r2 = manager.submit(makeProposal({ path: testFile }));

    expect(r1.waitingFor).toBeUndefined();
    expect(r2.waitingFor).toBe(r1.changeId);
    expect(r2.queueOrder).toBe(1);
  });

  it('second for same file emits approval.queued event', () => {
    const { manager, onEmit } = makeManager();
    const testFile = join(tempDir, 'same.ts');
    manager.submit(makeProposal({ path: testFile }));
    manager.submit(makeProposal({ path: testFile }));

    const queuedCalls = onEmit.mock.calls.filter((c: unknown[]) => c[0] === 'approval.queued');
    expect(queuedCalls.length).toBe(1);
  });

  it('resolving first promotes the queued second entry', async () => {
    const { manager } = makeManager();
    const testFile = join(tempDir, 'promote.ts');
    const r1 = manager.submit(makeProposal({ path: testFile }));
    const r2 = manager.submit(makeProposal({ path: testFile }));

    expect(r2.waitingFor).toBe(r1.changeId);

    // Reject the first — second should be promoted
    // (reject doesn't need a real file)
    await manager.reject(r1.changeId);

    // The promoted entry should now have waitingFor cleared
    expect(manager.listPending().length).toBe(1);
    const remaining = manager.listPending();
    expect(remaining[0]!.waitingFor).toBeUndefined();
    expect(remaining[0]!.changeId).toBe(r2.changeId);
  });
});

describe('ApprovalManager — AC7: Rejected change context', () => {
  it('rejected approval does not appear in listPending', async () => {
    const { manager } = makeManager();
    const testFile = initTestFile('src/existing.ts');
    const { changeId } = manager.submit(makeProposal({ path: testFile }));

    expect(manager.listPending().length).toBe(1);
    await manager.reject(changeId);
    expect(manager.listPending().length).toBe(0);
  });
});

describe('ApprovalManager — AC8: List pending', () => {
  it('listPending() returns all pending approvals', () => {
    const { manager } = makeManager();
    manager.submit(makeProposal({ path: join(tempDir, 'a.ts'), sessionId: 's1' }));
    manager.submit(makeProposal({ path: join(tempDir, 'b.ts'), sessionId: 's2' }));

    expect(manager.listPending().length).toBe(2);
  });

  it('listPending(sessionId) filters by session', () => {
    const { manager } = makeManager();
    manager.submit(makeProposal({ path: join(tempDir, 'a.ts'), sessionId: 's1' }));
    manager.submit(makeProposal({ path: join(tempDir, 'b.ts'), sessionId: 's2' }));

    const s1Pending = manager.listPending('s1');
    expect(s1Pending.length).toBe(1);
  });

  it('listPending() excludes resolved approvals', async () => {
    const { manager } = makeManager();
    const testFile = initTestFile('src/existing.ts');
    const { changeId } = manager.submit(makeProposal({ path: join(tempDir, 'a.ts') }));
    manager.submit(makeProposal({ path: join(tempDir, 'b.ts') }));

    await manager.reject(changeId);
    expect(manager.listPending().length).toBe(1);
  });
});

describe('ApprovalManager — AC9: External file modification detection', () => {
  it('accept with stale base hash throws APPROVAL_STALE_BASE', async () => {
    const { manager } = makeManager();
    const testFile = initTestFile('src/existing.ts', 'original');

    // Submit proposal with a baseFileHash that won't match
    const { changeId } = manager.submit(makeProposal({
      path: testFile,
      proposedContent: 'updated content',
      baseFileHash: 'wrong-hash',
    }));

    await expect(manager.accept(changeId)).rejects.toMatchObject({
      code: 'APPROVAL_STALE_BASE',
    });
  });
});

describe('ApprovalManager — AC10: Loop detection', () => {
  it('3 similar diff rejections → 4th throws APPROVAL_LOOP_DETECTED', async () => {
    const { manager } = makeManager({ maxSimilarRetries: 3 });
    const diff = '--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new';
    const testFile = initTestFile('src/loop.ts');

    for (let i = 0; i < 3; i++) {
      const { changeId } = manager.submit(makeProposal({
        path: testFile,
        diff,
        agentId: 'agent-1',
      }));
      await manager.reject(changeId);
    }

    expect(() =>
      manager.submit(makeProposal({
        path: testFile,
        diff,
        agentId: 'agent-1',
      })),
    ).toThrow(/APPROVAL_LOOP_DETECTED/);
  });

  it('different diffs do not trigger loop detection', async () => {
    const { manager } = makeManager({ maxSimilarRetries: 3 });
    const testFile = initTestFile('src/noloop.ts');

    for (let i = 0; i < 3; i++) {
      const { changeId } = manager.submit(makeProposal({
        path: testFile,
        diff: `--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new-${i}`,
        agentId: 'agent-1',
      }));
      await manager.reject(changeId);
    }

    expect(() =>
      manager.submit(makeProposal({
        path: testFile,
        diff: '--- a\n+++ b\n@@ -1 +1 @@\n-very\n+different',
        agentId: 'agent-1',
      })),
    ).not.toThrow();
  });
});

describe('ApprovalManager — AC11: Batch operations', () => {
  it('batchAccept accepts multiple approvals', async () => {
    const { manager } = makeManager();
    const f1 = initTestFile('src/a.ts');
    const f2 = initTestFile('src/b.ts');
    const { changeId: c1 } = manager.submit(makeProposal({ path: f1, proposedContent: 'new a' }));
    const { changeId: c2 } = manager.submit(makeProposal({ path: f2, proposedContent: 'new b' }));

    await manager.batchAccept([c1, c2]);
    expect(manager.listPending().length).toBe(0);
  });

  it('batchReject rejects multiple approvals', async () => {
    const { manager } = makeManager();
    const f1 = initTestFile('src/a.ts');
    const f2 = initTestFile('src/b.ts');
    const { changeId: c1 } = manager.submit(makeProposal({ path: f1 }));
    const { changeId: c2 } = manager.submit(makeProposal({ path: f2 }));

    await manager.batchReject([c1, c2]);
    expect(manager.listPending().length).toBe(0);
  });

  it('batchAccept handles already-resolved gracefully', async () => {
    const { manager } = makeManager();
    const f1 = initTestFile('src/a.ts');
    const f2 = initTestFile('src/b.ts');
    const { changeId: c1 } = manager.submit(makeProposal({ path: f1, proposedContent: 'a' }));
    const { changeId: c2 } = manager.submit(makeProposal({ path: f2, proposedContent: 'b' }));

    await manager.reject(c1);
    await manager.batchAccept([c1, c2]);

    expect(manager.listPending().length).toBe(0);
  });

  it('maxPending throws APPROVAL_MAX_PENDING', () => {
    const { manager } = makeManager({ maxPending: 2 });
    manager.submit(makeProposal({ path: join(tempDir, 'a.ts') }));
    manager.submit(makeProposal({ path: join(tempDir, 'b.ts') }));

    expect(() =>
      manager.submit(makeProposal({ path: join(tempDir, 'c.ts') })),
    ).toThrow(/APPROVAL_MAX_PENDING/);
  });
});

describe('ApprovalManager — AC12: Cross-session file lock', () => {
  it('two sessions writing same file → second throws APPROVAL_FILE_LOCKED', () => {
    const { manager } = makeManager();
    const testFile = join(tempDir, 'shared.ts');
    manager.submit(makeProposal({ path: testFile, sessionId: 'session-a' }));

    expect(() =>
      manager.submit(makeProposal({ path: testFile, sessionId: 'session-b' })),
    ).toThrow(/APPROVAL_FILE_LOCKED/);
  });
});

describe('ApprovalManager — AC13: Atomic CAS', () => {
  it('double accept throws APPROVAL_ALREADY_RESOLVED', async () => {
    const { manager } = makeManager();
    const testFile = initTestFile('src/existing.ts');
    const { changeId } = manager.submit(makeProposal({ path: testFile, proposedContent: 'test' }));

    await manager.accept(changeId);
    await expect(manager.accept(changeId)).rejects.toMatchObject({ code: 'APPROVAL_ALREADY_RESOLVED' });
  });

  it('reject after accept throws APPROVAL_ALREADY_RESOLVED', async () => {
    const { manager } = makeManager();
    const testFile = initTestFile('src/existing.ts');
    const { changeId } = manager.submit(makeProposal({ path: testFile, proposedContent: 'test' }));

    await manager.accept(changeId);
    await expect(manager.reject(changeId)).rejects.toMatchObject({ code: 'APPROVAL_ALREADY_RESOLVED' });
  });

  it('accept after reject throws APPROVAL_ALREADY_RESOLVED', async () => {
    const { manager } = makeManager();
    const testFile = initTestFile('src/existing.ts');
    const { changeId } = manager.submit(makeProposal({ path: testFile }));

    await manager.reject(changeId);
    await expect(manager.accept(changeId)).rejects.toMatchObject({ code: 'APPROVAL_ALREADY_RESOLVED' });
  });

  it('unknown changeId throws APPROVAL_NOT_FOUND', async () => {
    const { manager } = makeManager();
    await expect(manager.accept('nonexistent')).rejects.toMatchObject({ code: 'APPROVAL_NOT_FOUND' });
    await expect(manager.reject('nonexistent')).rejects.toMatchObject({ code: 'APPROVAL_NOT_FOUND' });
  });
});

describe('ApprovalManager — Agent pause state', () => {
  it('getAgentPendingCount returns pending count for agent', () => {
    const { manager } = makeManager();
    manager.submit(makeProposal({ path: join(tempDir, 'a.ts'), agentId: 'agent-1' }));
    manager.submit(makeProposal({ path: join(tempDir, 'b.ts'), agentId: 'agent-1' }));
    manager.submit(makeProposal({ path: join(tempDir, 'c.ts'), agentId: 'agent-2' }));

    expect(manager.getAgentPendingCount('agent-1')).toBe(2);
    expect(manager.getAgentPendingCount('agent-2')).toBe(1);
  });

  it('cancelAgentPending cleans up all pending for agent', () => {
    const { manager } = makeManager();
    manager.submit(makeProposal({ path: join(tempDir, 'a.ts'), agentId: 'agent-1', proposedContent: 'a' }));
    manager.submit(makeProposal({ path: join(tempDir, 'b.ts'), agentId: 'agent-1', proposedContent: 'b' }));

    manager.cancelAgentPending('agent-1');
    expect(manager.getAgentPendingCount('agent-1')).toBe(0);
    expect(manager.pendingCount).toBe(0);
  });

  it('cancelAll cleans up all pending approvals', () => {
    const { manager } = makeManager();
    manager.submit(makeProposal({ path: join(tempDir, 'a.ts'), agentId: 'agent-1' }));
    manager.submit(makeProposal({ path: join(tempDir, 'b.ts'), agentId: 'agent-2' }));

    manager.cancelAll();
    expect(manager.pendingCount).toBe(0);
  });
});
