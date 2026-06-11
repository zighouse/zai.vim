// @zaivim/engine — Security Monitor (Story 2.2, Task 5)
// Periodic health monitoring for security status changes.
// Emits notifications on degradation/recovery with debounce.

import type { AuditLogger } from './audit-logger.js';

// ============================================================================
// Types
// ============================================================================

export type SecurityLevel = 'secure' | 'degraded' | 'at-risk';

export interface SecurityHealth {
  readonly level: SecurityLevel;
  readonly sandboxAvailable: boolean;
  readonly auditHealthy: boolean;
  readonly classifierHealthy: boolean;
  readonly auditBacklog: number;
  readonly lastChecked: number;
}

export interface SecurityStatusChange {
  readonly from: SecurityLevel;
  readonly to: SecurityLevel;
  readonly reason: string;
  readonly implications: readonly string[];
  readonly timestamp: string;
}

export type SecurityChangeListener = (change: SecurityStatusChange) => void;

interface HealthCheckFn {
  (): Promise<SecurityHealth>;
}

// ============================================================================
// Constants
// ============================================================================

/** Cache TTL for health check results (Task 5.1 — 30s) */
const HEALTH_CACHE_TTL_MS = 30_000;

/** Debounce interval before sending notifications (Task 5.1.1 — 2s) */
const DEBOUNCE_MS = 2_000;

/** Recent events to cache for new clients (Task 5.5 — keep last 5) */
const MAX_CACHED_EVENTS = 5;

// ============================================================================
// SecurityMonitor
// ============================================================================

export class SecurityMonitor {
  #healthCheck: HealthCheckFn;
  #cachedHealth: SecurityHealth | null = null;
  #lastCheckTime: number = 0;
  #currentLevel: SecurityLevel;
  #previousLevel: SecurityLevel;
  #debounceTimer: ReturnType<typeof setTimeout> | null = null;
  #debounceCandidate: SecurityStatusChange | null = null;
  #cachedEvents: SecurityStatusChange[] = [];
  #listeners: SecurityChangeListener[] = [];
  #auditLogger?: AuditLogger;
  #testMode: boolean;

  constructor(healthCheck: HealthCheckFn, auditLogger?: AuditLogger, testMode: boolean = false) {
    this.#healthCheck = healthCheck;
    this.#auditLogger = auditLogger;
    this.#testMode = testMode;
    this.#currentLevel = 'secure';
    this.#previousLevel = 'secure';
  }

  // ---- Public API ----

  /**
   * Get current security health (with caching, Task 5.1)
   */
  async getHealth(): Promise<SecurityHealth> {
    const now = Date.now();
    if (this.#cachedHealth && (now - this.#lastCheckTime) < HEALTH_CACHE_TTL_MS) {
      return this.#cachedHealth;
    }

    const health = await this.#healthCheck();
    this.#cachedHealth = health;
    this.#lastCheckTime = now;

    // Detect level changes
    const newLevel = health.level;
    if (newLevel !== this.#currentLevel) {
      this.#previousLevel = this.#currentLevel;
      this.#currentLevel = newLevel;
      this.#onLevelChange(this.#previousLevel, newLevel, health);
    }

    return health;
  }

  /**
   * Get current security level (without triggering a check)
   */
  get currentLevel(): SecurityLevel {
    return this.#currentLevel;
  }

