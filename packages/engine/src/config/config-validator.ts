// @zaivim/engine — Config validation
// Field-level validation with ZaiConfigError (field + line info)

import { ZaiConfigError } from '@zaivim/core';

interface ValidationContext {
  field: string;
  value: unknown;
}

export function validateConfig(config: Record<string, unknown>): void {
  const errors: string[] = [];

  // Validate defaults.provider
  const defaults = config.defaults as Record<string, unknown> | undefined;
  if (!defaults?.provider) {
    errors.push('defaults.provider is required');
  }

  // Validate sandbox config
  const sandbox = config.sandbox as Record<string, unknown> | undefined;
  if (sandbox) {
    if (sandbox.type && sandbox.type !== 'none' && sandbox.type !== 'bwrap') {
      errors.push(`sandbox.type must be "none" or "bwrap", got "${String(sandbox.type)}"`);
    }
    if (typeof sandbox.timeout === 'number' && sandbox.timeout < 0) {
      errors.push('sandbox.timeout must be non-negative');
    }
  }

  // Validate defaults.temperature
  if (defaults?.temperature !== undefined) {
    const temp = Number(defaults.temperature);
    if (Number.isNaN(temp) || temp < 0 || temp > 2) {
      errors.push('defaults.temperature must be between 0 and 2');
    }
  }

  // Validate defaults.maxTokens
  if (defaults?.maxTokens !== undefined) {
    const mt = Number(defaults.maxTokens);
    if (!Number.isInteger(mt) || mt < 1) {
      errors.push('defaults.maxTokens must be a positive integer');
    }
  }

  if (errors.length > 0) {
    throw new ZaiConfigError(
      `Configuration validation failed: ${errors.join('; ')}`,
      { fields: errors },
    );
  }
}
