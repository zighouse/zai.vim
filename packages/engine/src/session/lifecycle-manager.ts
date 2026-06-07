// @zaivim/engine — SessionLifecycleManager
// Manages session TTL timers, reconnection, race-condition protection,
// and message limit detection with auto-trimming.

import type { Session, Message, ISessionStore } from '@zaivim/core';
import { ZaiSessionNotFoundError } from '@zaivim/core';
import { EventEmitter } from 'node:events';

const DEFAULT_RECONNECT_WINDOW_MS = 30 * 60 * 1000; // 30 min
const DEFAULT_RECONNECT_EXTENSION_MS = 10 * 60 * 1000; // +10 min
const DEFAULT_MAX_SESSION_MESSAGES = 1000;
const DEFAULT_TRIM_KEEP_COUNT = 500;
const DEFAULT_APPROACHING_THRESHOLD = 0.9; // 90% of max

export interface LifecycleNotification {
  type: 'session.approaching_limit' | 'session.auto_trimmed';
  sessionId: string;
  current: number;
  max: number;
  removed?: number;
}

export interface SessionLifecycleManagerOptions {
  reconnectWindowMs?: number;
  reconnectExtensionMs?: number;
  maxSessionMessages?: number;
  trimKeepCount?: number;
  approachingThreshold?: number;
}

export class SessionLifecycleManager extends EventEmitter {
  readonly #store: ISessionStore;
  readonly #reconnectWindowMs: number;
  readonly #reconnectExtensionMs: number;
  readonly #maxSessionMessages: number;
  readonly #trimKeepCount: number;
  readonly #approachingThreshold: number;

  #ttlTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  #disposed = false;

  constructor(store: ISessionStore, options: SessionLifecycleManagerOptions = {}) {
    super();
    this.#store = store;
    this.#reconnectWindowMs = options.reconnectWindowMs ?? DEFAULT_RECONNECT_WINDOW_MS;
    this.#reconnectExtensionMs = options.reconnectExtensionMs ?? DEFAULT_RECONNECT_EXTENSION_MS;
    this.#maxSessionMessages = options.maxSessionMessages ?? DEFAULT_MAX_SESSION_MESSAGES;
    this.#trimKeepCount = options.trimKeepCount ?? DEFAULT_TRIM_KEEP_COUNT;
    this.#approachingThreshold = options.approachingThreshold ?? DEFAULT_APPROACHING_THRESHOLD;
  }

  // ---- Disconnection TTL management (AC4, AC5) ----

  /** Mark a session as disconnected and start TTL timer. */
  markDisconnected(sessionId: string): void {
    const session = this.#store.get(sessionId);
    if (!session) throw new ZaiSessionNotFoundError(sessionId);

    (session as { disconnectedAt: number }).disconnectedAt = Date.now();
    (session as { reconnecting: boolean }).reconnecting = false;

    this.#startTtlTimer(sessionId);
  }

  /** Begin reconnection attempt — prevents TTL cleanup (AC5). */
  beginReconnect(sessionId: string): void {
    const session = this.#store.get(sessionId);
    if (!session) throw new ZaiSessionNotFoundError(sessionId);

    (session as { reconnecting: boolean }).reconnecting = true;
  }

  /** Complete reconnection — cancels TTL timer (AC5). */
  completeReconnect(sessionId: string): void {
    const session = this.#store.get(sessionId);
    if (!session) throw new ZaiSessionNotFoundError(sessionId);

    (session as { reconnecting: boolean }).reconnecting = false;
    (session as { disconnectedAt: number | undefined }).disconnectedAt = undefined;

    this.#clearTtlTimer(sessionId);
  }

  /** Cancel reconnection attempt. */
  cancelReconnect(sessionId: string): void {
    const session = this.#store.get(sessionId);
    if (!session) return;

    (session as { reconnecting: boolean }).reconnecting = false;
  }

  // ---- Message limit detection (AC6) ----

  /** Check message count and emit warnings/trim if needed. Call after pushMessage. */
  checkMessageLimit(sessionId: string): void {
    const session = this.#store.get(sessionId);
    if (!session) return;

    const count = session.messages.length;
    const approachingAt = Math.floor(this.#maxSessionMessages * this.#approachingThreshold);

    // Approaching limit warning
    if (count >= approachingAt && count < this.#maxSessionMessages) {
      this.emit('lifecycle.notification', {
        type: 'session.approaching_limit',
        sessionId,
        current: count,
        max: this.#maxSessionMessages,
      } as LifecycleNotification);
    }

    // Auto-trim when limit reached
    if (count >= this.#maxSessionMessages) {
      this.trimMessages(sessionId);
    }
  }

  /** Trim messages — keep pinned + recent N (AC6). */
  trimMessages(sessionId: string): void {
    const session = this.#store.get(sessionId);
    if (!session) throw new ZaiSessionNotFoundError(sessionId);

    const messages = session.messages;
    const pinned = messages.filter(m => m.pinned === true);
    const nonPinned = messages.filter(m => m.pinned !== true);

    const removed = Math.max(0, nonPinned.length - this.#trimKeepCount);
    if (removed === 0) return;

    const kept = nonPinned.slice(-this.#trimKeepCount);
    const trimmed = [...pinned, ...kept];

    (session as { messages: Message[] }).messages = trimmed;

    this.emit('lifecycle.notification', {
      type: 'session.auto_trimmed',
      sessionId,
      current: trimmed.length,
      max: this.#maxSessionMessages,
      removed,
    } as LifecycleNotification);
  }

  // ---- TTL timer internals ----

  #startTtlTimer(sessionId: string): void {
    this.#clearTtlTimer(sessionId);

    const timer = setTimeout(() => {
      this.#handleTtlExpiry(sessionId);
    }, this.#reconnectWindowMs);

    this.#ttlTimers.set(sessionId, timer);
  }

  #clearTtlTimer(sessionId: string): void {
    const timer = this.#ttlTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.#ttlTimers.delete(sessionId);
    }
  }

  #handleTtlExpiry(sessionId: string): void {
    this.#ttlTimers.delete(sessionId);

    if (this.#disposed) return;

    const session = this.#store.get(sessionId);
    if (!session) return;

    // AC5: Race-condition protection — extend if reconnecting
    if (session.reconnecting) {
      // Extend by reconnectExtensionMs (+10min per AC5), not the full window
      const timer = setTimeout(() => {
        this.#handleTtlExtensionExpiry(sessionId);
      }, this.#reconnectExtensionMs);
      this.#ttlTimers.set(sessionId, timer);
      return;
    }

    // Session expired — close it
    this.#store.close(sessionId).catch(() => { /* already closed */ });
  }

  #handleTtlExtensionExpiry(sessionId: string): void {
    this.#ttlTimers.delete(sessionId);
    if (this.#disposed) return;
    const session = this.#store.get(sessionId);
    if (!session) return;

    // Still reconnecting after extension? Close anyway to avoid indefinite hold
    this.#store.close(sessionId).catch(() => { /* already closed */ });
  }

  // ---- Cleanup ----

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const timer of this.#ttlTimers.values()) {
      clearTimeout(timer);
    }
    this.#ttlTimers.clear();
    this.removeAllListeners();
  }
}
