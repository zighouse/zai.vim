// @zaivim/engine — Configuration loading
// Reads ~/.zaivim/assistants.yaml (user) and zai.project/zai_project.yaml (project)
// deepFreeze applied before returning to prevent runtime mutation.

import type { ZaiConfig, ProviderConfig, SandboxConfig } from '@zaivim/core';
import { ZaiConfigError } from '@zaivim/core';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';

// MVP: synchronous YAML read via require. Growth phase: safeLoad without exec.
// eslint-disable-next-line @typescript-eslint/no-require-imports
let yaml: { parse: (s: string) => unknown } | undefined;
try {
  yaml = require('yaml') as { parse: (s: string) => unknown };
} catch {
  // yaml not installed — config files are optional
}

// ---- Default configuration ------------------------------------------------

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

// ---- Path resolution ------------------------------------------------------

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
    resolve(process.cwd(), 'zai.project', 'zai_project.yaml'),
    resolve(process.cwd(), 'zai.project', 'zai_project.yml'),
    resolve(process.cwd(), 'zai_project.yaml'),
    resolve(process.cwd(), 'zai_project.yml'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

// ---- Loading --------------------------------------------------------------

function loadYamlFile(path: string): Record<string, unknown> | null {
  if (!yaml) return null;
  try {
    const raw = readFileSync(path, 'utf-8');
    return yaml.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseProviderConfig(raw: Record<string, unknown>): Record<string, ProviderConfig> {
  const providers: Record<string, ProviderConfig> = {};

  for (const [name, cfg] of Object.entries(raw)) {
    if (!cfg || typeof cfg !== 'object') continue;
    const c = cfg as Record<string, unknown>;
    providers[name] = {
      type: String(c.type ?? 'openai'),
      apiKey: String(c.api_key ?? c.apiKey ?? ''),
      baseURL: String(c.base_url ?? c.baseURL ?? ''),
      models: Array.isArray(c.models) ? c.models.map(String) : [],
      defaultModel: String(c.default_model ?? c.defaultModel ?? c.models?.[0] ?? ''),
    };
  }

  return providers;
}

// ---- deepFreeze -----------------------------------------------------------

function deepFreeze<T>(obj: T): T {
  if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    for (const v of Object.values(obj as Record<string, unknown>)) {
      deepFreeze(v);
    }
  }
  return obj;
}

// ---- Public API -----------------------------------------------------------

export function loadConfig(overrides?: Partial<ZaiConfig>): ZaiConfig {
  let config = structuredClone?.(DEFAULT_CONFIG) ?? JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as ZaiConfig;

  // User config
  const userPath = resolveUserConfigPath();
  if (userPath) {
    const userRaw = loadYamlFile(userPath);
    if (userRaw) {
      const services = userRaw.services ?? userRaw.assistants ?? userRaw;
      if (typeof services === 'object' && services) {
        const providers = parseProviderConfig(services as Record<string, unknown>);
        Object.assign((config as { providers: Record<string, ProviderConfig> }).providers, providers);

        // Default provider from first key
        const keys = Object.keys(providers);
        if (keys.length > 0 && !(config as ZaiConfig).defaults.provider) {
          (config as { defaults: { provider: string; model: string } }).defaults.provider = keys[0]!;
          (config as { defaults: { provider: string; model: string } }).defaults.model =
            providers[keys[0]!]?.defaultModel ?? '';
        }
      }
    }
  }

  // Project config
  const projectPath = resolveProjectConfigPath();
  if (projectPath) {
    const projRaw = loadYamlFile(projectPath);
    if (projRaw) {
      const sandbox = projRaw.sandbox as Record<string, unknown> | undefined;
      if (sandbox) {
        const s = config as { sandbox: SandboxConfig };
        if (sandbox.enabled !== undefined) s.sandbox.enabled = Boolean(sandbox.enabled);
        if (sandbox.type) s.sandbox.type = sandbox.type as 'none' | 'bwrap';
        if (sandbox.work_dir) s.sandbox.workDir = String(sandbox.work_dir);
      }
    }
  }

  // Overrides (e.g., from CLI flags or env vars)
  if (overrides) {
    if (overrides.language) (config as { language: string }).language = overrides.language;
    if (overrides.defaults?.provider) (config as { defaults: { provider: string; model: string } }).defaults.provider = overrides.defaults.provider;
    if (overrides.defaults?.model) (config as { defaults: { provider: string; model: string } }).defaults.model = overrides.defaults.model;
  }

  // Validate
  if (!(config as ZaiConfig).defaults.provider) {
    throw new ZaiConfigError('No provider configured. Set up ~/.zaivim/assistants.yaml');
  }

  return deepFreeze(config);
}

export { DEFAULT_CONFIG };
