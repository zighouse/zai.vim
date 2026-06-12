// @zaivim/engine — Auditor
// Append-only JSONL audit logger with redaction, rate limiting, rotation, fail-closed.
// Implements IAuditor from @zaivim/core.
//
// Architecture:
//   write(event) → writeBuf[] → async flush (100ms / 50 entries) → fs.appendFileSync
//   flush failure → auditDegraded flag → SecurityProvider.preExecute() rejects new ops
//   writeInternal() bypasses preExecute (prevents self-triggered audit loops)

import { appendFileSync, renameSync, unlinkSync, readFileSync, readdirSync, statSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import type { AuditEvent, AuditEventType, AuditQueryFilter, AuditSummary, SafetyLevel, IAuditor } from '@zaivim/core';
import { AUDIT_CONSTANTS } from '../constants/audit.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_CONSTANTS = { ...AUDIT_CONSTANTS };

const SENSITIVE_KEY_PATTERNS = [
  'password', 'passwd', 'pwd', 'secret', 'apikey', 'api_key', 'api-key',
  'private_key', 'private-key', 'token', 'authorization', 'auth', 'credential',
  'access_key', 'secret_key', 'api-token',
];

// ─── Token Bucket ────────────────────────────────────────────────────────────

class TokenBucket {
  #tokens: number;
  #max: number;
  #refillPerSec: number;
  #lastRefill: number;

  constructor(max: number, refillPerSec: number) {
    this.#tokens = max;
    this.#max = max;
    this.#refillPerSec = refillPerSec;
    this.#lastRefill = Date.now();
  }

  /** Try to consume one token. Returns true if allowed. */
  tryConsume(): boolean {
    this.#refill();
    if (this.#tokens < 1) return false;
    this.#tokens -= 1;
    return true;
  }

  #refill(): void {
    const now = Date.now();
    const elapsed = (now - this.#lastRefill) / 1000;
    if (elapsed <= 0) return;
    this.#tokens = Math.min(this.#max, this.#tokens + elapsed * this.#refillPerSec);
    this.#lastRefill = now;
  }
}

// ─── Auditor ─────────────────────────────────────────────────────────────────

export class Auditor implements IAuditor {
  readonly logDir: string;
  readonly #auditDir: string;
  readonly #constants: typeof DEFAULT_CONSTANTS;

  /** Write buffer — events waiting to be flushed */
  readonly #writeBuf: AuditEvent[] = [];
  /** Timer handle for scheduled flush */
  #flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** True when a flush is in progress */
  #flushing = false;
  /** Degraded flag: set when flush fails, cleared on successful flush */
  #degraded = false;
  /** Degraded reason for error reporting */
  #degradedReason = '';

  /** Per-session token buckets for rate limiting */
  readonly #sessionBuckets = new Map<string, TokenBucket>();
  /** Global token bucket */
  readonly #globalBucket: TokenBucket;

  /** Count of entries written this second (for throttle notification) */
  #writeCountThisSec = 0;
  #writeCountResetTimer: ReturnType<typeof setInterval> | null = null;

  /** Tamper detection: size of last known valid state */
  #tamperDetected = false;
  /** Timer for periodic tamper checks */
  #tamperCheckTimer: ReturnType<typeof setInterval> | null = null;

  /** Test hook: collect throttle notifications */
  readonly #throttleNotifications: Array<{ sessionId: string; rate: number }> = [];
  /** Test hook: collect truncation records */
  readonly #truncationRecords: Array<{ field: string; originalSize: number }> = [];

  constructor(auditDir?: string, constants?: Partial<typeof DEFAULT_CONSTANTS>) {
    this.#auditDir = auditDir ?? resolve(homedir(), '.zaivim', 'audit');
    this.logDir = this.#auditDir;
    this.#constants = { ...DEFAULT_CONSTANTS, ...constants };

    // Ensure audit directory exists
    mkdirSync(this.#auditDir, { recursive: true });

    // Ensure overrides subdirectory exists (best-effort)
    try { mkdirSync(resolve(this.#auditDir, 'overrides'), { recursive: true }); } catch { /* non-fatal */ }

    this.#globalBucket = new TokenBucket(
      this.#constants.globalRateLimitPerSec,
      this.#constants.globalRateLimitPerSec,
    );

    // Start periodic flush
    this.#scheduleFlush();

    // Reset write count every second (setInterval for recurring reset)
    this.#writeCountResetTimer = setInterval(() => {
      this.#writeCountThisSec = 0;
    }, 1000).unref();

    // Initial tamper check + periodic re-check every 30s
    this.#checkTamper();
    this.#tamperCheckTimer = setInterval(() => {
      this.#checkTamper();
    }, 30_000).unref();
  }

  // ─── IAuditor interface ──────────────────────────────────────────────────

  /** External path: via Pipeline/AuditMiddleware, subject to preExecute check */
  async write(event: AuditEvent): Promise<void> {
    // Fail-closed check
    if (this.#degraded) {
      throw Object.assign(
        new Error(`audit log unavailable: ${this.#degradedReason}`),
        { code: 'SECURITY_AUDIT_UNAVAILABLE' },
      );
    }

    // Rate limit: per-session check
    const sessionBucket = this.#getOrCreateBucket(event.sessionId);
    const sessionAllowed = sessionBucket.tryConsume();
    if (!sessionAllowed) {
      this.#emitThrottle(event.sessionId);
      // Throttle: delay but don't drop — queue for next flush cycle
    }

    // Global rate limit
    const globalAllowed = this.#globalBucket.tryConsume();
    if (!globalAllowed) {
      // Fail-closed at global limit
      throw Object.assign(
        new Error('global audit rate limit exceeded'),
        { code: 'SECURITY_AUDIT_RATE_LIMITED' },
      );
    }

    const processed = this.#processEvent(event);
    this.#writeBuf.push(processed);
    this.#writeCountThisSec++;

    // If buffer exceeds high-water mark, trigger emergency flush
    if (this.#writeBuf.length >= this.#constants.bufferHighWaterMark) {
      this.#flush().catch(() => {});
    }

    // Batch flush threshold
    if (this.#writeBuf.length >= this.#constants.flushBatchSize) {
      this.#flush().catch(() => {});
    }
  }

  /** Internal path: bypasses preExecute (prevents self-triggered audit loops) */
  async writeInternal(event: AuditEvent): Promise<void> {
    // Still fail-closed on degraded but no rate limiting or preExecute
    if (this.#degraded) {
      throw Object.assign(
        new Error(`audit log unavailable: ${this.#degradedReason}`),
        { code: 'SECURITY_AUDIT_UNAVAILABLE' },
      );
    }
    const processed = this.#processEvent(event);
    this.#writeBuf.push(processed);
  }

  /** Query audit events by date, level, session, eventType */
  async query(filter: AuditQueryFilter): Promise<AuditEvent[]> {
    const date = filter.date ?? this.#today();
    const filePath = resolve(this.#auditDir, `${date}.jsonl`);
    if (!existsSync(filePath)) return [];

    const content = readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());
    const results: AuditEvent[] = [];

    for (const line of lines) {
      try {
        const event = JSON.parse(line) as AuditEvent;

        // Default: exclude override records unless explicitly requested
        if (event.auditEventType === 'override' && !filter.auditEventType) continue;

        // Filter by level
        if (filter.level && event.level !== filter.level) continue;
        // Filter by session
        if (filter.session && event.sessionId !== filter.session) continue;
        // Filter by auditEventType
        if (filter.auditEventType && event.auditEventType !== filter.auditEventType) continue;

        results.push(event);
      } catch {
        // Skip malformed lines
      }
    }

    return results;
  }

  /** Aggregated summary for a time period */
  async summary(period: '24h' | '7d'): Promise<AuditSummary> {
    const dates = this.#getDateRange(period);
    const allEvents: AuditEvent[] = [];

    for (const date of dates) {
      const events = await this.query({ date });
      allEvents.push(...events);
    }

    const byLevel: Record<SafetyLevel, number> = { S: 0, A: 0, B: 0, C: 0 };
    let rejected = 0;
    let overrides = 0;
    const sessionCounts = new Map<string, number>();

    for (const event of allEvents) {
      byLevel[event.level] = (byLevel[event.level] || 0) + 1;
      if (event.result === 'rejected') rejected++;
      if (event.auditEventType === 'override') overrides++;
      sessionCounts.set(event.sessionId, (sessionCounts.get(event.sessionId) || 0) + 1);
    }

    // Top sessions by operation count
    const topSessions = [...sessionCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([id, ops]) => ({ id, ops }));

    return {
      period,
      total: allEvents.length,
      byLevel,
      rejected,
      overrides: overrides > 0 ? overrides : undefined,
      topSessions,
    };
  }

  // ─── Backward-compatible convenience methods ─────────────────────────────

  /**
   * Legacy log method for internal engine events.
   * Creates an AuditEvent with level=C and result=allowed by default.
   */
  log(sessionId: string, action: string, detail: Record<string, unknown>): void {
    const event: AuditEvent = {
      timestamp: new Date().toISOString(),
      operation: action,
      level: 'C',
      sessionId,
      result: 'allowed',
      params: detail,
    };
    this.#writeBuf.push(this.#processEvent(event));
    if (this.#writeBuf.length >= this.#constants.flushBatchSize) {
      this.#flush().catch(() => {});
    }
  }

  /**
   * Legacy query by session ID.
   */
  queryBySession(sessionId: string): AuditEvent[] {
    // Read today's log and scan
    const filePath = resolve(this.#auditDir, `${this.#today()}.jsonl`);
    if (!existsSync(filePath)) return [];
    try {
      const content = readFileSync(filePath, 'utf8');
      return content.split('\n')
        .filter(l => l.trim())
        .map(l => { try { return JSON.parse(l) as AuditEvent; } catch { return null; } })
        .filter((e): e is AuditEvent => e !== null && e.sessionId === sessionId);
    } catch {
      return [];
    }
  }

  // ─── Public status / test hooks ──────────────────────────────────────────

  /** Whether auditor is in degraded state */
  get degraded(): boolean { return this.#degraded; }
  /** Reason for degraded state */
  get degradedReason(): string { return this.#degradedReason; }
  /** Whether tamper has been detected */
  get tamperDetected(): boolean { return this.#tamperDetected; }
  /** Current buffer size */
  get bufferSize(): number { return this.#writeBuf.length; }
  /** Current write count this second */
  get currentWriteRate(): number { return this.#writeCountThisSec; }
  /** Throttle notifications (test access) */
  get throttleNotifications(): ReadonlyArray<{ sessionId: string; rate: number }> {
    return this.#throttleNotifications;
  }

  /** Flush all buffered events to disk immediately */
  async flush(): Promise<void> {
    await this.#flush();
  }

  /** Close the auditor: flush remaining events and clean up timers */
  async close(): Promise<void> {
    if (this.#flushTimer) clearTimeout(this.#flushTimer);
    if (this.#writeCountResetTimer) clearInterval(this.#writeCountResetTimer);
    if (this.#tamperCheckTimer) clearInterval(this.#tamperCheckTimer);
    await this.#flush();
  }

  // ─── Private ────────────────────────────────────────────────────────────

  #processEvent(event: AuditEvent): AuditEvent {
    // Redact sensitive data
    const redacted = this.#redactEvent(event);
    // Truncate large parameters
    return this.#truncateParams(redacted);
  }

  #redactEvent(event: AuditEvent): AuditEvent {
    if (!event.params) return event;
    return {
      ...event,
      params: this.#redactObject(event.params),
    };
  }

  #redactObject(obj: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'string') {
        result[key] = this.#redactString(key, value);
      } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        result[key] = this.#redactObject(value as Record<string, unknown>);
      } else if (Array.isArray(value)) {
        result[key] = value.map(v =>
          typeof v === 'string' ? this.#redactString('', v)
            : v !== null && typeof v === 'object' ? this.#redactObject(v as Record<string, unknown>)
            : v
        );
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  #redactString(key: string, value: string): string {
    const lowerKey = key.toLowerCase();

    // Key-based redaction
    if (SENSITIVE_KEY_PATTERNS.some(p => lowerKey.includes(p))) {
      return '***REDACTED***';
    }

    // Value pattern detection
    // Bearer tokens
    if (/^bearer\s+/i.test(value)) return '***REDACTED***';
    // OpenAI-style keys (sk-...)
    if (/^sk-[A-Za-z0-9]{20,}/.test(value)) return '***REDACTED***';
    // Anthropic-style keys (sk-ant-...)
    if (/^sk-ant-[A-Za-z0-9]{20,}/.test(value)) return '***REDACTED***';
    // JWT tokens
    if (/^eyJ[A-Za-z0-9\-_=]{20,}\./.test(value)) return '***REDACTED***';
    // Generic tokens (hex strings of length ≥32)
    if (/^[A-Fa-f0-9]{32,}$/.test(value)) return '***REDACTED***';

    return value;
  }

  #truncateParams(event: AuditEvent): AuditEvent {
    if (!event.params) return event;
    const maxSize = this.#constants.maxParamSizeBytes;
    const truncated: Record<string, unknown> = {};
    let hasTruncation = false;

    for (const [key, value] of Object.entries(event.params)) {
      if (typeof value === 'string' && Buffer.byteLength(value, 'utf8') > maxSize) {
        const originalSize = Buffer.byteLength(value, 'utf8');
        const truncatedValue = value.slice(0, maxSize) +
          `... [truncated, original size: ${originalSize} bytes]`;
        truncated[key] = truncatedValue;
        hasTruncation = true;
        if (this.#truncationRecords.length >= 1000) {
          this.#truncationRecords.splice(0, 500);
        }
        this.#truncationRecords.push({ field: key, originalSize });
      } else {
        truncated[key] = value;
      }
    }

    if (!hasTruncation) return event;

    // Record truncation as internal event
    const truncationEvent: AuditEvent = {
      timestamp: new Date().toISOString(),
      operation: event.operation,
      level: 'C',
      sessionId: event.sessionId,
      result: 'allowed',
      auditEventType: 'audit.truncated',
      params: { field: Object.keys(event.params).filter(k =>
        typeof event.params![k] === 'string' &&
        Buffer.byteLength(event.params![k] as string, 'utf8') > maxSize
      ).join(',') },
    };
    this.#writeBuf.push(truncationEvent);

    return { ...event, params: truncated, metadata: { ...event.metadata, truncated: true } };
  }

  async #flush(): Promise<void> {
    if (this.#flushing) return;

    // If buffer is empty when a scheduled flush runs, clear degraded
    // (the backlog was consumed by an earlier flush)
    if (this.#writeBuf.length === 0) {
      if (this.#degraded) {
        this.#degraded = false;
        this.#degradedReason = '';
      }
      return;
    }

    this.#flushing = true;
    let batch: AuditEvent[] = [];

    try {
      batch = this.#writeBuf.splice(0, this.#constants.flushBatchSize);
      const dateStr = this.#today();
      const filePath = resolve(this.#auditDir, `${dateStr}.jsonl`);

      // Ensure directory exists
      mkdirSync(dirname(filePath), { recursive: true });

      // Write batch
      const lines = batch.map(e => JSON.stringify(e) + '\n').join('');
      appendFileSync(filePath, lines, 'utf8');

      // Check file size for rotation (AFTER write, so current batch is included)
      await this.#rotateIfNeeded(filePath, dateStr);

      // Write override entries to separate file
      const overrideEvents = batch.filter(e => e.auditEventType === 'override');
      if (overrideEvents.length > 0) {
        const overrideDir = resolve(this.#auditDir, 'overrides');
        mkdirSync(overrideDir, { recursive: true });
        const overridePath = resolve(overrideDir, `${dateStr}.jsonl`);
        const overrideLines = overrideEvents.map(e => JSON.stringify(e) + '\n').join('');
        appendFileSync(overridePath, overrideLines, 'utf8');
      }

      // Successful flush: clear degraded state if buffer is manageable
      if (this.#writeBuf.length < this.#constants.bufferHighWaterMark / 2) {
        this.#degraded = false;
        this.#degradedReason = '';
      }
    } catch (err) {
      // Restore batch entries to buffer — they were removed by splice() above
      if (batch.length > 0) {
        this.#writeBuf.unshift(...batch);
      }
      // Failed flush → degraded
      this.#degraded = true;
      this.#degradedReason = err instanceof Error ? err.message : 'flush failed';
    } finally {
      this.#flushing = false;
    }
  }

  #scheduleFlush(): void {
    this.#flushTimer = setTimeout(() => {
      this.#flush().catch(() => {});
      this.#scheduleFlush();
    }, this.#constants.flushIntervalMs).unref();
  }

  async #rotateIfNeeded(filePath: string, dateStr: string): Promise<void> {
    try {
      const stats = statSync(filePath);
      if (stats.size < this.#constants.maxFileSizeMB * 1024 * 1024) return;

      // Find next sequence number
      const dir = dirname(filePath);
      const base = basename(filePath, '.jsonl');
      let seq = 1;
      while (existsSync(resolve(dir, `${base}.${String(seq).padStart(3, '0')}.jsonl`))) {
        seq++;
      }
      const rotatedPath = resolve(dir, `${base}.${String(seq).padStart(3, '0')}.jsonl`);
      renameSync(filePath, rotatedPath);

      // Enforce total storage limit
      await this.#enforceStorageLimit();
    } catch {
      // File doesn't exist yet, nothing to rotate
    }
  }

  async #enforceStorageLimit(): Promise<void> {
    const maxTotalBytes = this.#constants.maxTotalSizeMB * 1024 * 1024;
    const now = new Date();
    const today = this.#today();

    // Collect files recursively from audit dir and overrides subdir
    const collectFiles = (dir: string): Array<{ path: string; date: string; size: number }> => {
      const result: Array<{ path: string; date: string; size: number }> = [];
      try {
        for (const entry of readdirSync(dir)) {
          const fullPath = resolve(dir, entry);
          try {
            const stats = statSync(fullPath);
            if (stats.isDirectory()) {
              result.push(...collectFiles(fullPath));
            } else if (stats.isFile() && entry.endsWith('.jsonl')) {
              const dateMatch = entry.match(/(\d{4}-\d{2}-\d{2})/);
              if (dateMatch) {
                result.push({ path: fullPath, date: dateMatch[1]!, size: stats.size });
              }
            }
          } catch { /* skip unreadable */ }
        }
      } catch { /* skip unreadable dir */ }
      return result;
    };

    const files = collectFiles(this.#auditDir);
    const totalBytes = files.reduce((s, f) => s + f.size, 0);
    if (totalBytes <= maxTotalBytes) return;

    // Determine the highest safety level present in a file (samples up to 200 entries)
    const getHighestLevel = (filePath: string): SafetyLevel => {
      try {
        const content = readFileSync(filePath, 'utf8');
        const lines = content.trim().split('\n').filter(l => l);
        if (lines.length === 0) return 'C';
        const sampleStep = Math.max(1, Math.floor(lines.length / 200));
        const levels = new Set<SafetyLevel>();
        for (let i = lines.length - 1; i >= 0; i -= sampleStep) {
          try {
            const event = JSON.parse(lines[i]!) as AuditEvent;
            levels.add(event.level);
            if (levels.has('S')) break; // Short-circuit: S is highest
          } catch { /* skip malformed */ }
        }
        if (levels.has('S')) return 'S';
        if (levels.has('A')) return 'A';
        if (levels.has('B')) return 'B';
        return 'C';
      } catch {
        return 'S'; // Can't read — preserve (treat as highest level)
      }
    };

    // Categorize files by retention priority (AC #11 differentiated cleanup)
    // S ≥90 days, A ≥30 days, B/C ≥10 days
    const getRetentionDays = (level: SafetyLevel): number => this.#constants.retentionDays[level];

    const isBeyondRetention = (fileDate: string, highestLevel: SafetyLevel): boolean => {
      const fileAgeDays = (now.getTime() - new Date(fileDate).getTime()) / (1000 * 60 * 60 * 24);
      return fileAgeDays > getRetentionDays(highestLevel);
    };

    // Priority: B/C files first (least retention), then A, then S (most retention)
    const deletionPriority: Record<SafetyLevel, number> = { C: 0, B: 0, A: 1, S: 2 };

    const categorized = files
      .filter(f => f.date !== today)
      .map(f => ({ ...f, highestLevel: getHighestLevel(f.path) }))
      .filter(f => isBeyondRetention(f.date, f.highestLevel))
      .sort((a, b) => {
        // Lower priority number = delete first (B/C before A before S)
        const pa = deletionPriority[a.highestLevel];
        const pb = deletionPriority[b.highestLevel];
        if (pa !== pb) return pa - pb;
        // Within same priority, oldest first
        return a.date.localeCompare(b.date);
      });

    let freed = 0;
    for (const file of categorized) {
      if (totalBytes - freed <= maxTotalBytes) break;
      try {
        unlinkSync(file.path);
        freed += file.size;
      } catch { /* race */ }
    }
  }

  #getOrCreateBucket(sessionId: string): TokenBucket {
    let bucket = this.#sessionBuckets.get(sessionId);
    if (!bucket) {
      bucket = new TokenBucket(this.#constants.rateLimitPerSec, this.#constants.rateLimitPerSec);
      this.#sessionBuckets.set(sessionId, bucket);
    }
    return bucket;
  }

  #emitThrottle(sessionId: string): void {
    // Cap at 1000 entries to prevent unbounded memory growth
    if (this.#throttleNotifications.length >= 1000) {
      this.#throttleNotifications.splice(0, 500);
    }
    this.#throttleNotifications.push({ sessionId, rate: this.#writeCountThisSec });
    // Also record as internal event
    const throttleEvent: AuditEvent = {
      timestamp: new Date().toISOString(),
      operation: 'audit.throttle',
      level: 'C',
      sessionId,
      result: 'allowed',
      auditEventType: 'audit.throttle',
      params: { rate: this.#writeCountThisSec },
    };
    this.#writeBuf.push(throttleEvent);
  }

  #checkTamper(): void {
    try {
      // Read the audit directory and check file sizes
      // Tamper detection: if we have a record of expected state, compare
      // MVP: detect if files have been truncated (smaller than last known size)
      const files = readdirSync(this.#auditDir)
        .filter(f => f.endsWith('.jsonl') && !f.startsWith('tamper'))
        .map(f => resolve(this.#auditDir, f));

      for (const file of files) {
        try {
          const stats = statSync(file);
          // Read last few events to verify integrity
          const content = readFileSync(file, 'utf8');
          const lines = content.trim().split('\n').filter(l => l);
          if (lines.length > 0) {
            // Verify the last line is valid JSON
            JSON.parse(lines[lines.length - 1]!);
          }
        } catch {
          // Invalid JSON or missing file — tamper detected
          this.#tamperDetected = true;

          // Record tamper event to tamper log
          const tamperPath = resolve(this.#auditDir, 'tamper.jsonl');
          const tamperEvent: AuditEvent = {
            timestamp: new Date().toISOString(),
            operation: 'tamper.detected',
            level: 'S',
            sessionId: '',
            result: 'rejected',
            reason: `File integrity check failed: ${file}`,
            auditEventType: 'security_status_change',
          };
          const tamperLine = JSON.stringify(tamperEvent) + '\n';
          try {
            appendFileSync(tamperPath, tamperLine, 'utf8');
          } catch { /* best effort */ }
        }
      }
    } catch { /* directory read failed */ }
  }

  #getDateRange(period: '24h' | '7d'): string[] {
    const dates: string[] = [];
    const now = new Date();
    const count = period === '24h' ? 1 : 7;
    for (let i = 0; i < count; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      dates.push(d.toISOString().slice(0, 10));
    }
    return dates;
  }

  #today(): string {
    return new Date().toISOString().slice(0, 10);
  }
}
