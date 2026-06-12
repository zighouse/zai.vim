// =============================================================================
// @zaivim/engine — Performance tests and constraint verification (Task 7a)
// Story 2.4: Verifies semaphore concurrency limits, health check recovery,
// fast lane isolation, and anti-starvation rate-limit constraints.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Semaphore } from '../../security/semaphore.js';

// ─── Semaphore concurrency constraint tests ──────────────────────────────

describe('Semaphore concurrency constraint (Task 7a)', () => {
  let sem: Semaphore;

  beforeEach(() => {
    sem = new Semaphore(4, 1); // 3 normal + 1 fast lane
  });

  afterEach(() => {
    sem.dispose();
  });

  it('should allow exactly maxSlots concurrent normal acquisitions', async () => {
    const a1 = await sem.wait(1000);
    const a2 = await sem.wait(1000);
    const a3 = await sem.wait(1000);

    expect(a1).toBe(true);
    expect(a2).toBe(true);
    expect(a3).toBe(true);
    expect(sem.availableSlots).toBe(0);

    // 4th normal request should queue
    const waitPromise = sem.wait(100);
    await vi.waitFor(() => expect(sem.queueDepth).toBe(1), { timeout: 50 });
    expect(sem.availableSlots).toBe(0);

    sem.release();
    sem.release();
    sem.release();
    const a4 = await waitPromise;
    expect(a4).toBe(true);
  });

  it('should allow fast lane acquisition even when normal slots are full', async () => {
    await sem.wait();
    await sem.wait();
    await sem.wait();
    expect(sem.availableSlots).toBe(0);

    const fastResult = await sem.wait(1000, true);
    expect(fastResult).toBe(true);
    expect(sem.fastLaneAvailable).toBe(0);

    sem.release();
    expect(sem.fastLaneAvailable).toBe(1);
  });

  it('should queue and eventually resolve when slots become available', async () => {
    await sem.wait();
    await sem.wait();
    await sem.wait();

    const p1 = sem.wait(5000);
    const p2 = sem.wait(5000);
    expect(sem.queueDepth).toBe(2);

    sem.release();
    sem.release();

    const r1 = await p1;
    const r2 = await p2;
    expect(r1).toBe(true);
    expect(r2).toBe(true);
    expect(sem.queueDepth).toBe(0);
  });

  it('should respect queue timeout', async () => {
    await sem.wait();
    await sem.wait();
    await sem.wait();

    const result = await sem.wait(50);
    expect(result).toBe(false);
  });
});

// ─── Semaphore health check tests ────────────────────────────────────────

describe('Semaphore health check (Task 7a)', () => {
  let sem: Semaphore;

  beforeEach(() => {
    vi.useFakeTimers();
    sem = new Semaphore(4, 1);
  });

  afterEach(() => {
    sem.dispose();
    vi.useRealTimers();
  });

  it('should force-release slots held >30s after 60s health check tick', async () => {
    await sem.wait();
    await sem.wait();
    await sem.wait();
    expect(sem.availableSlots).toBe(0);

    vi.advanceTimersByTime(60_001);
    expect(sem.availableSlots).toBe(3);
  });

  it('should not reclaim recently acquired slots (held <30s)', async () => {
    vi.advanceTimersByTime(50_000);
    await sem.wait();
    expect(sem.availableSlots).toBe(2);

    vi.advanceTimersByTime(10_001);
    // Slot acquired at t=50s, health check at t=60s → held for 10s < 30s
    expect(sem.availableSlots).toBe(2);

    sem.release();
  });
});

// ─── Anti-starvation rate-limit constraint tests ─────────────────────────

describe('Semaphore anti-starvation rate-limit (Task 7a)', () => {
  let sem: Semaphore;

  beforeEach(() => {
    vi.useFakeTimers();
    sem = new Semaphore(4);
  });

  afterEach(() => {
    sem.dispose();
    vi.useRealTimers();
  });

  it('should rate-limit session after 4 timeouts within observation window', () => {
    const sessionId = 'test-session';
    expect(sem.isSessionRateLimited(sessionId)).toBe(false);

    sem.recordSessionTimeout(sessionId);
    sem.recordSessionTimeout(sessionId);
    sem.recordSessionTimeout(sessionId);
    sem.recordSessionTimeout(sessionId);

    expect(sem.isSessionRateLimited(sessionId)).toBe(true);
  });

  it('should reset rate-limit after 60s when new timeout is recorded', () => {
    const sessionId = 'test-session';

    for (let i = 0; i < 4; i++) sem.recordSessionTimeout(sessionId);
    expect(sem.isSessionRateLimited(sessionId)).toBe(true);

    vi.advanceTimersByTime(60_001);
    sem.recordSessionTimeout(sessionId);

    expect(sem.isSessionRateLimited(sessionId)).toBe(false);
  });

  it('should not rate-limit different sessions independently', () => {
    for (let i = 0; i < 4; i++) sem.recordSessionTimeout('session-A');

    expect(sem.isSessionRateLimited('session-A')).toBe(true);
    expect(sem.isSessionRateLimited('session-B')).toBe(false);
  });
});
