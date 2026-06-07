import { describe, it, expect, vi } from 'vitest';
import { ZaiNetworkError } from '@zaivim/core';
import {
  retryWithBackoff,
  isRetryableError,
  calculateDelay,
  DEFAULT_RETRY_CONFIG,
} from '../retry.js';
import type { RetryConfig } from '../retry.js';

const FAST_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1,
  maxDelayMs: 4,
  backoffFactor: 2,
};

function makeError(statusCode: number, message: string, detail?: unknown): ZaiNetworkError {
  return new ZaiNetworkError(message, 'ENGINE_PROVIDER_ERROR', statusCode, detail);
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iter) items.push(item);
  return items;
}

// ---- isRetryableError ----

describe('isRetryableError', () => {
  it('should return true for 5xx errors (recoverable)', () => {
    expect(isRetryableError(makeError(500, 'Internal server error'))).toBe(true);
    expect(isRetryableError(makeError(503, 'Service unavailable'))).toBe(true);
    expect(isRetryableError(makeError(504, 'Gateway timeout'))).toBe(true);
  });

  it('should return true for 429 errors (rate limit)', () => {
    expect(isRetryableError(makeError(429, 'Too many requests'))).toBe(true);
  });

  it('should return true for 502 errors (stream interrupted)', () => {
    expect(isRetryableError(makeError(502, 'Bad gateway'))).toBe(true);
  });

  it('should return false for 4xx non-retryable errors', () => {
    expect(isRetryableError(makeError(401, 'Unauthorized'))).toBe(false);
    expect(isRetryableError(makeError(403, 'Forbidden'))).toBe(false);
    expect(isRetryableError(makeError(404, 'Not found'))).toBe(false);
    expect(isRetryableError(makeError(400, 'Bad request'))).toBe(false);
  });

  it('should return false for non-ZaiNetworkError', () => {
    expect(isRetryableError(new Error('generic'))).toBe(false);
    expect(isRetryableError('string error')).toBe(false);
  });
});

// ---- calculateDelay ----

describe('calculateDelay', () => {
  it('should calculate exponential backoff', () => {
    const config: RetryConfig = { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 8000, backoffFactor: 2 };
    // attempt 0: 1000 * 2^0 = 1000 ± 20%
    const d0 = calculateDelay(0, config);
    expect(d0).toBeGreaterThanOrEqual(800);
    expect(d0).toBeLessThanOrEqual(1200);
    // attempt 1: 1000 * 2^1 = 2000 ± 20%
    const d1 = calculateDelay(1, config);
    expect(d1).toBeGreaterThanOrEqual(1600);
    expect(d1).toBeLessThanOrEqual(2400);
    // attempt 2: 1000 * 2^2 = 4000 ± 20%
    const d2 = calculateDelay(2, config);
    expect(d2).toBeGreaterThanOrEqual(3200);
    expect(d2).toBeLessThanOrEqual(4800);
  });

  it('should cap at maxDelayMs', () => {
    const config: RetryConfig = { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 3000, backoffFactor: 2 };
    // attempt 10: 1000 * 2^10 = 1024000, but capped at 3000
    const d = calculateDelay(10, config);
    expect(d).toBeLessThanOrEqual(3600); // 3000 + 20%
  });

  it('should use retryAfterMs for 429 first retry', () => {
    const config: RetryConfig = { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 8000, backoffFactor: 2 };
    const d = calculateDelay(0, config, 2000);
    // Should use 2000 as base instead of 1000
    expect(d).toBeGreaterThanOrEqual(1600);
    expect(d).toBeLessThanOrEqual(2400);
  });

  it('should not use retryAfterMs for subsequent retries', () => {
    const config: RetryConfig = { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 8000, backoffFactor: 2 };
    const d = calculateDelay(1, config, 2000);
    // attempt 1: should use standard backoff (1000 * 2^1 = 2000), not retryAfterMs
    expect(d).toBeGreaterThanOrEqual(1600);
    expect(d).toBeLessThanOrEqual(2400);
  });
});

// ---- retryWithBackoff ----

describe('retryWithBackoff', () => {
  it('should return items on success without retry', async () => {
    const fn = vi.fn(async function* () {
      yield 'a';
      yield 'b';
    });
    const result = await collect(retryWithBackoff(fn, FAST_CONFIG));
    expect(result).toEqual(['a', 'b']);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should retry on recoverable 5xx errors', async () => {
    let call = 0;
    const fn = vi.fn(async function* () {
      call++;
      if (call <= 2) {
        throw makeError(500, 'Server error');
      }
      yield 'success';
    });
    const result = await collect(retryWithBackoff(fn, FAST_CONFIG));
    expect(result).toEqual(['success']);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('should not retry on non-recoverable 4xx errors', async () => {
    const fn = vi.fn(async function* () {
      throw makeError(401, 'Unauthorized');
    });
    await expect(collect(retryWithBackoff(fn, FAST_CONFIG))).rejects.toThrow('Unauthorized');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should throw after max retries exhausted', async () => {
    const fn = vi.fn(async function* () {
      throw makeError(500, 'Server error');
    });
    await expect(collect(retryWithBackoff(fn, FAST_CONFIG))).rejects.toThrow('Server error');
    // Called 1 (initial) + 3 (retries) = 4
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('should not retry when items already yielded (stream interrupted)', async () => {
    const fn = vi.fn(async function* () {
      yield 'partial';
      throw makeError(502, 'ECONNRESET');
    });
    await expect(collect(retryWithBackoff(fn, FAST_CONFIG))).rejects.toThrow('ECONNRESET');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should call onRetry callback on each retry', async () => {
    let call = 0;
    const fn = vi.fn(async function* () {
      call++;
      if (call <= 2) throw makeError(500, 'Server error');
      yield 'ok';
    });
    const onRetry = vi.fn();
    await collect(retryWithBackoff(fn, FAST_CONFIG, undefined, { onRetry }));
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith(1, 3, expect.any(Number));
    expect(onRetry).toHaveBeenCalledWith(2, 3, expect.any(Number));
  });

  it('should cancel retry wait on AbortSignal', async () => {
    const ac = new AbortController();
    const fn = vi.fn(async function* () {
      throw makeError(500, 'Server error');
    });
    // Abort after a short delay
    setTimeout(() => ac.abort(), 5);
    await expect(collect(retryWithBackoff(fn, { maxRetries: 10, baseDelayMs: 10000, maxDelayMs: 60000, backoffFactor: 2 }, ac.signal))).rejects.toThrow();
  });

  it('should retry on 429 rate limit errors', async () => {
    let call = 0;
    const fn = vi.fn(async function* () {
      call++;
      if (call === 1) throw makeError(429, 'Rate limited', { retryAfterMs: 2 });
      yield 'ok';
    });
    const result = await collect(retryWithBackoff(fn, FAST_CONFIG));
    expect(result).toEqual(['ok']);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('should propagate AbortError immediately', async () => {
    const fn = vi.fn(async function* () {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    });
    await expect(collect(retryWithBackoff(fn, FAST_CONFIG))).rejects.toThrow('aborted');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
