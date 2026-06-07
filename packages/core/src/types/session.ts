// @zaivim/core — Session store interface and persistence types
// ISessionStore lifted to core for dependency inversion (ADR-6).
// Zero external dependencies.

import type { Session, Message, SessionStatus } from './index.js';

// ---- JSONL file header (AC10, AC13) ----

export interface SessionMeta {
  readonly format_version: number;
  readonly engine_version: string;
  readonly created_at: string;
  readonly project_dir?: string;
}

// ---- Session persistence events ----

export interface SessionApproachingLimitEvent {
  readonly type: 'session.approaching_limit';
  readonly sessionId: string;
  readonly current: number;
  readonly max: number;
}

export interface SessionAutoTrimmedEvent {
  readonly type: 'session.auto_trimmed';
  readonly sessionId: string;
  readonly removed: number;
  readonly retained: number;
}

export interface SessionPersistenceDroppedEvent {
  readonly type: 'session.persistence.dropped';
  readonly sessionId: string;
  readonly count: number;
}

export interface SessionRecoveredEvent {
  readonly type: 'session.recovered';
  readonly sessionId: string;
  readonly recoveredCount: number;
  readonly skippedLines: number;
}

// ---- Session summary (AC4) ----

export interface SessionSummary {
  readonly id: string;
  readonly createdAt: number;
  readonly status: SessionStatus;
  readonly messageCount: number;
  readonly projectDir?: string;
  readonly lastActivityAt?: number;
}

// ---- ISessionStore interface (ADR-6, AC9) ----

export interface ListFilter {
  status?: SessionStatus;
  projectDir?: string;
  limit?: number;
  offset?: number;
  sortBy?: 'createdAt' | 'lastActivityAt';
  sortOrder?: 'asc' | 'desc';
}

export interface ISessionStore {
  create(config?: Partial<import('./config.js').ZaiConfig>, projectDir?: string): Session;
  get(id: string): Session | undefined;
  close(id: string): Promise<void>;
  list(filter?: ListFilter): Session[];
  pushMessage(id: string, msg: Message): void;
  queryByProject(projectDir: string): Session[];
  persistAll(): Promise<void>;
  recoverFromDisk(): Promise<Session[]>;
  readonly activeCount: number;
}
