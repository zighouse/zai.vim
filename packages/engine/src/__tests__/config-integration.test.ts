// =============================================================================
// @zaivim/engine — Config integration tests
// Full loadConfig() flow: 3-layer merge, env vars, validation, freeze, backup/recovery
// =============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../config/config-loader.js';
import { validateConfig } from '../config/config-validator.js';
import { ZaiConfigError } from '@zaivim/core';

// ---- validateConfig ----

describe('validateConfig', () => {
  it('passes valid config', () => {
    expect(() =>
      validateConfig({
        defaults: { provider: 'test', model: 'v1', temperature: 0.7, maxTokens: 4096 },
        sandbox: { type: 'none' },
        providers: {},
      }),
    ).not.toThrow();
  });

  it('rejects invalid temperature', () => {
    expect(() =>
      validateConfig({ defaults: { provider: 'test', temperature: 5.0 } }),
    ).toThrow(ZaiConfigError);
  });

  it('rejects invalid maxTokens', () => {
    expect(() =>
      validateConfig({ defaults: { provider: 'test', maxTokens: -1 } }),
    ).toThrow(ZaiConfigError);
  });

  it('rejects invalid sandbox type', () => {
    expect(() =>
      validateConfig({ defaults: { provider: 'test' }, sandbox: { type: 'invalid' } }),
    ).toThrow(ZaiConfigError);
  });

  it('passes with skipProviderCheck', () => {
    expect(() =>
      validateConfig({ defaults: {}, sandbox: {} }, { skipProviderCheck: true }),
    ).not.toThrow();
  });

  it('requires provider when skipProviderCheck is false', () => {
    expect(() => validateConfig({ defaults: {} })).toThrow('defaults.provider is required');
  });
});

// ---- deepFreeze ----

describe('config immutability', () => {
  it('deep freezes config object', () => {
    const obj = { a: 1, b: { c: 2 } };
    function deepFreeze<T>(o: T): T {
      if (o && typeof o === 'object' && !Object.isFrozen(o)) {
        Object.freeze(o);
        for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
      }
      return o;
    }
    const frozen = deepFreeze(obj);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.b)).toBe(true);
    expect(() => { (frozen as Record<string, unknown>).a = 99; }).toThrow();
  });
});

// ---- Full pipeline tests ----

let tempHome: string;

