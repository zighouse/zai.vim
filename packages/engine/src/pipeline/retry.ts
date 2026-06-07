// @zaivim/engine — Retry with exponential backoff
// Wraps provider.chat() calls with configurable retry logic.

import { ZaiNetworkError } from '@zaivim/core';
import { classifyProviderError } from './error-classifier.js';
import type { ClassifiedError } from './error-classifier.js';

// ---- Retry Configuration ---------------------------------------------------

export interface RetryConfig {
  readonly maxRetries: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly backoffFactor: number;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 8000,
  backoffFactor: 2,
};

// ---- Retry Logic -----------------------------------------------------------

export interface RetryCallbacks {
  onRetry?: (attempt: number, maxAttempts: number, delayMs: number) => void;
}

/**
 * Determine if an error is retryable based on provider error classification.
 */
export function isRetryableError(err: unknown): boolean {
  if (!(err instanceof ZaiNetworkError)) return false;
  const classified = classifyProviderError(err);
  return classified.recoverable;
}

/**
 * Classify a provider error, returning the full ClassifiedError.
 */
export function classifyRetryError(err: unknown): ClassifiedError | null {
  if (!(err instanceof ZaiNetworkError)) return null;
  return classifyProviderError(err);
}

/**
 * Calculate exponential backoff delay with ±20% jitter.
 * For 429 errors, uses retryAfterMs as the base delay when available.
 */
export function calculateDelay(
  attempt: number,
  config: RetryConfig,
  retryAfterMs?: number,
): number {
  let base: number;
  if (attempt === 0 && retryAfterMs !== undefined) {
    // 429 first retry: use server-provided delay
    base = retryAfterMs;
  } else {
    base = config.baseDelayMs * Math.pow(config.backoffFactor, attempt);
  }
  const capped = Math.min(base, config.maxDelayMs);

  // ±20% jitter to avoid thundering herd
  const jitter = capped * 0.2;
  return capped + (Math.random() * 2 - 1) * jitter;
}

/**
 * Sleep for ms, abortable via AbortSignal.
 * Resolves normally if signal fires during sleep (caller checks signal state).
 */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }

    const timer = setTimeout(resolve, ms);

    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Retry an async iterable-producing function with exponential backoff.
 *
 * - Retries only on recoverable ZaiNetworkError (5xx, 429, network errors)
 * - Non-recoverable errors (4xx except 429) are thrown immediately
 * - Stream interruptions (error after yielding items) are NOT retried (AC9)
 * - Respects AbortSignal: waiting retries are cancelled on abort
 * - 429 errors use Retry-After header value as first delay when available
 *
 * @param fn - Function that produces an AsyncIterable (typically provider.chat())
 * @param config - Retry configuration
 * @param signal - Optional AbortSignal for cancellation
 * @param callbacks - Optional callbacks for retry events
 */
export async function* retryWithBackoff<T>(
  fn: () => AsyncIterable<T>,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
  signal?: AbortSignal,
  callbacks?: RetryCallbacks,
): AsyncIterable<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    signal?.throwIfAborted();

    let itemsYielded = false;

    try {
      // Attempt the operation
      for await (const item of fn()) {
        yield item;
        itemsYielded = true;
      }
      return; // Success — exit
    } catch (err) {
      lastError = err;

      // Abort: propagate immediately, session state preserved
      if (err instanceof Error && (err.name === 'AbortError' || err.message.includes('aborted'))) {
        throw err;
      }

      // Stream interrupted (items already yielded): do NOT retry (AC9)
      if (itemsYielded) {
        throw err;
      }

      // Non-retryable: throw immediately
      if (!isRetryableError(err)) {
        throw err;
      }

      // Max retries reached: throw the last error
      if (attempt >= config.maxRetries) {
        throw err;
      }

      // Calculate delay — use retryAfterMs for 429 on first retry
      const classified = classifyRetryError(err);
      const delay = calculateDelay(attempt, config, classified?.retryAfterMs);

      // Notify callback
      callbacks?.onRetry?.(attempt + 1, config.maxRetries, Math.round(delay));

      // Wait with abort support
      await abortableSleep(delay, signal);
    }
  }

  // Should not reach here, but just in case
  throw lastError;
}
