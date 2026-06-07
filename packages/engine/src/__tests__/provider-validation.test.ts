// =============================================================================
// @zaivim/engine — Provider validation, registry status, and redaction tests
// Story 1b.1 Tasks 2, 3, 4: AC1, AC2, AC3, AC5, AC6, AC7
// =============================================================================

import { describe, it, expect } from 'vitest';
import {
  validateProviderConfig,
  validateProviderCompatibility,
  type ProviderValidationResult,
} from '../provider/validation.js';
import {
  ProviderRegistry,
  createProviderRegistry,
  type ProviderConfig,
} from '../provider/index.js';

// ---- Task 2.2: validateProviderConfig() (AC6) --------------------------------

describe('validateProviderConfig (Story 1b.1 AC6)', () => {
  it('returns valid for correct config', () => {
    const result = validateProviderConfig({
      name: 'deepseek',
      type: 'openai',
      apiKey: 'sk-test-key',
      baseURL: 'https://api.deepseek.com',
      models: ['deepseek-chat'],
      defaultModel: 'deepseek-chat',
    });
    expect(result.valid).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('returns invalid for empty apiKey', () => {
    const result = validateProviderConfig({
      name: 'deepseek',
      type: 'openai',
      apiKey: '',
      baseURL: 'https://api.deepseek.com',
      models: ['deepseek-chat'],
      defaultModel: 'deepseek-chat',
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('apiKey');
  });

  it('returns invalid for invalid baseURL format', () => {
    const result = validateProviderConfig({
      name: 'deepseek',
      type: 'openai',
      apiKey: 'sk-test-key',
      baseURL: 'not-a-valid-url',
      models: ['deepseek-chat'],
      defaultModel: 'deepseek-chat',
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('baseURL');
  });

  it('returns invalid for empty models array', () => {
    const result = validateProviderConfig({
      name: 'deepseek',
      type: 'openai',
      apiKey: 'sk-test-key',
      baseURL: 'https://api.deepseek.com',
      models: [],
      defaultModel: 'deepseek-chat',
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('models');
  });

  it('returns valid for config with protocol field', () => {
    const result = validateProviderConfig({
      name: 'deepseek',
      type: 'openai',
      apiKey: 'sk-test-key',
      baseURL: 'https://api.deepseek.com',
      models: ['deepseek-chat'],
      defaultModel: 'deepseek-chat',
      protocol: 'openai-compatible',
    });
    expect(result.valid).toBe(true);
  });

  it('returns invalid for unresolved env var apiKey', () => {
    const result = validateProviderConfig({
      name: 'deepseek',
      type: 'openai',
      apiKey: '$DEEPSEEK_API_KEY',
      baseURL: 'https://api.deepseek.com',
      models: ['deepseek-chat'],
      defaultModel: 'deepseek-chat',
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('not resolved');
  });
});

// ---- Task 2.1: ProviderRegistry syntax validation (AC6) -----------------------

describe('ProviderRegistry syntax validation (Story 1b.1 AC6)', () => {
  it('marks valid providers as untested', () => {
    const registry = createProviderRegistry(
      {
        deepseek: {
          name: 'deepseek',
          type: 'openai',
          apiKey: 'sk-test-key',
          baseURL: 'https://api.deepseek.com',
          models: ['deepseek-chat'],
          defaultModel: 'deepseek-chat',
        },
      },
      'deepseek',
    );
    expect(registry.getProviderStatus('deepseek')).toBe('untested');
  });

  it('marks provider with empty apiKey as unavailable', () => {
    const registry = createProviderRegistry(
      {
        deepseek: {
          name: 'deepseek',
          type: 'openai',
          apiKey: '',
          baseURL: 'https://api.deepseek.com',
          models: ['deepseek-chat'],
          defaultModel: 'deepseek-chat',
        },
      },
      'deepseek',
    );
    expect(registry.getProviderStatus('deepseek')).toBe('unavailable');
  });

  it('marks provider with invalid baseURL as unavailable', () => {
    const registry = createProviderRegistry(
      {
        deepseek: {
          name: 'deepseek',
          type: 'openai',
          apiKey: 'sk-test-key',
          baseURL: 'not-a-url',
          models: ['deepseek-chat'],
          defaultModel: 'deepseek-chat',
        },
      },
      'deepseek',
    );
    expect(registry.getProviderStatus('deepseek')).toBe('unavailable');
  });
});

// ---- Task 2.3: switchProvider stub (AC5) ------------------------------------

describe('switchProvider stub (Story 1b.1 AC5)', () => {
  it('returns false (E9 stub)', () => {
    const registry = createProviderRegistry(
      {
        deepseek: {
          name: 'deepseek',
          type: 'openai',
          apiKey: 'sk-test',
          baseURL: 'https://api.deepseek.com',
          models: ['deepseek-chat'],
          defaultModel: 'deepseek-chat',
        },
      },
      'deepseek',
    );
    expect(registry.switchProvider('deepseek')).toBe(false);
  });
});

// ---- Task 2.4: getProviderStatus (AC6) --------------------------------------

describe('getProviderStatus (Story 1b.1 AC6)', () => {
  it('throws for unknown provider', () => {
    const registry = createProviderRegistry({}, 'default');
    expect(() => registry.getProviderStatus('nonexistent')).toThrow();
  });
});

// ---- Task 2.5: listAvailableProviders (AC6) ---------------------------------

describe('listAvailableProviders (Story 1b.1 AC6)', () => {
  it('returns only providers with available or untested status', () => {
    const registry = createProviderRegistry(
      {
        deepseek: {
          name: 'deepseek',
          type: 'openai',
          apiKey: 'sk-test',
          baseURL: 'https://api.deepseek.com',
          models: ['deepseek-chat'],
          defaultModel: 'deepseek-chat',
        },
        broken: {
          name: 'broken',
          type: 'openai',
          apiKey: '',
          baseURL: 'invalid',
          models: [],
          defaultModel: '',
        },
      },
      'deepseek',
    );
    const available = registry.listAvailableProviders();
    expect(available).toContain('deepseek');
    expect(available).not.toContain('broken');
  });
});

// ---- Task 4.1: validateProviderCompatibility (AC7) ---------------------------

describe('validateProviderCompatibility (Story 1b.1 AC7)', () => {
  it('returns valid for correct SSE chunk format', () => {
    const chunk = {
      choices: [{ delta: { content: 'Hello' }, finish_reason: null }],
    };
    const result = validateProviderCompatibility(chunk);
    expect(result.valid).toBe(true);
  });

  it('returns invalid when choices is missing', () => {
    const chunk = {};
    const result = validateProviderCompatibility(chunk);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('choices');
  });

  it('returns invalid when delta.content is not a string', () => {
    const chunk = {
      choices: [{ delta: { content: 123 }, finish_reason: null }],
    };
    const result = validateProviderCompatibility(chunk);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('delta.content');
  });

  it('returns valid when finish_reason is present in choice', () => {
    const chunk = {
      choices: [{ delta: { content: 'test' }, finish_reason: 'stop' }],
    };
    const result = validateProviderCompatibility(chunk);
    expect(result.valid).toBe(true);
  });
});

// ---- Task 4.3: ProviderRegistry auto-fallback (AC7) -------------------------

describe('ProviderRegistry auto-fallback (Story 1b.1 AC7)', () => {
  it('getFallback returns next available provider', () => {
    const registry = createProviderRegistry(
      {
        deepseek: {
          name: 'deepseek',
          type: 'openai',
          apiKey: 'sk-test',
          baseURL: 'https://api.deepseek.com',
          models: ['deepseek-chat'],
          defaultModel: 'deepseek-chat',
        },
        glm: {
          name: 'glm',
          type: 'openai',
          apiKey: 'sk-glm',
          baseURL: 'https://open.bigmodel.cn/api/paas',
          models: ['glm-4'],
          defaultModel: 'glm-4',
        },
      },
      'deepseek',
    );
    const fallback = registry.getFallback('deepseek');
    expect(fallback).toBeDefined();
    expect(fallback!.name).toBe('glm');
  });

  it('getFallback returns undefined when no alternatives', () => {
    const registry = createProviderRegistry(
      {
        deepseek: {
          name: 'deepseek',
          type: 'openai',
          apiKey: 'sk-test',
          baseURL: 'https://api.deepseek.com',
          models: ['deepseek-chat'],
          defaultModel: 'deepseek-chat',
        },
      },
      'deepseek',
    );
    expect(registry.getFallback('deepseek')).toBeUndefined();
  });

  it('markUnavailable updates provider status', () => {
    const registry = createProviderRegistry(
      {
        deepseek: {
          name: 'deepseek',
          type: 'openai',
          apiKey: 'sk-test',
          baseURL: 'https://api.deepseek.com',
          models: ['deepseek-chat'],
          defaultModel: 'deepseek-chat',
        },
      },
      'deepseek',
    );
    expect(registry.getProviderStatus('deepseek')).toBe('untested');
    registry.markUnavailable('deepseek', 'format incompatibility');
    expect(registry.getProviderStatus('deepseek')).toBe('unavailable');
  });

  it('markAvailable updates provider status', () => {
    const registry = createProviderRegistry(
      {
        deepseek: {
          name: 'deepseek',
          type: 'openai',
          apiKey: 'sk-test',
          baseURL: 'https://api.deepseek.com',
          models: ['deepseek-chat'],
          defaultModel: 'deepseek-chat',
        },
      },
      'deepseek',
    );
    registry.markAvailable('deepseek');
    expect(registry.getProviderStatus('deepseek')).toBe('available');
  });
});
