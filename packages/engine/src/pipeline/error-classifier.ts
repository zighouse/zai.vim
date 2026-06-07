// @zaivim/engine — Provider error classifier
// Maps HTTP status codes and error types to recoverable/non-recoverable categories.

import { ZaiNetworkError } from '@zaivim/core';
import type { ErrorCode } from '@zaivim/core';

export interface ClassifiedError {
  readonly recoverable: boolean;
  readonly code: ErrorCode;
  readonly message: string;
  readonly retryAfterMs?: number;
}

export function classifyProviderError(err: ZaiNetworkError): ClassifiedError {
  const status = err.statusCode;
  const msg = err.message;

  // Auth / billing / not-found: non-recoverable
  if (status === 401 || status === 403) {
    return { recoverable: false, code: 'ENGINE_PROVIDER_AUTH_FAILED', message: `Authentication failed: ${msg}` };
  }
  if (status === 402) {
    return { recoverable: false, code: 'ENGINE_PROVIDER_ERROR', message: `Billing issue: ${msg}` };
  }
  if (status === 404) {
    return { recoverable: false, code: 'ENGINE_PROVIDER_MODEL_NOT_FOUND', message: `Model not found: ${msg}` };
  }
  if (status === 400) {
    // Check for context_length_exceeded
    if (msg.includes('context_length_exceeded') || msg.includes('maximum context length')) {
      return { recoverable: true, code: 'PIPELINE_CONTEXT_LENGTH_EXCEEDED', message: msg };
    }
    return { recoverable: false, code: 'ENGINE_PROVIDER_ERROR', message: `Bad request: ${msg}` };
  }

  // Rate limit: recoverable, extract Retry-After header
  if (status === 429) {
    const retryAfterMs = extractRetryAfterMs(err);
    return {
      recoverable: true,
      code: 'ENGINE_PROVIDER_RATE_LIMITED',
      message: `Rate limited: ${msg}`,
      retryAfterMs,
    };
  }

  // 502 / network-level: stream interrupted — check BEFORE generic 5xx (fixes 502 misclassification)
  if (status === 502 || msg.includes('ECONNRESET') || msg.includes('ETIMEDOUT') || msg.includes('fetch failed')) {
    return { recoverable: true, code: 'PIPELINE_PROVIDER_STREAM_INTERRUPTED', message: msg };
  }

  // Generic 5xx server errors: recoverable
  if (status >= 500) {
    if (status === 504) {
      return { recoverable: true, code: 'ENGINE_PROVIDER_ERROR', message: `Provider timeout: ${msg}` };
    }
    return { recoverable: true, code: 'ENGINE_PROVIDER_ERROR', message: `Server error (${status}): ${msg}` };
  }

  // Default: non-recoverable
  return { recoverable: false, code: 'ENGINE_PROVIDER_ERROR', message: msg };
}

/** Extract Retry-After value from ZaiNetworkError detail (set by provider on 429 responses) */
function extractRetryAfterMs(err: ZaiNetworkError): number | undefined {
  const detail = err.detail as Record<string, unknown> | undefined;
  if (detail && typeof detail.retryAfterMs === 'number') {
    return detail.retryAfterMs;
  }
  return undefined;
}
