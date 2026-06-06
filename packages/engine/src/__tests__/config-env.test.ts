// =============================================================================
// @zaivim/engine — Env resolver + unavailable marking tests
// resolveEnvVars, markUnavailableProviders
// =============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveEnvVars, markUnavailableProviders } from '../config/env-resolver.js';

// ---- resolveEnvVars ----

describe('resolveEnvVars', () => {
  it('replaces $VAR_NAME with env value', () => {
    process.env.TEST_API_KEY = 'sk-test-123';
    try {
      const config = { apiKey: '$TEST_API_KEY' };
      resolveEnvVars(config);
      expect(config.apiKey).toBe('sk-test-123');
    } finally {
      delete process.env.TEST_API_KEY;
    }
  });

  it('leaves $VAR_NAME as-is when env var is not set', () => {
    delete process.env.NONEXISTENT_VAR_XYZ;
    const config = { apiKey: '$NONEXISTENT_VAR_XYZ' };
    resolveEnvVars(config);
    expect(config.apiKey).toBe('$NONEXISTENT_VAR_XYZ');
  });

  it('resolves nested env vars', () => {
    process.env.TEST_BASE_URL = 'https://api.test.com';
    try {
      const config = {
        providers: {
          test: { apiKey: '$TEST_BASE_URL' },
        },
      };
      resolveEnvVars(config);
      expect((config.providers as Record<string, Record<string, unknown>>).test.apiKey).toBe('https://api.test.com');
    } finally {
      delete process.env.TEST_BASE_URL;
    }
  });

  it('resolves env vars in arrays', () => {
    process.env.TEST_MODEL = 'gpt-4';
    try {
      const config = { models: ['$TEST_MODEL', 'static-model'] };
      resolveEnvVars(config);
      expect(config.models).toEqual(['gpt-4', 'static-model']);
    } finally {
      delete process.env.TEST_MODEL;
    }
  });

  it('does not modify non-$ strings', () => {
    const config = { apiKey: 'sk-static-key', type: 'openai' };
    resolveEnvVars(config);
    expect(config.apiKey).toBe('sk-static-key');
    expect(config.type).toBe('openai');
  });

  it('does not match lowercase env var patterns', () => {
    const config = { value: '$lowercase_var' };
    resolveEnvVars(config);
    expect(config.value).toBe('$lowercase_var');
  });
});

// ---- markUnavailableProviders ----

describe('markUnavailableProviders', () => {
  it('marks provider as unavailable when apiKey is unresolved env var', () => {
    const providers = {
      deepseek: { apiKey: '$MISSING_KEY', type: 'openai' },
    };
    markUnavailableProviders(providers);
    expect(providers.deepseek.status).toBe('unavailable');
  });

  it('does not mark provider when apiKey is resolved', () => {
    const providers = {
      deepseek: { apiKey: 'sk-resolved', type: 'openai' },
    };
    markUnavailableProviders(providers);
    expect(providers.deepseek.status).toBeUndefined();
  });

  it('handles multiple providers with mixed status', () => {
    const providers = {
      deepseek: { apiKey: '$MISSING_KEY', type: 'openai' },
      openai: { apiKey: 'sk-valid', type: 'openai' },
    };
    markUnavailableProviders(providers);
    expect(providers.deepseek.status).toBe('unavailable');
    expect(providers.openai.status).toBeUndefined();
  });
});
