// =============================================================================
// @zaivim/engine — Integration tests for Provider registry and config
// Story 1b.1 Task 6: AC1, AC2, AC4, AC7 — multi-provider, env vars, project override, lifecycle
// =============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../config/config-loader.js';
import { createProviderRegistry } from '../provider/index.js';

let tempHome: string;

beforeEach(() => {
  tempHome = resolve(tmpdir(), `zai-provider-integ-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(resolve(tempHome, '.zaivim'), { recursive: true });
});

afterEach(() => {
  rmSync(tempHome, { recursive: true, force: true });
  delete process.env.TEST_DEEPSEEK_KEY;
  delete process.env.TEST_GLM_KEY;
});

function writeYamlConfig(path: string, data: Record<string, unknown>): void {
  const yaml = require('yaml');
  writeFileSync(path, yaml.stringify(data), 'utf-8');
}

// ---- Task 6.1: Multi-provider loading (AC1) ---------------------------------

describe('Task 6.1: Multi-provider config loading (AC1)', () => {
  it('loads multiple providers from assistants.yaml', () => {
    process.env.TEST_DEEPSEEK_KEY = 'sk-deepseek';
    process.env.TEST_GLM_KEY = 'sk-glm';

    writeYamlConfig(resolve(tempHome, '.zaivim', 'assistants.yaml'), {
      providers: {
        deepseek: {
          type: 'openai',
          api_key: '$TEST_DEEPSEEK_KEY',
          base_url: 'https://api.deepseek.com',
          models: ['deepseek-chat'],
          default_model: 'deepseek-chat',
          protocol: 'openai-compatible',
        },
        glm: {
          type: 'openai',
          api_key: '$TEST_GLM_KEY',
          base_url: 'https://open.bigmodel.cn/api/paas',
          models: ['glm-4'],
          default_model: 'glm-4',
          protocol: 'openai-compatible',
        },
      },
      defaults: { provider: 'deepseek', model: 'deepseek-chat', temperature: 0.7, maxTokens: 4096 },
    });

    const config = loadConfig({ configHomeDir: tempHome });
    const registry = createProviderRegistry(
      Object.fromEntries(
        Object.entries(config.providers).map(([k, v]) => [k, { ...v, name: k }]),
      ),
      config.defaults.provider,
    );

    // AC1: registry contains two providers
    expect(registry.listNames()).toContain('deepseek');
    expect(registry.listNames()).toContain('glm');
    expect(registry.listNames().length).toBe(2);

    // AC1: each accessible via get()
    const ds = registry.get('deepseek');
    expect(ds.name).toBe('deepseek');
    expect(ds.models).toEqual(['deepseek-chat']);

    const glm = registry.get('glm');
    expect(glm.name).toBe('glm');
    expect(glm.models).toEqual(['glm-4']);

    // AC1: protocol field is set
    expect(config.providers.deepseek.protocol).toBe('openai-compatible');
  });
});

// ---- Task 6.2: Env var not set (AC2) ----------------------------------------

describe('Task 6.2: Environment variable not set (AC2)', () => {
  it('marks provider as unavailable when env var not set', () => {
    delete process.env.TEST_DEEPSEEK_KEY;

    writeYamlConfig(resolve(tempHome, '.zaivim', 'config.yaml'), {
      providers: {
        deepseek: {
          type: 'openai',
          api_key: '$TEST_DEEPSEEK_KEY',
          base_url: 'https://api.deepseek.com',
          models: ['deepseek-chat'],
          default_model: 'deepseek-chat',
        },
      },
      defaults: { provider: 'deepseek', model: '', temperature: 0.7, maxTokens: 4096 },
    });

    const config = loadConfig({ configHomeDir: tempHome });
    const registry = createProviderRegistry(
      Object.fromEntries(
        Object.entries(config.providers).map(([k, v]) => [k, { ...v, name: k }]),
      ),
      config.defaults.provider,
    );

    // AC2: provider status is unavailable
    expect(config.providers.deepseek.status).toBe('unavailable');
    // Provider failed syntax validation (empty apiKey after env resolve) → unavailable
    expect(registry.getProviderStatus('deepseek')).toBe('unavailable');
  });
});

// ---- Task 6.3: Project-level config override (AC4) --------------------------

describe('Task 6.3: Project-level config override (AC4)', () => {
  it('project config overrides user-level defaults', () => {
    const origCwd = process.cwd();

    try {
      // Setup: user config with temperature 0.7
      writeYamlConfig(resolve(tempHome, '.zaivim', 'config.yaml'), {
        providers: {
          deepseek: {
            type: 'openai',
            api_key: 'sk-test',
            base_url: 'https://api.deepseek.com',
            models: ['deepseek-chat'],
            default_model: 'deepseek-chat',
          },
        },
        defaults: { provider: 'deepseek', model: 'deepseek-chat', temperature: 0.7, maxTokens: 4096 },
      });

      // Setup: project dir with .zaivim/project.yaml overriding temperature
      const projDir = resolve(tempHome, 'project');
      mkdirSync(resolve(projDir, '.zaivim'), { recursive: true });
      writeYamlConfig(resolve(projDir, '.zaivim', 'project.yaml'), {
        defaults: { temperature: 0.3 },
      });

      process.chdir(projDir);
      const config = loadConfig({ configHomeDir: tempHome });

      // AC4: project-level temperature overrides user-level
      expect(config.defaults.temperature).toBe(0.3);
      // AC4: provider config still from user-level
      expect(config.providers.deepseek.apiKey).toBe('sk-test');
    } finally {
      process.chdir(origCwd);
    }
  });
});

// ---- Task 6.5: Engine startup → Provider load → status query lifecycle ------

describe('Task 6.5: Provider lifecycle integration (AC1, AC6)', () => {
  it('full lifecycle: config load → registry create → status query', () => {
    process.env.TEST_KEY = 'sk-test';

    writeYamlConfig(resolve(tempHome, '.zaivim', 'config.yaml'), {
      providers: {
        valid: {
          type: 'openai',
          api_key: '$TEST_KEY',
          base_url: 'https://api.test.com',
          models: ['test-model'],
          default_model: 'test-model',
        },
        broken: {
          type: 'openai',
          api_key: '',
          base_url: 'invalid-url',
          models: [],
          default_model: '',
        },
      },
      defaults: { provider: 'valid', model: 'test-model', temperature: 0.7, maxTokens: 4096 },
    });

    // Step 1: Load config
    const config = loadConfig({ configHomeDir: tempHome });
    expect(config.providers.valid).toBeDefined();
    // broken provider: empty apiKey (not env var) so markUnavailableProviders won't mark it
    // but registry validation will catch it

    // Step 2: Create registry
    const registry = createProviderRegistry(
      Object.fromEntries(
        Object.entries(config.providers).map(([k, v]) => [k, { ...v, name: k }]),
      ),
      config.defaults.provider,
    );

    // Step 3: Query status
    expect(registry.getProviderStatus('valid')).toBe('untested');
    expect(registry.getProviderStatus('broken')).toBe('unavailable');

    // Step 4: List available (only valid)
    const available = registry.listAvailableProviders();
    expect(available).toEqual(['valid']);

    // Step 5: Mark valid as available
    registry.markAvailable('valid');
    expect(registry.getProviderStatus('valid')).toBe('available');

    delete process.env.TEST_KEY;
  });
});
