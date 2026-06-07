// @zaivim/engine — Provider error classifier
// Maps HTTP status codes and error types to recoverable/non-recoverable categories.

import { ZaiNetworkError } from '@zaivim/core';
import type { ErrorCode } from '@zaivim/core';

export interface ClassifiedError {
  readonly recoverable: boolean;
  readonly code: ErrorCode;
  readonly message: string;
}

export function classifyProviderError(err: ZaiNetworkError): ClassifiedError {
  const status = err.statusCode;
  const msg = err.message;

  // Auth / billing / not-found: non-recoverable
  if (status === 401 || status === 403) {
    return { recoverable: false, code: 'ENGINE_PROVIDER_ERROR', message: `Authentication failed: ${msg}` };
  }
  if (status === 402) {
    return { recoverable: false, code: 'ENGINE_PROVIDER_ERROR', message: `Billing issue: ${msg}` };
  }
  if (status === 404) {
    return { recoverable: false, code: 'ENGINE_PROVIDER_ERROR', message: `Model not found: ${msg}` };
  }
  if (status === 400) {
    // Check for context_length_exceeded
    if (msg.includes('context_length_exceeded') || msg.includes('maximum context length')) {
      return { recoverable: true, code: 'PIPELINE_CONTEXT_LENGTH_EXCEEDED', message: msg };
    }
    return { recoverable: false, code: 'ENGINE_PROVIDER_ERROR', message: `Bad request: ${msg}` };
  }

  // Rate limit / server errors: recoverable
  if (status === 429) {
    return { recoverable: true, code: 'ENGINE_PROVIDER_ERROR', message: `Rate limited: ${msg}` };
  }
  if (status >= 500) {
    if (status === 504) {
      return { recoverable: true, code: 'ENGINE_PROVIDER_ERROR', message: `Provider timeout: ${msg}` };
    }
    return { recoverable: true, code: 'ENGINE_PROVIDER_ERROR', message: `Server error (${status}): ${msg}` };
  }

  // Network-level errors (no status): recoverable (connection reset, DNS, etc.)
  if (status === 502 || msg.includes('ECONNRESET') || msg.includes('ETIMEDOUT') || msg.includes('fetch failed')) {
    return { recoverable: true, code: 'PIPELINE_PROVIDER_STREAM_INTERRUPTED', message: msg };
  }

  // Default: non-recoverable
  return { recoverable: false, code: 'ENGINE_PROVIDER_ERROR', message: msg };
}