  /**
   * Get cached recent security events for new client sync (Task 5.5)
   */
  get recentEvents(): SecurityStatusChange[] {
    return [...this.#cachedEvents];
  }

  /**
   * Register a listener for security status changes
   */
  onChange(listener: SecurityChangeListener): void {
    this.#listeners.push(listener);
  }

  /**
   * Force refresh health and return current level
   */
  async refreshNow(): Promise<SecurityLevel> {
    this.#cachedHealth = null;
    this.#lastCheckTime = 0;
    const health = await this.getHealth();
    return health.level;
  }

  /**
   * Shutdown the monitor (clean up timers)
   */
  shutdown(): void {
    if (this.#debounceTimer) {
      clearTimeout(this.#debounceTimer);
      this.#debounceTimer = null;
    }
    this.#listeners = [];
  }

  // ---- Private ----

  /**
   * Handle level change with debounce (Task 5.1.1)
   */
  #onLevelChange(from: SecurityLevel, to: SecurityLevel, health: SecurityHealth): void {
    const change = this.#buildChange(from, to, health);

    // Push to cached events (Task 5.5)
    this.#cachedEvents.push(change);
    if (this.#cachedEvents.length > MAX_CACHED_EVENTS) {
      this.#cachedEvents.shift();
    }

    // Log to audit immediately (not debounced — Task 5.1.1)
    this.#logStatusChange(change);

    // Debounce notification emission
    if (this.#debounceTimer) {
      clearTimeout(this.#debounceTimer);
    }

    this.#debounceCandidate = change;
    this.#debounceTimer = setTimeout(() => {
      this.#debounceTimer = null;
      if (this.#debounceCandidate) {
        this.#emitChange(this.#debounceCandidate);
        this.#debounceCandidate = null;
      }
    }, DEBOUNCE_MS);
  }

  /**
   * Build a status change event
   */
  #buildChange(from: SecurityLevel, to: SecurityLevel, health: SecurityHealth): SecurityStatusChange {
    let reason: string;
    let implications: string[];

    if (to === 'degraded') {
      if (!health.sandboxAvailable) {
        reason = 'bwrap not found';
        implications = ['shell execution disabled', 'risk level elevated'];
      } else if (health.auditBacklog > 1000) {
        reason = 'audit backlog exceeds threshold';
        implications = ['audit writes may be delayed', 'temporary data loss possible'];
      } else {
        reason = 'security component degraded';
        implications = ['some security features unavailable'];
      }
    } else if (to === 'at-risk') {
      if (!health.auditHealthy) {
        reason = 'audit log write failed';
        implications = ['security events not being recorded', 'incident response impaired'];
      } else if (!health.classifierHealthy) {
        reason = 'harm classifier unavailable';
        implications = ['operations may not be properly classified', 'security decisions degraded'];
      } else {
        reason = 'critical security component failure';
        implications = ['system at elevated risk'];
      }
    } else {
      // secure
      if (from === 'degraded') {
        reason = 'bwrap restored';
        implications = ['shell execution re-enabled', 'full sandbox protection active'];
      } else {
        reason = 'all security components healthy';
        implications = ['full security protection active'];
      }
    }

    return {
      from,
      to,
      reason,
      implications: Object.freeze(implications),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Emit change to listeners
   *
   * In test mode (Task 5.6), downgrades to log level output instead of
   * sending $/notification events to prevent test interference.
   */
  #emitChange(change: SecurityStatusChange): void {
    // Test mode: log to console instead of sending notifications (Task 5.6)
    if (this.#testMode) {
      console.log(
        `[SecurityMonitor:TEST] Security status changed: ${change.from} → ${change.to} — ${change.reason}`,
      );
      console.log(`[SecurityMonitor:TEST] Implications: ${change.implications.join(', ')}`);
      return;
    }

    // Normal mode: send notifications to all listeners
    for (const listener of this.#listeners) {
      try {
        listener(change);
      } catch {
        // Listener errors should not propagate
      }
    }
  }

  /**
   * Log status change to audit (internal path, no preExecute — Task 5.2.2, 5.2.3)
   */
  #logStatusChange(change: SecurityStatusChange): void {
    if (this.#auditLogger) {
      this.#auditLogger.log({
        timestamp: change.timestamp,
        sessionId: '',
        operation: 'security_status_change',
        harmLevel: change.to === 'secure' ? 'C' : change.to === 'degraded' ? 'B' : 'A',
        decision: 'allowed',
        reason: `Security status changed: ${change.from} → ${change.to} — ${change.reason}`,
        user: 'system',
        metadata: {
          from: change.from,
          to: change.to,
          implications: change.implications,
        },
      }).catch(() => {});
    }
  }
}
