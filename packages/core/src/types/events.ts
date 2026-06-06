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

export interface EngineEventMap {
  'session.created': SessionCreatedEvent;
  'session.closed': SessionClosedEvent;
  'session.approaching_limit': SessionApproachingLimitEvent;
  'session.auto_trimmed': SessionAutoTrimmedEvent;
  'session.persistence.dropped': SessionPersistenceDroppedEvent;
  'session.recovered': SessionRecoveredEvent;
  'security.degraded': SecurityDegradedEvent;
  'engine.warning': EngineWarningEvent;
  'engine.shutdown': EngineShutdownEvent;
}

export type EngineEventType = keyof EngineEventMap;

export type EngineEventData<T extends EngineEventType = EngineEventType> =
  T extends keyof EngineEventMap ? EngineEventMap[T] : never;
