// @zaivim/engine — Audit Logger
// JSONL audit logging with sensitive data redaction and log rotation

import { createWriteStream, type WriteStream } from 'node:fs';
import { readFile, readdir, stat, unlink, rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { HarmLevel } from '@zaivim/core';

/**
 * Audit log entry structure
 */
export interface AuditEntry {
  /** ISO 8601 timestamp */
  readonly timestamp: string;
  /** Session identifier */
  readonly sessionId: string;
  /** Operation being performed (e.g., 'shell_exec', 'file_write') */
  readonly operation: string;
  /** Classified harm level */
  readonly harmLevel: HarmLevel;
  /** Security decision made */
  readonly decision: 'allowed' | 'denied';
  /** Reason for decision */
  readonly reason: string;
  /** User acknowledgment (for overrides) */
  readonly userAcknowledged?: boolean;
  /** Additional metadata (operation-specific) */
  readonly metadata?: Record<string, unknown>;
  /** User who performed the operation */
  readonly user: string;
  /** Audit event type for categorization (e.g., 'override', 'security_status_change') */
  readonly auditEventType?: string;
}

/**
 * Audit log statistics
 */
export interface AuditStatistics {
  /** Total number of entries */
  readonly totalEntries: number;
  /** Number of allowed operations */
  readonly allowedCount: number;
  /** Number of denied operations */
  readonly deniedCount: number;
  /** Distribution by harm level */
  readonly harmLevelDistribution: Record<string, number>;
  /** Number of override entries (Subtask 2.4.3) */
  readonly overrides: number;
}

/**
 * Filter options for audit query (Subtask 2.4.2)
 */
export interface AuditQueryFilter {
  sessionId?: string;
  startTime?: string;
  endTime?: string;
  /** Filter by auditEventType (e.g., 'override'). Default excludes overrides. */
  auditEventType?: string;
  /** Set true to include override entries in results (default: false) */
  includeOverrides?: boolean;
}

/**
 * Audit logger configuration
 */
export interface AuditLoggerConfig {
  /** Maximum log size before rotation (bytes) */
  readonly maxSize?: number;
  /** Maximum log age before rotation (days) */
  readonly maxAge?: number;
  /** Number of rotated logs to keep */
  readonly maxFiles?: number;
  /** Write buffer size (bytes) */
  readonly bufferSize?: number;
  /** Maximum write rate (entries/sec, 0 = unlimited) */
  readonly maxRatePerSec?: number;
}

/**
 * Audit logger for security operations
 *
 * Writes audit entries to append-only JSONL file with:
 * - Sensitive data redaction (API keys, tokens, passwords)
 * - Async non-blocking writes (≤5ms)
 * - Log rotation (size-based and time-based)
 * - Query functionality
 */
export class AuditLogger {
  private logPath: string;
  private config: Required<AuditLoggerConfig>;
  private writeStream: WriteStream | null = null;
  private writeBuffer: string[] = [];
  private currentSize: number = 0;
  private pendingWrites: number = 0;
  private flushResolvers: Array<() => void> = [];
  private writeScheduled: boolean = false;

  /** Rate limiter state — token bucket */
  private rateTokens: number = 0;
  private rateLastRefill: number = 0;

  /** Default configuration */
  private static readonly DEFAULT_CONFIG: Required<AuditLoggerConfig> = {
    maxSize: 100 * 1024 * 1024, // 100MB
    maxAge: 30, // 30 days
    maxFiles: 10,
    bufferSize: 64 * 1024, // 64KB buffer
    maxRatePerSec: 100, // 100 entries/sec
  };

  /** Public accessor for log file path */
  get logFilePath(): string {
    return this.logPath;
  }

  constructor(logPath: string, config: Partial<AuditLoggerConfig> = {}) {
    this.logPath = resolve(logPath);
    this.config = { ...AuditLogger.DEFAULT_CONFIG, ...config };
    // Initialize immediately in constructor
    this.initialize().catch(error => {
      console.error('Failed to initialize audit logger:', error);
    });
  }

  /**
   * Initialize the audit logger
   *
   * Creates log directory and initializes write stream.
   */
  private async initialize(): Promise<void> {
    if (this.writeStream) {
      return; // Already initialized
    }

    try {
      // Create log directory if it doesn't exist
      const logDir = dirname(this.logPath);
      await mkdir(logDir, { recursive: true });

      // Get current log file size
      try {
        const stats = await stat(this.logPath);
        this.currentSize = stats.size;
      } catch {
        // File doesn't exist yet
        this.currentSize = 0;
      }

      // Create append-only write stream
      this.writeStream = createWriteStream(this.logPath, {
        flags: 'a', // Append mode
        encoding: 'utf8',
      });

      this.writeStream.on('error', (error) => {
        console.error('Audit log write error:', error);
      });
    } catch (error) {
      console.error('Failed to initialize audit logger:', error);
      // Continue without logging (graceful degradation)
    }
  }

  /**
   * Log an audit entry
   *
   * @param entry - Audit entry to log
   * @returns Promise that resolves when entry is buffered
   */
  async log(entry: AuditEntry): Promise<void> {
    // Redact sensitive data
    const redactedEntry = this.redactSensitiveData(entry);

    // Serialize to JSON
    const jsonLine = JSON.stringify(redactedEntry) + '\n';

    // Add to buffer
    this.writeBuffer.push(jsonLine);

    // Trigger async write (non-blocking)
    this.scheduleWrite();
  }

  /**
   * Schedule an async write operation
   */
  private scheduleWrite(): void {
    if (this.writeScheduled || this.writeBuffer.length === 0) {
      return; // Already scheduled or nothing to write
    }

    this.writeScheduled = true;

    // Schedule write for next tick
    process.nextTick(async () => {
      try {
        await this.flushBuffer();
      } catch (error) {
        console.error('Failed to flush buffer:', error);
      } finally {
        this.writeScheduled = false;
        // If entries accumulated during flush, schedule another pass (L1)
        if (this.writeBuffer.length > 0) {
          this.scheduleWrite();
        }
      }
    });
  }

  /**
   * Consume rate-limited tokens for writing entries
   *
   * Uses a token bucket refilled at maxRatePerSec tokens/second.
   * Returns how many of the requested entries are allowed this call.
   */
  private consumeRateTokens(requested: number): number {
    if (this.config.maxRatePerSec <= 0) {
      return requested; // Unlimited
    }

    const now = Date.now();
    const elapsed = (now - this.rateLastRefill) / 1000;

    // Refill tokens (cap at maxRatePerSec)
    this.rateTokens = Math.min(this.config.maxRatePerSec, this.rateTokens + elapsed * this.config.maxRatePerSec);
    this.rateLastRefill = now;

    if (this.rateTokens < 1) {
      return 0;
    }

    const allowed = Math.min(requested, Math.floor(this.rateTokens));
    this.rateTokens -= allowed;
    return allowed;
  }

  /**
   * Redact sensitive data from audit entry
   *
   * @param entry - Entry to redact
   * @returns Redacted entry
   */
  private redactSensitiveData(entry: AuditEntry): AuditEntry {
    // Create a deep copy to avoid mutating the original
    const redacted = { ...entry };

    // Redact metadata fields if present
    if (redacted.metadata) {
      redacted.metadata = this.redactObject(redacted.metadata);
    }

    return redacted;
  }

  /**
   * Recursively redact sensitive data in an object
   *
   * @param obj - Object to redact
   * @returns Redacted object
   */
  private redactObject(obj: Record<string, unknown>): Record<string, unknown> {
    const redacted: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'string') {
        redacted[key] = this.redactString(key, value);
      } else if (typeof value === 'object' && value !== null) {
        redacted[key] = this.redactObject(value as Record<string, unknown>);
      } else {
        redacted[key] = value;
      }
    }

    return redacted;
  }

  /**
   * Redact sensitive string values based on key name and content
   *
   * @param key - Field key name
   * @param value - Field value
   * @returns Redacted value
   */
  private redactString(key: string, value: string): string {
    const lowerKey = key.toLowerCase();
    const lowerValue = value.toLowerCase();

    // Check if key suggests sensitive data
    const sensitiveKeys = ['password', 'passwd', 'pwd', 'secret', 'apikey', 'api_key', 'api-key',
                          'private_key', 'private-key', 'token', 'authorization', 'auth'];

    if (sensitiveKeys.some(sk => lowerKey.includes(sk))) {
      return '[REDACTED]';
    }

    // Check if value contains sensitive patterns
    if (lowerValue.startsWith('bearer ') || lowerValue.startsWith('sk-')) {
      return '[REDACTED]';
    }

    // Check for JWT-like strings
    if (lowerValue.match(/^eyJ[a-zA-Z0-9\-_.=]{20,}/)) {
      return '[REDACTED]';
    }

    return value;
  }

  /**
   * Flush buffer to disk
   *
   * Writes buffered entries to disk.
   */
  private async flushBuffer(): Promise<void> {
    if (this.writeBuffer.length === 0 || this.pendingWrites > 0) {
      return; // Don't start new write if one is pending
    }

    // Wait for initialization
    if (!this.writeStream) {
      await this.initialize();
    }

    // Rate limit: split entries into a rate-limited chunk
    const entriesToWrite = this.writeBuffer.splice(0, this.writeBuffer.length);
    const rateAllowed = this.consumeRateTokens(entriesToWrite.length);
    const allowedEntries = entriesToWrite.slice(0, rateAllowed);
    const deferredEntries = entriesToWrite.slice(rateAllowed);

    // Put deferred entries back for next flush
    if (deferredEntries.length > 0) {
      this.writeBuffer.unshift(...deferredEntries);
    }

    if (allowedEntries.length === 0) {
      return; // All entries rate-limited, retry next tick
    }

    const chunk = allowedEntries.join('');

    if (this.writeStream && !this.writeStream.destroyed) {
      this.pendingWrites++;

      return new Promise<void>((resolve) => {
        this.writeStream!.write(chunk, (error) => {
          this.pendingWrites--;

          if (error) {
            console.error('Failed to write audit log:', error);
          } else {
            this.currentSize += chunk.length;
          }

          // Notify flush waiters if no more pending writes
          if (this.pendingWrites === 0) {
            this.flushResolvers.forEach(r => r());
            this.flushResolvers = [];
          }

          resolve();
        });
      });
    }
  }

  /**
   * Flush all buffered entries to disk
   *
   * Call this before application shutdown to ensure all entries are written.
   */
  async flush(): Promise<void> {
    // First, write any remaining buffer
    await this.flushBuffer();

    // Then wait for all pending writes to complete
    if (this.pendingWrites > 0) {
      await new Promise<void>(resolve => {
        this.flushResolvers.push(resolve);
      });
    }
  }

  /**
   * Rotate log file if needed
   *
   * Creates new log file and moves old file to rotated archive.
   */
  async rotateIfNeeded(): Promise<void> {
    await this.flush();

    if (this.currentSize < this.config.maxSize) {
      return; // No rotation needed
    }

    try {
      // Close current write stream
      if (this.writeStream) {
        this.writeStream.end();
        this.writeStream = null;
      }

      // Generate rotated filename with timestamp
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const rotatedPath = `${this.logPath}.${timestamp}`;

      // Rename current log file
      await rename(this.logPath, rotatedPath);

      // Clean up old rotated files
      await this.cleanOldRotatedFiles();

      // Reset current size
      this.currentSize = 0;

      // Reinitialize with new log file
      await this.initialize();
    } catch (error) {
      console.error('Failed to rotate audit log:', error);
    }
  }

  /**
   * Clean up old rotated log files
   */
  private async cleanOldRotatedFiles(): Promise<void> {
    try {
      const logDir = dirname(this.logPath);
      const files = await readdir(logDir);

      // Find rotated log files
      const rotatedFiles = files
        .filter((f) => f.startsWith(this.logPath.split('/').pop()!))
        .filter((f) => f.includes('.20')) // Contains timestamp
        .map((f) => resolve(logDir, f))
        .sort((a, b) => b.localeCompare(a)); // Newest first

      // Keep only maxFiles
      const filesToDelete = rotatedFiles.slice(this.config.maxFiles);
      for (const file of filesToDelete) {
        await unlink(file);
      }
    } catch (error) {
      console.error('Failed to clean old rotated files:', error);
    }
  }

  /**
   * List all rotated log files
   *
   * @returns Array of rotated log file paths
   */
  async listRotatedFiles(): Promise<string[]> {
    try {
      const logDir = dirname(this.logPath);
      const files = await readdir(logDir);

      return files
        .filter((f) => f.startsWith(this.logPath.split('/').pop()!))
        .filter((f) => f.includes('.20')) // Contains timestamp
        .map((f) => resolve(logDir, f))
        .sort((a, b) => b.localeCompare(a)); // Newest first
    } catch {
      return [];
    }
  }

  /**
   * Read all entries from log file
   *
   * @returns Log file content as string
   */
  async readAll(): Promise<string> {
    try {
      return await readFile(this.logPath, 'utf8');
    } catch {
      return '';
    }
  }

  /**
   * Query entries by session ID
   *
   * @param sessionId - Session ID to query
   * @returns Array of matching entries
   */
  async queryBySession(sessionId: string): Promise<AuditEntry[]> {
    const content = await this.readAll();
    const lines = content.trim().split('\n').filter((l) => l);

    const entries: AuditEntry[] = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as AuditEntry;
        if (entry.sessionId === sessionId) {
          entries.push(entry);
        }
      } catch {
        // Skip invalid lines
      }
    }

    return entries;
  }

  /**
   * Query entries by time range
   *
   * @param start - Start time (ISO 8601)
   * @param end - End time (ISO 8601)
   * @returns Array of matching entries
   */
  async queryByTimeRange(start: string, end: string): Promise<AuditEntry[]> {
    const content = await this.readAll();
    const lines = content.trim().split('\n').filter((l) => l);

    const entries: AuditEntry[] = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as AuditEntry;
        if (entry.timestamp >= start && entry.timestamp <= end) {
          entries.push(entry);
        }
      } catch {
        // Skip invalid lines
      }
    }

    return entries;
  }

  /**
   * Generic query with filters (Subtask 2.4.2)
   *
   * @param filter - Optional filter criteria
   * @returns Array of matching entries
   */
  async query(filter?: AuditQueryFilter): Promise<AuditEntry[]> {
    const content = await this.readAll();
    const lines = content.trim().split('\n').filter((l) => l);

    const entries: AuditEntry[] = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as AuditEntry;

        // Default: exclude override entries unless explicitly asked
        if (!filter?.includeOverrides && entry.operation === 'override') {
          continue;
        }

        // Filter by auditEventType
        if (filter?.auditEventType && entry.auditEventType !== filter.auditEventType) {
          continue;
        }

        // Filter by sessionId
        if (filter?.sessionId && entry.sessionId !== filter.sessionId) {
          continue;
        }

        // Filter by time range
        if (filter?.startTime && entry.timestamp < filter.startTime) {
          continue;
        }
        if (filter?.endTime && entry.timestamp > filter.endTime) {
          continue;
        }

        entries.push(entry);
      } catch {
        // Skip invalid lines
      }
    }

    return entries;
  }

  /**
   * Get audit log statistics
   *
   * @returns Statistics about the audit log
   */
  async getStatistics(): Promise<AuditStatistics> {
    const content = await this.readAll();
    const lines = content.trim().split('\n').filter((l) => l);

    let allowedCount = 0;
    let deniedCount = 0;
    let overrides = 0;
    const harmLevelDistribution: Record<string, number> = {};

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as AuditEntry;

        if (entry.decision === 'allowed') {
          allowedCount++;
        } else if (entry.decision === 'denied') {
          deniedCount++;
        }

        harmLevelDistribution[entry.harmLevel] =
          (harmLevelDistribution[entry.harmLevel] || 0) + 1;

        if (entry.operation === 'override') {
          overrides++;
        }
      } catch {
        // Skip invalid lines
      }
    }

    return {
      totalEntries: lines.length,
      allowedCount,
      deniedCount,
      harmLevelDistribution,
      overrides,
    };
  }

  /**
   * Close the audit logger
   *
   * Flushes remaining buffer and closes write stream.
   */
  async close(): Promise<void> {
    await this.flush();

    if (this.writeStream) {
      return new Promise<void>((resolve) => {
        this.writeStream!.once('finish', () => resolve());
        this.writeStream!.end();
      });
    }
  }
}
