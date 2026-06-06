// @zaivim/engine — Config loader
// YAML layer merging (default → user → project) + validation + deepFreeze

import type { ZaiConfig, ProviderConfig } from '@zaivim/core';
import { ZaiConfigError } from '@zaivim/core';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { resolveEnvVars } from './env-resolver.js';
import { validateConfig } from './config-validator.js';

// eslint-disable-next-line @typescript-eslint/no-require-imports
let yaml: { parse: (s: string) => unknown } | undefined;
try {
  yaml = require('yaml') as { parse: (s: string) => unknown };
} catch {
  // yaml not installed — config files are optional
}

const DEFAULT_CONFIG: ZaiConfig = {
  language: 'en',
  sandbox: {
    enabled: false,
    type: 'none',
    workDir: '/tmp/zaivim-sandbox',
    timeout: 30_000,
  },
  providers: {},
  defaults: {
    provider: '',
    model: '',
    temperature: 0.7,
    maxTokens: 4096,
  },
};

function resolveUserConfigPath(): string | null {
  const candidates = [
    resolve(homedir(), '.zaivim', 'assistants.yaml'),
    resolve(homedir(), '.zaivim', 'assistants.yml'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

function resolveProjectConfigPath(): string | null {
  const candidates = [
    // New naming (Node.js migration)
    resolve(process.cwd(), '.zaivim', 'project.yaml'),
    resolve(process.cwd(), '.zaivim', 'project.yml'),
    // Legacy naming (Python compatibility)
    resolve(process.cwd(), 'zai.project', 'zai_project.yaml'),
    resolve(process.cwd(), 'zai.project', 'zai_project.yml'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

function loadYamlFile(path: string): Record<string, unknown> | null {
  if (!yaml) return null;
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = yaml.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof Error && 'mark' in err) {
      const mark = (err as { mark?: { line?: number; column?: number } }).mark;
      throw new ZaiConfigError(
        `YAML parse error in ${path}: ${err.message}`,
        { file: path, line: mark?.line, column: mark?.column },
      );
    }
    return null;
  }
}

function parseProviderConfig(raw: Record<string, unknown>): Record<string, ProviderConfig> {
  const providers: Record<string, ProviderConfig> = {};
  for (const [name, cfg] of Object.entries(raw)) {
    if (!cfg || typeof cfg !== 'object') continue;
    const c = cfg as Record<string, unknown>;
    const models = Array.isArray(c.models) ? c.models.map(String) : [];
    providers[name] = {
      type: String(c.type ?? 'openai'),
      apiKey: String(c.api_key ?? c.apiKey ?? ''),
      baseURL: String(c.base_url ?? c.baseURL ?? ''),
      models,
      defaultModel: String(c.default_model ?? c.defaultModel ?? models[0] ?? ''),
    };
  }
  return providers;
}

function deepFreeze<T>(obj: T): T {
  if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    for (const v of Object.values(obj as Record<string, unknown>)) {
      deepFreeze(v);
    }
  }
  return obj;
}

/**
 * Load configuration with YAML layer merging.
 * Layers: default → user (~/.zaivim/assistants.yaml) → project (.zaivim/project.yaml)
 * Returns Readonly<ZaiConfig> (deepFrozen).
 */
export function loadConfig(overrides?: Partial<ZaiConfig>): Readonly<ZaiConfig> {
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as {
    language: string;
    sandbox: { enabled: boolean; type: 'none' | 'bwrap'; workDir: string; timeout: number };
    providers: Record<string, ProviderConfig>;
    defaults: { provider: string; model: string; temperature: number; maxTokens: number };
    engine?: { constants?: ZaiConfig['engine'] extends { constants?: infer C } | undefined ? C : never };
  };

  // Layer 1: User config
  const userPath = resolveUserConfigPath();
  if (userPath) {
    const userRaw = loadYamlFile(userPath);
    if (userRaw) {
      const services = userRaw.services ?? userRaw.assistants ?? userRaw;
      if (typeof services === 'object' && services) {
        const providers = parseProviderConfig(services as Record<string, unknown>);
        Object.assign(config.providers, providers);

        const keys = Object.keys(providers);
        if (keys.length > 0 && !config.defaults.provider) {
          config.defaults.provider = keys[0]!;
          config.defaults.model = providers[keys[0]!]?.defaultModel ?? '';
        }
      }
    }
  }

  // Layer 2: Project config
  const projectPath = resolveProjectConfigPath();
  if (projectPath) {
    const projRaw = loadYamlFile(projectPath);
    if (projRaw) {
      const sandbox = projRaw.sandbox as Record<string, unknown> | undefined;
      if (sandbox) {
        if (sandbox.enabled !== undefined) config.sandbox.enabled = Boolean(sandbox.enabled);
        if (sandbox.type) config.sandbox.type = sandbox.type as 'none' | 'bwrap';
        if (sandbox.work_dir) config.sandbox.workDir = String(sandbox.work_dir);
      }
    }
  }

  // Layer 3: Overrides (CLI flags, env vars)
  if (overrides) {
    if (overrides.language) config.language = overrides.language;
    if (overrides.defaults?.provider) config.defaults.provider = overrides.defaults.provider;
    if (overrides.defaults?.model) config.defaults.model = overrides.defaults.model;
  }

  // Resolve environment variables ($VAR_NAME patterns)
  resolveEnvVars(config);

  // Validate (skip provider check for MVP/engine-start mode)
  validateConfig(config, { skipProviderCheck: !config.defaults.provider });

  return deepFreeze(config) as ZaiConfig;
}

export { DEFAULT_CONFIG };
