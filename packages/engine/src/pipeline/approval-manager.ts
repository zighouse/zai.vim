// @zaivim/engine — ApprovalManager (Story 3.5)
// Async diff review and approval lifecycle:
//   submit → pending → accept|reject|partial|timeout → resolved
// Integrates with ToolContext.requestApproval callback.
//
// AC1:  Async approval — engine not blocked
// AC2:  Accept → write file, delete backup
// AC3:  Reject → discard, keep backup
// AC4:  Partial — per-file granularity
// AC5:  Timeout → auto reject after 300s
// AC6:  Same-file queue
// AC7:  Rejected-change context for AI
// AC8:  List pending for reconnecting client
// AC9:  External modify detection via file hash
// AC10: Loop detection — 3 similar diffs → halt
// AC11: Batch accept/reject, max pending 10
// AC12: Cross-session file lock (Growth, MVP detects only)
// AC13: Atomic CAS — user action beats timeout

import { randomUUID, createHash } from 'node:crypto';
import { writeFile, readFile, mkdir, unlink } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { FileChangeProposal, PendingApproval, ApprovalStatus, ApprovalLoopDetection } from '@zaivim/core';

// ─── Types ─────────────────────────────────────────────────────────────────────

export type AuditFn = (action: string, detail: Record<string, unknown>) => void;
export type EmitFn = (event: string, data: Record<string, unknown>) => void;

export interface ApprovalManagerOptions {
  /** Default approval timeout in ms. Default: 300_000 (5 min). */
  readonly defaultTimeoutMs?: number;
  /** Maximum concurrent pending approvals. Default: 10. */
  readonly maxPending?: number;
  /** Max similar-diff rejections before loop detection kicks in. Default: 3. */
  readonly maxSimilarRetries?: number;
  /** Diff similarity threshold (0.0–1.0). Default: 0.8. */
  readonly similarityThreshold?: number;
  /** Audit log function. */
  readonly onAudit: AuditFn;
  /** Event emitter function. */
  readonly onEmit: EmitFn;
  /** Resolved-path → project root mapping for file writes (for `applyPendingWrite`). */
  readonly projectRoot?: string;
}

// ─── FileHashStore ─────────────────────────────────────────────────────────────

/**
 * Records and verifies file content hashes (AC9).
 *
 * At proposal generation time, records the base hash of the original file.
 * At accept time, re-hashes the current file on disk and compares.
 */
class FileHashStore {
  readonly #hashes = new Map<string, string>();

  /** Record the base hash of file content. Returns the hex digest. */
  recordBaseHash(resolvedPath: string, content: string): string {
    const hash = createHash('sha256').update(content, 'utf-8').digest('hex');
    this.#hashes.set(resolvedPath, hash);
    return hash;
  }

  /** Verify the file on disk still matches the recorded base hash. */
  verifyCurrentHash(resolvedPath: string, expectedHash: string): boolean {
    try {
      if (!existsSync(resolvedPath)) return false;
      const content = readFileSyncSafe(resolvedPath);
      const currentHash = createHash('sha256').update(content, 'utf-8').digest('hex');
      return currentHash === expectedHash;
    } catch {
      return false;
    }
  }

  /** Remove a recorded hash (after accept or cancel). */
  clear(resolvedPath: string): void {
    this.#hashes.delete(resolvedPath);
  }
}

/** Synchronous file read for hash verification — small files only. */
function readFileSyncSafe(path: string): string {
  return readFileSync(path, 'utf-8');
}

// ─── FileLockManager ───────────────────────────────────────────────────────────

/**
 * Cross-session exclusive file lock (AC12, MVP).
 *
 * Growth: persistent lock recovery via JSONL. MVP: in-memory Map.
 */
class FileLockManager {
  readonly #locks = new Map<string, { changeId: string; sessionId: string }>();

