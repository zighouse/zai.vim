// @zaivim/engine — Provider config validation
// Startup-time syntax validation (no network requests) and lazy format validation

import type { ProviderConfig } from './index.js';

export interface ProviderValidationResult {
  valid: boolean;
  reason?: string;
}

const ENV_PATTERN = /^\$([A-Z_][A-Z0-9_]*)$/;

/**
 * Validate provider config syntax (no network requests).
 * Checks: apiKey non-empty and resolved, baseURL valid URL, models array non-empty.
 */
export function validateProviderConfig(config: ProviderConfig): ProviderValidationResult {
  if (!config.apiKey) {
    return { valid: false, reason: 'apiKey is empty' };
  }

  if (ENV_PATTERN.test(config.apiKey)) {
    return { valid: false, reason: `apiKey not resolved (env var ${config.apiKey} not set)` };
  }

  try {
    new URL(config.baseURL);
  } catch {
    return { valid: false, reason: `invalid baseURL format: "${config.baseURL}"` };
  }

  if (!config.models || config.models.length === 0) {
    return { valid: false, reason: 'models array is empty' };
  }

  return { valid: true };
}

/**
 * Validate SSE response format compatibility (lazy validation, first chat call).
 * Checks: choices[0].delta.content exists as string, finish_reason field exists.
 */
export function validateProviderCompatibility(chunk: Record<string, unknown>): ProviderValidationResult {
  const choices = chunk.choices as Record<string, unknown>[] | undefined;
  const choice = choices?.[0] as Record<string, unknown> | undefined;

  if (!choice) {
    return { valid: false, reason: 'response missing choices[0]' };
  }

  const delta = choice.delta as Record<string, unknown> | undefined;
  if (!delta || typeof delta.content !== 'string') {
    return { valid: false, reason: 'response missing delta.content string field' };
  }

  if (!('finish_reason' in choice) && !('finishReason' in chunk)) {
    return { valid: false, reason: 'response missing finish_reason field' };
  }

  return { valid: true };
}
