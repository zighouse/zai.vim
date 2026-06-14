// =============================================================================
// @zaivim/core — Approval types (Story 3.5)
// Async diff review and change approval types.
// =============================================================================

import type { FileChangeProposal } from './security.js';

/** Approval lifecycle status (AC1-AC5, AC13) */
export type ApprovalStatus = 'pending' | 'accepted' | 'rejected' | 'timeout' | 'partial';

/**
 * Pending approval entry managed by ApprovalManager.
 *
 * Each pending approval represents a FileChangeProposal waiting for user
 * decision — accept, reject, partial, or timeout.
 */
export interface PendingApproval {
  readonly changeId: string;
  readonly proposal: FileChangeProposal;
  readonly status: ApprovalStatus;
  readonly waitingFor?: string;
  readonly queueOrder: number;
  readonly createdAt: number;
  readonly timeoutMs: number;
}

/**
 * Loop detection state for repeated similar diff rejections (AC10).
 *
 * Tracks consecutive similar-diff rejections per file+agent combo so the
 * engine can halt the cycle and ask the user for guidance.
 */
export interface ApprovalLoopDetection {
  readonly filePath: string;
  readonly agentId: string;
  readonly similarDiffCount: number;
  readonly firstRejectedAt: number;
}

/**
 * Approval event notifications (FR73/FR74).
 *
 * These are emitted as `$/notification` events through the engine's EventBus
 * and forwarded to the client via gateway transport.
 */
export type ApprovalEvent =
  | { type: 'approval.request'; changeId: string; proposal: FileChangeProposal; timeoutMs: number; agentId: string; sessionId: string }
  | { type: 'approval.resolved'; changeId: string; status: ApprovalStatus; acceptedFiles?: string[]; rejectedFiles?: string[] }
  | { type: 'approval.timeout'; changeId: string }
  | { type: 'approval.queued'; changeId: string; waitingFor: string }
  | { type: 'approval.stale'; changeId: string; reason: string }
  | { type: 'approval.loop_detected'; changeId: string; similarRejections: number };

/**
 * Approval callback injected into ToolContext (Story 3.5).
 *
 * When present, file_write tools submit changes for async approval instead
 * of applying them immediately. Absent = backward-compatible immediate write.
 */
export type RequestApprovalFn = (proposal: FileChangeProposal) => Promise<PendingApproval>;