  /** Try to acquire an exclusive lock. Returns true on success. */
  tryLock(resolvedPath: string, sessionId: string): boolean {
    if (this.#locks.has(resolvedPath)) return false;
    this.#locks.set(resolvedPath, { changeId: '', sessionId });
    return true;
  }

  /** Associate a changeId with an acquired lock. */
  associate(changeId: string, resolvedPath: string, sessionId: string): void {
    this.#locks.set(resolvedPath, { changeId, sessionId });
  }

  /** Release the lock held by a change. */
  release(changeId: string): void {
    for (const [path, lock] of this.#locks) {
      if (lock.changeId === changeId) {
        this.#locks.delete(path);
        return;
      }
    }
  }

  /** Get the lock holder for a path, if any. */
  getLockHolder(resolvedPath: string): { changeId: string; sessionId: string } | undefined {
    return this.#locks.get(resolvedPath);
  }

  /** Remove stale locks for a session (agent cancel / disconnect). */
  releaseSession(sessionId: string): void {
    for (const [path, lock] of this.#locks) {
      if (lock.sessionId === sessionId) {
        this.#locks.delete(path);
      }
    }
  }
}

// ─── ApprovalManager ───────────────────────────────────────────────────────────

export class ApprovalManager {
  readonly #pending = new Map<string, PendingApprovalEntry>();
  readonly #timeoutTimers = new Map<string, NodeJS.Timeout>();
  readonly #fileLocks = new FileLockManager();
  readonly #hashStore = new FileHashStore();
  readonly #loopDetection = new Map<string, ApprovalLoopDetection[]>();
  readonly #agentPauseStates = new Map<string, Set<string>>();
  readonly #onAudit: AuditFn;
  readonly #onEmit: EmitFn;
  readonly #defaultTimeoutMs: number;
  readonly #maxPending: number;
  readonly #maxSimilarRetries: number;
  readonly #similarityThreshold: number;
  readonly #projectRoot?: string;

  constructor(options: ApprovalManagerOptions) {
    this.#onAudit = options.onAudit;
    this.#onEmit = options.onEmit;
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? 300_000;
    this.#maxPending = options.maxPending ?? 10;
    this.#maxSimilarRetries = options.maxSimilarRetries ?? 3;
    this.#similarityThreshold = options.similarityThreshold ?? 0.8;
    this.#projectRoot = options.projectRoot;
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Submit a new file change proposal for approval (AC1).
   *
   * - Checks max pending cap (AC11)
   * - Checks loop detection (AC10)
   * - Assigns unique changeId
   * - Sets up timeout timer (AC5)
   * - Emits `approval.request` event
   */
  submit(proposal: FileChangeProposal): PendingApproval {
    if (this.#pending.size >= this.#maxPending) {
      throw Object.assign(
        new Error(`[APPROVAL_MAX_PENDING] Maximum pending approvals reached (${this.#maxPending})`),
        { code: 'APPROVAL_MAX_PENDING' },
      );
    }

    if (this.#detectLoop(proposal)) {
      throw Object.assign(
        new Error(
          `[APPROVAL_LOOP_DETECTED] Change rejected 3 times with similar content, please consider alternative approach or ask user for guidance`,
        ),
        { code: 'APPROVAL_LOOP_DETECTED' },
      );
    }

    const changeId = randomUUID();
    const now = Date.now();

    // AC6: same-file queue detection
    let waitingFor: string | undefined;
    let queueOrder = 0;
    const resolvedPath = proposal.path;
    if (resolvedPath) {
      for (const entry of this.#pending.values()) {
        if (entry.proposal.path === resolvedPath && entry.status === 'pending') {
          waitingFor = entry.changeId;
          queueOrder = entry.queueOrder + 1;
          break;
        }
      }
    }

    const entry: PendingApprovalEntry = {
      changeId,
      proposal: { ...proposal, changeId, timestamp: now },
      status: 'pending',
      waitingFor,
      queueOrder,
      createdAt: now,
      timeoutMs: this.#defaultTimeoutMs,
    };

    this.#pending.set(changeId, entry);

    // AC6: emit queue notification
    if (waitingFor) {
      this.#onEmit('approval.queued', { changeId, waitingFor });
    }

    // AC12: cross-session file lock
    // AC6: same-file queue — same session queues, different session throws
    if (resolvedPath) {
      const sessionId = proposal.sessionId ?? 'unknown';
      if (waitingFor) {
        // A pending entry exists for this path — check session
        const holder = this.#fileLocks.getLockHolder(resolvedPath);
        if (holder && holder.sessionId !== sessionId) {
          throw Object.assign(
            new Error(`[APPROVAL_FILE_LOCKED] File locked by another session: ${resolvedPath}`),
            {
              code: 'APPROVAL_FILE_LOCKED',
              detail: { lockedBy: holder.sessionId },
            },
          );
        }
        // Same session: queued entry inherits the existing lock
      } else {
        // First submission for this path: try to acquire lock
        if (!this.#fileLocks.tryLock(resolvedPath, sessionId)) {
          const holder = this.#fileLocks.getLockHolder(resolvedPath);
          throw Object.assign(
            new Error(`[APPROVAL_FILE_LOCKED] File locked by another session: ${resolvedPath}`),
            {
              code: 'APPROVAL_FILE_LOCKED',
              detail: { lockedBy: holder?.sessionId },
            },
          );
        }
        this.#fileLocks.associate(changeId, resolvedPath, sessionId);
      }
    }

    // Track agent pause state
    const agentId = proposal.agentId ?? 'unknown';
    if (!this.#agentPauseStates.has(agentId)) {
      this.#agentPauseStates.set(agentId, new Set());
    }
    this.#agentPauseStates.get(agentId)!.add(changeId);

    // AC5: schedule timeout
    this.#scheduleTimeout(changeId, this.#defaultTimeoutMs);

    // Audit
    this.#onAudit('approval.dispatch', {
      changeId,
      tool: 'file_write',
      proposalId: proposal.changeId,
      path: proposal.path,
    });

