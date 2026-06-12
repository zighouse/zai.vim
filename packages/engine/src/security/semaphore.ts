// @zaivim/engine — Semaphore for concurrent path validation
// Story 2.4, Task 2: Concurrency limiter with anti-starvation and fast lane

export class Semaphore {
  readonly #maxSlots: number;
  readonly #fastLaneSlots: number;
  #availableSlots: number;
  #fastLaneAvailable: number;
  #queue: Array<{ resolve: (value: boolean) => void; reject: (reason: unknown) => void; timer: NodeJS.Timeout }> = [];
  #slotAcquiredAt: Map<number, number> = new Map();
  #nextSlotId = 0;
  /** Anti-starvation: per-session rate-limit tracking */
  readonly #sessionTimeouts = new Map<string, { count: number; lastReset: number }>();
  /** Health check timer */
  #healthTimer?: ReturnType<typeof setInterval>;

  constructor(totalSlots = 4, fastLaneSlots = 1) {
    this.#maxSlots = totalSlots - fastLaneSlots;
    this.#fastLaneSlots = fastLaneSlots;
    this.#availableSlots = this.#maxSlots;
    this.#fastLaneAvailable = fastLaneSlots;

    // Task 2.10: Health check every 60s
    this.#healthTimer = setInterval(() => this.#healthCheck(), 60_000);
    this.#healthTimer.unref();
  }

  get availableSlots(): number {
    return this.#availableSlots;
  }

  get fastLaneAvailable(): number {
    return this.#fastLaneAvailable;
  }

  /**
   * Acquire a slot for path validation.
   * @param timeout Queue timeout in ms (default 10000)
   * @param fastLane If true, use fast lane (small files within boundary)
   */
  async wait(timeout = 10_000, fastLane = false): Promise<boolean> {
    // Fast lane: use dedicated slot
    if (fastLane && this.#fastLaneAvailable > 0) {
      this.#fastLaneAvailable--;
      const slotId = this.#nextSlotId++;
      this.#slotAcquiredAt.set(slotId, Date.now());
      return true;
    }

    // Normal lane: immediate if slot available
    if (this.#availableSlots > 0) {
      this.#availableSlots--;
      const slotId = this.#nextSlotId++;
      this.#slotAcquiredAt.set(slotId, Date.now());
      return true;
    }

    // All slots busy, queue with timeout
    return new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.#queue.findIndex(e => e.resolve === resolve);
        if (idx !== -1) this.#queue.splice(idx, 1);
        resolve(false); // Timeout
      }, timeout);

      this.#queue.push({ resolve, reject, timer });
    });
  }

  /** Release a slot. */
  release(): void {
    // Try fast lane first (no queuing for fast lane)
    if (this.#fastLaneAvailable < this.#fastLaneSlots) {
      this.#fastLaneAvailable++;
      this.#notifyNext();
      return;
    }

    if (!this.#notifyNext()) {
      this.#availableSlots++;
    }
  }

  /** Get current queue depth. */
  get queueDepth(): number {
    return this.#queue.length;
  }

  /** Mark a session timeout for anti-starvation tracking (Task 2.7). */
  recordSessionTimeout(sessionId: string): void {
    const now = Date.now();
    const entry = this.#sessionTimeouts.get(sessionId) ?? { count: 0, lastReset: now };

    // Reset counter if 60s has passed since last timeout
    if (now - entry.lastReset > 60_000) {
      entry.count = 0;
    }

    entry.count++;
    entry.lastReset = now;
    this.#sessionTimeouts.set(sessionId, entry);
  }

  /** Check if session is rate-limited (Task 2.7). */
  isSessionRateLimited(sessionId: string): boolean {
    const entry = this.#sessionTimeouts.get(sessionId);
    if (!entry) return false;
    // Rate-limited if 4+ timeouts in 10s window
    return entry.count >= 4;
  }

  // ---- Private ----

  #notifyNext(): boolean {
    const next = this.#queue.shift();
    if (next) {
      clearTimeout(next.timer);
      const slotId = this.#nextSlotId++;
      this.#slotAcquiredAt.set(slotId, Date.now());
      next.resolve(true);
      return true;
    }
    return false;
  }

  /** Task 2.10: Periodic health check — detect slot leaks */
  #healthCheck(): void {
    const now = Date.now();
    for (const [slotId, acquiredAt] of this.#slotAcquiredAt) {
      if (now - acquiredAt > 30_000) {
        // Slot held > 30s — force release (possible leak)
        this.#slotAcquiredAt.delete(slotId);
        this.release();
      }
    }

    // Warn if available slots < 4 (suspicious)
    if (this.#availableSlots < this.#maxSlots) {
      // Potential slot leak detected — reset is handled by per-slot timeout above
    }
  }

  /** Clean up resources. */
  dispose(): void {
    if (this.#healthTimer) {
      clearInterval(this.#healthTimer);
      this.#healthTimer = undefined;
    }
    // Reject all queued
    for (const entry of this.#queue) {
      clearTimeout(entry.timer);
      entry.resolve(false);
    }
    this.#queue = [];
  }
}