beforeEach(() => {
  tempHome = resolve(tmpdir(), `zai-loadconfig-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(resolve(tempHome, '.zaivim'), { recursive: true });
});

afterEach(() => {
  rmSync(tempHome, { recursive: true, force: true });
});

function writeYamlConfig(path: string, data: Record<string, unknown>): void {
  const yaml = require('yaml');
  writeFileSync(path, yaml.stringify(data), 'utf-8');
}

describe('loadConfig full pipeline', () => {
  it('returns default config when no user config exists', () => {
    const config = loadConfig({ configHomeDir: tempHome });
    expect(config.language).toBe('en');
    expect(config.sandbox.type).toBe('none');
    expect(config.defaults.temperature).toBe(0.7);
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('loads and merges user config from assistants.yaml', () => {
    writeYamlConfig(resolve(tempHome, '.zaivim', 'assistants.yaml'), {
      services: {
        deepseek: {
          type: 'openai',
          api_key: 'sk-test',
          base_url: 'https://api.deepseek.com',
          models: ['deepseek-v3'],
          default_model: 'deepseek-v3',
        },
      },
    });

    const config = loadConfig({ configHomeDir: tempHome });
    expect(config.providers.deepseek).toBeDefined();
    expect(config.providers.deepseek.apiKey).toBe('sk-test');
    expect(config.providers.deepseek.baseURL).toBe('https://api.deepseek.com');
    expect(config.defaults.provider).toBe('deepseek');
  });

  it('prefers config.yaml over assistants.yaml', () => {
    writeYamlConfig(resolve(tempHome, '.zaivim', 'config.yaml'), {
      providers: {
        openai: { type: 'openai', apiKey: 'sk-new', baseURL: 'https://api.openai.com', models: ['gpt-4'], defaultModel: 'gpt-4' },
      },
      defaults: { provider: 'openai', model: 'gpt-4', temperature: 0.5, maxTokens: 8192 },
    });
    writeYamlConfig(resolve(tempHome, '.zaivim', 'assistants.yaml'), {
      services: { deepseek: { type: 'openai', api_key: 'sk-old', models: ['deepseek-v3'] } },
    });

    const config = loadConfig({ configHomeDir: tempHome });
    expect(config.providers.openai).toBeDefined();
    expect(config.providers.openai.apiKey).toBe('sk-new');
    expect(config.defaults.model).toBe('gpt-4');
  });

  it('resolves env vars and marks unavailable providers', () => {
    process.env.TEST_RESOLVE_KEY = 'sk-resolved';
    delete process.env.TEST_MISSING_KEY;

    writeYamlConfig(resolve(tempHome, '.zaivim', 'config.yaml'), {
      providers: {
        resolved: { type: 'openai', apiKey: '$TEST_RESOLVE_KEY', baseURL: '', models: [], defaultModel: '' },
        missing: { type: 'openai', apiKey: '$TEST_MISSING_KEY', baseURL: '', models: [], defaultModel: '' },
      },
      defaults: { provider: 'resolved', model: '', temperature: 0.7, maxTokens: 4096 },
    });

    const config = loadConfig({ configHomeDir: tempHome });
    expect(config.providers.resolved.apiKey).toBe('sk-resolved');
    expect(config.providers.missing.status).toBe('unavailable');

    delete process.env.TEST_RESOLVE_KEY;
  });

  it('handles JS comments in config files', () => {
    writeFileSync(
      resolve(tempHome, '.zaivim', 'config.yaml'),
      [
        '/* block comment */',
        'providers:',
        '  test: # inline comment',
        '    type: openai',
        '    apiKey: "sk-test" // line comment',
        '    baseURL: ""',
        '    models: []',
        '    defaultModel: ""',
        'defaults:',
        '  provider: test',
        '  model: ""',
        '  temperature: 0.7',
        '  maxTokens: 4096',
      ].join('\n'),
    );

    const config = loadConfig({ configHomeDir: tempHome });
    expect(config.providers.test).toBeDefined();
    expect(config.providers.test.apiKey).toBe('sk-test');
  });

  it('normalizes api-key to api_key', () => {
    writeYamlConfig(resolve(tempHome, '.zaivim', 'config.yaml'), {
      providers: {
        test: { 'api-key': 'sk-normalized', 'base-url': 'https://test.com', type: 'openai', models: [], 'default-model': '' },
      },
      defaults: { provider: 'test', model: '', temperature: 0.7, maxTokens: 4096 },
    });

    const config = loadConfig({ configHomeDir: tempHome });
    expect(config.providers.test.apiKey).toBe('sk-normalized');
    expect(config.providers.test.baseURL).toBe('https://test.com');
  });

  it('creates backup after successful load', () => {
    writeYamlConfig(resolve(tempHome, '.zaivim', 'config.yaml'), {
      providers: { test: { type: 'openai', apiKey: 'sk-backup', baseURL: '', models: [], defaultModel: '' } },
      defaults: { provider: 'test', model: '', temperature: 0.7, maxTokens: 4096 },
    });

    loadConfig({ configHomeDir: tempHome });
    expect(existsSync(resolve(tempHome, '.zaivim', 'config.yaml.backup'))).toBe(true);
  });

  it('falls back to defaults when config is corrupted and no backup exists', () => {
    writeFileSync(resolve(tempHome, '.zaivim', 'config.yaml'), 'corrupted: {{{invalid yaml:::');

    const logs: string[] = [];
    const config = loadConfig({ configHomeDir: tempHome, logger: (msg) => logs.push(msg) });
    expect(config.language).toBe('en');
    expect(config.defaults.provider).toBe('');
    expect(logs.length).toBeGreaterThan(0);
  });

  it('restores from backup when config is corrupted', () => {
    writeYamlConfig(resolve(tempHome, '.zaivim', 'config.yaml'), {
      providers: { restored: { type: 'openai', apiKey: 'sk-restored', baseURL: '', models: [], defaultModel: '' } },
      defaults: { provider: 'restored', model: '', temperature: 0.7, maxTokens: 4096 },
    });

    // First load creates backup
    loadConfig({ configHomeDir: tempHome });
    expect(existsSync(resolve(tempHome, '.zaivim', 'config.yaml.backup'))).toBe(true);

    // Corrupt main config
    writeFileSync(resolve(tempHome, '.zaivim', 'config.yaml'), 'corrupted: {{{{{');

    const logs: string[] = [];
    const config = loadConfig({ configHomeDir: tempHome, logger: (msg) => logs.push(msg) });
    expect(config.providers.restored).toBeDefined();
    expect(config.providers.restored.apiKey).toBe('sk-restored');
    expect(logs.some((l) => l.includes('corrupted') || l.includes('backup'))).toBe(true);
  });

  // ---- Story 1b.1: Protocol parsing and layer merge ----

  it('parses protocol field from provider config (Story 1b.1 AC8)', () => {
    writeYamlConfig(resolve(tempHome, '.zaivim', 'config.yaml'), {
      providers: {
        deepseek: {
          type: 'openai',
          apiKey: 'sk-test',
          baseURL: 'https://api.deepseek.com',
          models: ['deepseek-chat'],
          defaultModel: 'deepseek-chat',
          protocol: 'openai-compatible',
        },
      },
      defaults: { provider: 'deepseek', model: 'deepseek-chat', temperature: 0.7, maxTokens: 4096 },
    });

    const config = loadConfig({ configHomeDir: tempHome });
    expect(config.providers.deepseek.protocol).toBe('openai-compatible');
  });

  it('ignores invalid protocol values (Story 1b.1 AC8)', () => {
    writeYamlConfig(resolve(tempHome, '.zaivim', 'config.yaml'), {
      providers: {
        test: {
          type: 'openai',
          apiKey: 'sk-test',
          baseURL: 'https://api.test.com',
          models: ['test-model'],
          defaultModel: 'test-model',
          protocol: 'invalid-protocol',
        },
      },
      defaults: { provider: 'test', model: 'test-model', temperature: 0.7, maxTokens: 4096 },
    });

    const config = loadConfig({ configHomeDir: tempHome });
    // Invalid protocol should be ignored (not included in config)
    expect(config.providers.test.protocol).toBeUndefined();
  });
});