    // Emit notification
    this.#onEmit('approval.request', {
      type: 'approval.request',
      changeId,
      proposal: entry.proposal,
      timeoutMs: this.#defaultTimeoutMs,
      agentId,
      sessionId: proposal.sessionId ?? 'unknown',
    });

    return {
      changeId,
      proposal: entry.proposal,
      status: 'pending',
      waitingFor,
      queueOrder,
      createdAt: now,
      timeoutMs: this.#defaultTimeoutMs,
    };
  }

  /**
   * Accept a pending change (AC2).
   * CAS atomic — throws APPROVAL_ALREADY_RESOLVED on race (AC13).
   */
  async accept(changeId: string): Promise<void> {
    const entry = this.#pending.get(changeId);
    if (!entry) {
      throw Object.assign(new Error(`Approval not found: ${changeId}`), { code: 'APPROVAL_NOT_FOUND' });
    }

    if (!this.#compareAndSwap(changeId, 'pending', 'accepted')) {
      throw Object.assign(
        new Error(`Approval already resolved: ${changeId}`),
        {
          code: 'APPROVAL_ALREADY_RESOLVED',
          detail: { resolvedAs: entry.status },
        },
      );
    }

    // Cancel timeout timer
    this.#clearTimeout(changeId);

    // AC9: verify file hash
    const proposal = entry.proposal;
    const resolvedPath = proposal.path;
    if (resolvedPath && proposal.baseFileHash) {
      if (!this.#hashStore.verifyCurrentHash(resolvedPath, proposal.baseFileHash)) {
        // Stale — revert status back to rejected/stale
        entry.status = 'rejected';
        this.#onEmit('approval.stale', { changeId, reason: 'file modified externally' });
        this.#cleanup(changeId);
        throw Object.assign(
          new Error('file modified externally, please re-generate proposal based on current content'),
          { code: 'APPROVAL_STALE_BASE' },
        );
      }
    }

    // Write file
    await this.#applyPendingWrite(entry);

    // Cleanup
    this.#onEmit('approval.resolved', { changeId, status: 'accepted' });
    this.#onAudit('approval.accepted', { changeId, latencyMs: Date.now() - entry.createdAt });
    this.#cleanup(changeId);
  }

  /**
   * Reject a pending change (AC3).
   * CAS atomic — throws APPROVAL_ALREADY_RESOLVED on race (AC13).
   */
  async reject(changeId: string): Promise<void> {
    const entry = this.#pending.get(changeId);
    if (!entry) {
      throw Object.assign(new Error(`Approval not found: ${changeId}`), { code: 'APPROVAL_NOT_FOUND' });
    }

    if (!this.#compareAndSwap(changeId, 'pending', 'rejected')) {
      throw Object.assign(
        new Error(`Approval already resolved: ${changeId}`),
        {
          code: 'APPROVAL_ALREADY_RESOLVED',
          detail: { resolvedAs: entry.status },
        },
      );
    }

    this.#clearTimeout(changeId);
    this.#onEmit('approval.resolved', { changeId, status: 'rejected' });
    this.#onAudit('approval.rejected', { changeId, latencyMs: Date.now() - entry.createdAt });
    this.#cleanup(changeId);
  }

  /**
   * Partially accept a multi-file change (AC4).
   *
   * MVP limitation: FileChangeProposal models a single file. When acceptFiles
   * includes the proposal's path (or acceptFiles is empty/unrelated), the
   * proposal is written. When the path is explicitly in rejectFiles, the write
   * is skipped. True multi-file proposals (one changeId → N files) require a
   * data model extension.
   */
  async partial(changeId: string, acceptFiles: string[], rejectFiles: string[]): Promise<void> {
    const entry = this.#pending.get(changeId);
    if (!entry) {
      throw Object.assign(new Error(`Approval not found: ${changeId}`), { code: 'APPROVAL_NOT_FOUND' });
    }

    if (!this.#compareAndSwap(changeId, 'pending', 'partial')) {
      throw Object.assign(
        new Error(`Approval already resolved: ${changeId}`),
        {
          code: 'APPROVAL_ALREADY_RESOLVED',
          detail: { resolvedAs: entry.status },
        },
      );
    }

    this.#clearTimeout(changeId);

    // Decide whether to write: write if proposal's path is in acceptFiles,
    // OR if acceptFiles is non-empty but non-matching (upgrade to accept),
    // BUT skip if the path is explicitly in rejectFiles.
    const proposalPath = entry.proposal.path;
    const shouldWrite = acceptFiles.length > 0
      ? acceptFiles.includes(proposalPath) || !rejectFiles.includes(proposalPath)
      : !rejectFiles.includes(proposalPath);

    if (shouldWrite) {
      await this.#applyPendingWrite(entry);
    } else {
      this.#onAudit('approval.partial_skipped', {
        changeId,
        reason: proposalPath && rejectFiles.includes(proposalPath)
          ? 'file in rejectFiles'
          : 'no accepted files',
      });
    }

    this.#onEmit('approval.resolved', {
      changeId,
      status: 'partial',
      acceptedFiles: acceptFiles,
      rejectedFiles: rejectFiles,
    });
    this.#onAudit('approval.partial', {
      changeId,
      acceptFiles: acceptFiles.join(','),
      rejectFiles: rejectFiles.join(','),
      latencyMs: Date.now() - entry.createdAt,
    });
    this.#cleanup(changeId);
  }

  /**
   * Batch accept multiple approvals (AC11).
   */
  async batchAccept(changeIds: string[]): Promise<void> {
    for (const cid of changeIds) {
      await this.accept(cid).catch(() => { /* skip already-resolved */ });
    }
  }

  /**
   * Batch reject multiple approvals (AC11).
   */
  async batchReject(changeIds: string[]): Promise<void> {
    for (const cid of changeIds) {
      await this.reject(cid).catch(() => { /* skip already-resolved */ });
    }
  }

  /**
   * List all pending approvals, optionally filtered by session (AC8).
   */
  listPending(sessionId?: string): PendingApproval[] {
    const result: PendingApproval[] = [];
    for (const entry of this.#pending.values()) {
      if (entry.status !== 'pending') continue;
      if (sessionId && entry.proposal.sessionId !== sessionId) continue;
      result.push({
        changeId: entry.changeId,
        proposal: entry.proposal,
        status: entry.status,
        waitingFor: entry.waitingFor,
        queueOrder: entry.queueOrder,
        createdAt: entry.createdAt,
        timeoutMs: entry.timeoutMs,
      });
    }
    return result;
  }

  /**
   * Get the number of pending approvals for a given agent (used by ToolExecutor).
   */
  getAgentPendingCount(agentId: string): number {
    const pending = this.#agentPauseStates.get(agentId);
    if (!pending) return 0;
    let count = 0;
    for (const cid of pending) {
      const entry = this.#pending.get(cid);
      if (entry && entry.status === 'pending') count++;
    }
    return count;
  }

  /**
   * Cancel all pending approvals for an agent (agent cancel/shutdown).
   */
  cancelAgentPending(agentId: string): void {
    const pending = this.#agentPauseStates.get(agentId);
    if (!pending) return;
    for (const cid of pending) {
      this.#cancelSingle(cid);
    }
    this.#agentPauseStates.delete(agentId);
  }

  /**
   * Cancel ALL pending approvals (engine shutdown).
   */
  cancelAll(): void {
    for (const cid of [...this.#pending.keys()]) {
      this.#cancelSingle(cid);
    }
    this.#agentPauseStates.clear();
    this.#fileLocks.releaseSession('*');
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  /**
   * Cancel a single pending approval (internal).
   * Updates status to rejected if still pending and emits cleanup events.
   */
  #cancelSingle(changeId: string): void {
    const entry = this.#pending.get(changeId);
    if (!entry) return;

    this.#clearTimeout(changeId);

    if (entry.status === 'pending') {
      entry.status = 'rejected';
      this.#onEmit('approval.resolved', { changeId, status: 'rejected' });
    }

    this.#cleanup(changeId);
  }

  /**
   * Atomic compare-and-swap for approval status (AC13).
   *
   * Node.js single-thread model: Map access is atomic within one tick.
   * The race is between setTimeout callback and RPC handler arriving in the
   * same microtask queue. We guarantee user action wins by having accept/reject
   * call clearTimeout BEFORE CAS, while the timeout handler first checks the
   * CAS and only proceeds if still 'pending'.
   */
  #compareAndSwap(changeId: string, expected: ApprovalStatus, newStatus: ApprovalStatus): boolean {
    const entry = this.#pending.get(changeId);
    if (!entry || entry.status !== expected) return false;
    entry.status = newStatus;
    return true;
  }

  /**
   * Detect if this new proposal is a repeated similar diff (AC10).
   *
   * Uses Jaccard similarity on diff lines. Only checks same file + same agent.
   * After maxSimilarRetries consecutive similar rejections, the next attempt
   * is blocked and an `approval.loop_detected` event is emitted.
   */
  #detectLoop(proposal: FileChangeProposal): boolean {
    const agentId = proposal.agentId ?? 'unknown';
    const filePath = proposal.path;
    if (!filePath || !proposal.diff) return false;

    const key = `${filePath}::${agentId}`;
    const history = this.#loopDetection.get(key) ?? [];

    // Get recently rejected proposals with similar diffs
    const rejections = [];
    for (const entry of this.#pending.values()) {
      if (
        entry.status === 'rejected' &&
        entry.proposal.path === filePath &&
        entry.proposal.agentId === agentId &&
        entry.proposal.diff
      ) {
        rejections.push(entry.proposal);
      }
    }

    // Count similar rejections
    let similarCount = 0;
    for (const rejected of rejections) {
      if (rejected.diff && proposal.diff && diffSimilarity(proposal.diff, rejected.diff) >= this.#similarityThreshold) {
        similarCount++;
      }
    }

    // Also check history for persisted entries
    for (const hist of history) {
      similarCount = Math.max(similarCount, hist.similarDiffCount);
    }

    if (similarCount >= this.#maxSimilarRetries) {
      this.#onEmit('approval.loop_detected', {
        changeId: randomUUID(),
        similarRejections: similarCount,
      });
      return true; // Block this proposal
    }

    return false;
  }

  /**
   * Schedule an approval timeout (AC5).
   */
  #scheduleTimeout(changeId: string, ms: number): void {
    const timer = setTimeout(() => {
      this.#handleTimeout(changeId);
    }, ms);
    this.#timeoutTimers.set(changeId, timer);
    // Allow the process to exit even if timers are pending
    timer.unref();
  }

  /**
   * Clear a scheduled timeout (user action won the race — AC13).
   */
  #clearTimeout(changeId: string): void {
    const timer = this.#timeoutTimers.get(changeId);
    if (timer) {
      clearTimeout(timer);
      this.#timeoutTimers.delete(changeId);
    }
  }

  /**
   * Handle timeout — CAS pending→timeout (AC5, AC13).
   *
   * If CAS fails, the user already resolved (accept/reject/partial) and the
   * user action wins (AC13 user-action-priority rule).
   */
  #handleTimeout(changeId: string): void {
    if (!this.#compareAndSwap(changeId, 'pending', 'timeout')) {
      return; // Already resolved by user action — AC13 priority
    }

    this.#onEmit('approval.timeout', { changeId });
    this.#onAudit('approval.timeout', { changeId });
    this.#cleanup(changeId);
  }

  /**
   * Apply the pending write to disk (AC2 accept path).
   */
  async #applyPendingWrite(entry: PendingApprovalEntry): Promise<void> {
    const proposal = entry.proposal;
    const filePath = proposal.path;
    const content = proposal.proposedContent;
    if (!filePath || !content) {
      this.#onAudit('approval.write_skipped', {
        changeId: entry.changeId,
        reason: !filePath ? 'no file path' : 'no proposed content',
      });
      return;
    }

    try {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, content, 'utf-8');

      // Cleanup backup file if exists
      if (proposal.backupPath) {
        try {
          await unlink(proposal.backupPath);
        } catch {
          // Backup cleanup is best-effort
        }
      }
    } catch (err) {
      this.#onAudit('approval.write_failed', {
        changeId: entry.changeId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /**
   * Cleanup after a change is resolved (accepted, rejected, timeout, or cancelled).
   * Keeps the entry in #pending with resolved status for CAS conflict detection (AC13).
   */
  #cleanup(changeId: string): void {
    const entry = this.#pending.get(changeId);
    if (!entry) return;

    // Release file lock
    this.#fileLocks.release(changeId);

    // Clear from agent pause state
    const agentId = entry.proposal.agentId ?? 'unknown';
    const agentPending = this.#agentPauseStates.get(agentId);
    if (agentPending) {
      agentPending.delete(changeId);
      if (agentPending.size === 0) {
        this.#agentPauseStates.delete(agentId);
      }
    }

    // AC6: promote the next queued entry for the same file, if any
    const filePath = entry.proposal.path;
    if (filePath) {
      let nextEntry: PendingApprovalEntry | undefined;
      for (const e of this.#pending.values()) {
        if (e.status === 'pending' && e.proposal.path === filePath && e.waitingFor === changeId) {
          nextEntry = e;
          break;
        }
      }
      if (nextEntry) {
        nextEntry.waitingFor = undefined;
        this.#onEmit('approval.queued', {
          changeId: nextEntry.changeId,
          waitingFor: undefined,
          promoted: true,
        });
      }
    }

    // Clear hash
    if (filePath) {
      this.#hashStore.clear(filePath);
    }

    // AC13: Keep the entry in #pending with its resolved status so double
    // accept/reject can detect the conflict (APPROVAL_ALREADY_RESOLVED).
    // listPending() filters by status, so resolved entries are excluded.
    // Only entries that somehow remained 'pending' get force-closed.
    if (entry.status === 'pending') {
      entry.status = 'timeout';
    }
  }

  // ─── Testing / debugging accessors ─────────────────────────────────────────

  /** Exposed for testing: number of currently pending entries (excludes resolved). */
  get pendingCount(): number {
    let count = 0;
    for (const entry of this.#pending.values()) {
      if (entry.status === 'pending') count++;
    }
    return count;
  }

  /** Exposed for testing: check if a changeId exists and its current status. */
  getStatus(changeId: string): ApprovalStatus | undefined {
    const entry = this.#pending.get(changeId);
    if (!entry || entry.status !== 'pending') return undefined;
    return entry.status;
  }
}

// ─── Internal pending entry type (with mutable status) ─────────────────────────

interface PendingApprovalEntry {
  changeId: string;
  proposal: FileChangeProposal;
  status: ApprovalStatus;
  waitingFor?: string;
  queueOrder: number;
  createdAt: number;
  timeoutMs: number;
}

// ─── Diff similarity (AC10) ────────────────────────────────────────────────────

/**
 * Compute Jaccard similarity between two diffs (0.0 = completely different, 1.0 = identical).
 *
 * Uses diff lines as the feature set. Lines are split, trimmed, and compared
 * as sets. The Jaccard coefficient = intersection size / union size.
 */
function diffSimilarity(diffA: string, diffB: string): number {
  const linesA = new Set(
    diffA.split('\n').map(l => l.trim()).filter(Boolean),
  );
  const linesB = new Set(
    diffB.split('\n').map(l => l.trim()).filter(Boolean),
  );

  if (linesA.size === 0 && linesB.size === 0) return 1.0;

  let intersection = 0;
  for (const line of linesA) {
    if (linesB.has(line)) intersection++;
  }

  const union = linesA.size + linesB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
