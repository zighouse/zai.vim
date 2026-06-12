// @zaivim/engine — Audit constants
// Default values overridable via loadConfig() engine.constants (Epic 1a, Story 1a.1a LE3)

import type { SafetyLevel } from '@zaivim/core';

export const AUDIT_CONSTANTS = {
  /** Max size in MB for a single daily JSONL file before rotation */
  maxFileSizeMB: 100,
  /** Max total size in MB for the entire audit directory before cleanup */
  maxTotalSizeMB: 1000,
  /** Retention days per safety level (S: 90, A: 30, B/C: 10) */
  retentionDays: {
    S: 90,
    A: 30,
    B: 10,
    C: 10,
  } as Record<SafetyLevel, number>,
  /** Per-session token bucket rate (requests/sec) */
  rateLimitPerSec: 100,
  /** Global token bucket rate (requests/sec across all sessions) */
  globalRateLimitPerSec: 500,
  /** Max size in bytes for a single parameter before truncation */
  maxParamSizeBytes: 65536,
  /** Max total size in bytes for a single audit record */
  maxRecordSizeBytes: 102400,
  /** Target write latency in ms (NFR8) */
  writeLatencyMs: 5,
  /** Interval in ms between flush cycles */
  flushIntervalMs: 100,
  /** Number of buffered entries that triggers a flush */
  flushBatchSize: 50,
  /** Buffer size that triggers degraded state */
  bufferHighWaterMark: 1000,
  /** Interval in ms between tamper checks */
  tamperCheckIntervalMs: 30_000,
} as const;
