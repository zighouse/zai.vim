// =============================================================================
// @zaivim/engine — Semaphore concurrency limiter tests
// Story 2.4, Task 2.6, 2.7, 2.10, 2.11
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Semaphore } from '../../security/semaphore.js';

describe('Semaphore concurrency limiter', () => {
  // Semaphore(4, 1) → 3 normal slots + 1 fast lane slot
  let sem: Semaphore;

  beforeEach(() => {
    vi.useFakeTimers();
    sem = new Semaphore(4);
  });

  afterEach(() => {
    sem.dispose();
    vi.useRealTimers();
  });

  it('should grant immediate access when slots available', async () => {
    const result = await sem.wait(1000);
    expect(result).toBe(true);
    expect(sem.availableSlots).toBe(2); // 3 - 1 = 2 normal slots left
  });

  it('should queue when all slots busy', async () => {
    // Acquire all 3 normal slots
    await sem.wait();
    await sem.wait();
    await sem.wait();

    expect(sem.queueDepth).toBe(0);

    // This should queue (normal lane full)
    const waitPromise = sem.wait(10000);
    expect(sem.queueDepth).toBe(1);

    // Release a slot
    sem.release();

    // Queued request should resolve
    const result = await waitPromise;
    expect(result).toBe(true);
  });

  it('should timeout if no slot available', async () => {
    // Acquire all normal slots
    await sem.wait();
    await sem.wait();
    await sem.wait();

    // Queue with short timeout
    const waitPromise = sem.wait(100);
    vi.advanceTimersByTime(100);
    const result = await waitPromise;
    expect(result).toBe(false);
  });

  it('should track available slots (Task 2.10)', () => {
    expect(sem.availableSlots).toBe(3); // 3 normal slots
  });

  it('should handle release correctly', async () => {
    await sem.wait();
    expect(sem.availableSlots).toBe(2); // 3 - 1
    sem.release();
    expect(sem.availableSlots).toBe(3); // back to 3
  });

  it('should detect session rate limit (Task 2.7)', () => {
    expect(sem.isSessionRateLimited('session-1')).toBe(false);

    sem.recordSessionTimeout('session-1');
    sem.recordSessionTimeout('session-1');
    sem.recordSessionTimeout('session-1');
    sem.recordSessionTimeout('session-1');

    expect(sem.isSessionRateLimited('session-1')).toBe(true);
    expect(sem.isSessionRateLimited('session-2')).toBe(false);
  });

  it('should auto-reset rate limit after 60s (Task 2.7)', () => {
    sem.recordSessionTimeout('session-1');
    sem.recordSessionTimeout('session-1');

    vi.advanceTimersByTime(60_001);

    expect(sem.isSessionRateLimited('session-1')).toBe(false);
  });

  it('should support fast lane (Task 2.11)', async () => {
    const fastSem = new Semaphore(4, 1);

    const result = await fastSem.wait(1000, true);
    expect(result).toBe(true);
    expect(fastSem.fastLaneAvailable).toBe(0);

    fastSem.release();
    expect(fastSem.fastLaneAvailable).toBe(1);
  });
});
