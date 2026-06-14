// @zaivim/core — Engine event type definitions
// Pure data types, zero runtime dependencies.
// EventBus implementation lives in @zaivim/engine.

import type {
  SessionApproachingLimitEvent,
  SessionAutoTrimmedEvent,
  SessionPersistenceDroppedEvent,
  SessionRecoveredEvent,
} from './session.js';

export interface SessionCreatedEvent {
  sessionId: string;
}

export interface SessionClosedEvent {
  sessionId: string;
  reason?: string;
}

export interface SecurityDegradedEvent {
  reason: string;
  implications: string[];
}

export interface EngineWarningEvent {
  message: string;
  data?: unknown;
}

export interface EngineShutdownEvent {
  reason: string;
  force: boolean;
}

// ---- Provider events (Story 1b.5) ----------------------------------------

export interface ProviderRetryEvent {
  provider: string;
  attempt: number;
  maxAttempts: number;
  delayMs: number;
}

export interface ProviderRecoveredEvent {
  provider: string;
}

export interface ProviderAuthFailedEvent {
  provider: string;
  hint: string;
}

export interface ProviderModelNotFoundEvent {
  provider: string;
}

export interface ProviderRateLimitedEvent {
  provider: string;
  retryAfterMs: number;
  queuedSessions: number;
}

export interface ProviderFallbackEvent {
  from: string;
  to: string;
}

export interface ProviderStatusEvent {
  status: 'degraded' | 'available';
  provider: string;
}

export interface ContextAutoTrimmedEvent {
  sessionId: string;
  removedCount: number;
}

export interface EngineEventMap {
  'session.created': SessionCreatedEvent;
  'session.closed': SessionClosedEvent;
  'session.approaching_limit': SessionApproachingLimitEvent;
  'session.auto_trimmed': SessionAutoTrimmedEvent;
  'session.persistence.dropped': SessionPersistenceDroppedEvent;
  'session.recovered': SessionRecoveredEvent;
  'session.project_context_updated': import('./index.js').ProjectContextUpdatedEvent;
  'security.degraded': SecurityDegradedEvent;
  'engine.warning': EngineWarningEvent;
  'engine.shutdown': EngineShutdownEvent;
  'provider.retry': ProviderRetryEvent;
  'provider.recovered': ProviderRecoveredEvent;
  'provider.auth_failed': ProviderAuthFailedEvent;
  'provider.model_not_found': ProviderModelNotFoundEvent;
  'provider.rate_limited': ProviderRateLimitedEvent;
  'provider.fallback': ProviderFallbackEvent;
  'provider.status': ProviderStatusEvent;
  'context.auto_trimmed': ContextAutoTrimmedEvent;

  // ---- Approval events (Story 3.5) -----------------------------------------

  /** A file change proposal is pending user approval (AC1) */
  'approval.request': {
    readonly changeId: string;
    readonly proposal: import('./security.js').FileChangeProposal;
    readonly timeoutMs: number;
    readonly agentId: string;
    readonly sessionId: string;
  };
  /** An approval has been resolved (AC2/AC3/AC4) */
  'approval.resolved': {
    readonly changeId: string;
    readonly status: import('./approval.js').ApprovalStatus;
    readonly acceptedFiles?: string[];
    readonly rejectedFiles?: string[];
  };
  /** Approval timed out (AC5) */
  'approval.timeout': {
    readonly changeId: string;
  };
  /** Proposal queued behind an earlier one for the same file (AC6) */
  'approval.queued': {
    readonly changeId: string;
    readonly waitingFor: string;
  };
  /** File was modified externally while pending — proposal stale (AC9) */
  'approval.stale': {
    readonly changeId: string;
    readonly reason: string;
  };
  /** Repeated similar diff rejections detected (AC10) */
  'approval.loop_detected': {
    readonly changeId: string;
    readonly similarRejections: number;
  };
}

export type EngineEventType = keyof EngineEventMap;

export type EngineEventData<T extends EngineEventType = EngineEventType> =
  T extends keyof EngineEventMap ? EngineEventMap[T] : never;
