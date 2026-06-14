// @zaivim/engine — Config loader
// YAML layer merging (default → user → project) + validation + deepFreeze
// Integrated: comment stripping, key/model normalization, backup/recovery

import type { ZaiConfig, ProviderConfig } from '@zaivim/core';
import { ZaiConfigError } from '@zaivim/core';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { resolveEnvVars, markUnavailableProviders } from './env-resolver.js';
import { validateConfig } from './config-validator.js';
import { stripJsComments, normalizeConfigKeys, normalizeModelField } from './config-compat.js';
import { createConfigBackup, restoreFromBackup, getDefaultConfig } from './config-backup.js';

const _require = createRequire(import.meta.url);
let yaml: { parse: (s: string) => unknown } | undefined;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  yaml = _require('yaml') as { parse: (s: string) => unknown };
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

function resolveUserConfigPath(configHomeDir?: string): string | null {
  const home = configHomeDir ?? homedir();
  const candidates = [
    resolve(home, '.zaivim', 'config.yaml'),
    resolve(home, '.zaivim', 'config.yml'),
    resolve(home, '.zaivim', 'assistants.yaml'),
    resolve(home, '.zaivim', 'assistants.yml'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

function resolveProjectConfigPath(): string | null {
  const candidates = [
    resolve(process.cwd(), '.zaivim', 'project.yaml'),
    resolve(process.cwd(), '.zaivim', 'project.yml'),
    resolve(process.cwd(), '.zaivim', 'project.json'),
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
    const cleaned = stripJsComments(raw);
    const normalized = normalizeConfigKeys(yaml.parse(cleaned));
    if (typeof normalized !== 'object' || normalized === null) return null;
    return normalized as Record<string, unknown>;
  } catch (err) {
    if (err instanceof Error) {
      const mark = (err as { mark?: { line?: number; column?: number } }).mark;
      throw new ZaiConfigError(
        `YAML parse error in ${path}: ${err.message}`,
        { file: path, line: mark?.line ?? undefined, column: mark?.column ?? undefined },
      );
    }
    return null;
  }
}

function loadJsonFile(path: string): Record<string, unknown> | null {
  try {
    const raw = readFileSync(path, 'utf-8');
    const cleaned = stripJsComments(raw);
    const normalized = normalizeConfigKeys(JSON.parse(cleaned));
    if (typeof normalized !== 'object' || normalized === null) return null;
    return normalized as Record<string, unknown>;
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new ZaiConfigError(
        `JSON parse error in ${path}: ${err.message}`,
        { file: path },
      );
    }
    return null;
  }
}

function loadConfigFile(path: string): Record<string, unknown> | null {
  if (path.endsWith('.json')) return loadJsonFile(path);
  return loadYamlFile(path);
}

function parseProviderConfig(raw: Record<string, unknown>): Record<string, ProviderConfig> {
  const providers: Record<string, ProviderConfig> = {};
  for (const [name, cfg] of Object.entries(raw)) {
    if (!cfg || typeof cfg !== 'object') continue;
    const c = cfg as Record<string, unknown>;
    const models = normalizeModelField(c.models);
    const modelNames = models.map((m) => m.name);
    const protocol = c.protocol;
    providers[name] = {
      type: String(c.type ?? 'openai'),
      apiKey: String(c.api_key ?? c.apiKey ?? ''),
      baseURL: String(c.base_url ?? c.baseURL ?? ''),
      models: modelNames,
      defaultModel: String(c.default_model ?? c.defaultModel ?? modelNames[0] ?? ''),
      ...(protocol === 'openai-compatible' || protocol === 'anthropic-native'
        ? { protocol }
        : {}),
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

export interface LoadConfigOptions {
  overrides?: Partial<ZaiConfig>;
  logger?: (msg: string) => void;
  /** Override home directory for path resolution (testing) */
  configHomeDir?: string;
}

/**
 * Load configuration with YAML layer merging.
 * Layers: default → user (~/.zaivim/config.yaml or assistants.yaml) → project (.zaivim/project.yaml)
 * Includes: comment stripping, key normalization, model normalization, backup/recovery, env var resolution.
 * Returns Readonly<ZaiConfig> (deepFrozen).
 */
export function loadConfig(overrides?: Partial<ZaiConfig>, logger?: (msg: string) => void): Readonly<ZaiConfig>;
export function loadConfig(opts: LoadConfigOptions): Readonly<ZaiConfig>;
export function loadConfig(overridesOrOpts?: Partial<ZaiConfig> | LoadConfigOptions, logger?: (msg: string) => void): Readonly<ZaiConfig> {
  const opts: LoadConfigOptions = overridesOrOpts && typeof overridesOrOpts === 'object' && ('configHomeDir' in overridesOrOpts || 'overrides' in overridesOrOpts || 'logger' in overridesOrOpts)
    ? overridesOrOpts as LoadConfigOptions
    : { overrides: overridesOrOpts as Partial<ZaiConfig> | undefined, logger };

  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as {
    language: string;
    sandbox: { enabled: boolean; type: 'none' | 'bwrap'; workDir: string; timeout: number };
    providers: Record<string, ProviderConfig>;
    defaults: { provider: string; model: string; temperature: number; maxTokens: number };
    engine?: { constants?: ZaiConfig['engine'] extends { constants?: infer C } | undefined ? C : never };
  };

  // Layer 1: User config
  const userPath = resolveUserConfigPath(opts.configHomeDir);
  if (userPath) {
    let userRaw: Record<string, unknown> | null = null;
    try {
      userRaw = loadConfigFile(userPath);
    } catch (err) {
      if (err instanceof ZaiConfigError) {
        const log = opts.logger ?? ((msg: string) => process.stderr.write(msg + '\n'));
        // Log detailed error info before recovery (AC3: field-level error report)
        const detail = err.detail as { file?: string; line?: number; column?: number } | undefined;
        const location = detail?.file
          ? ` in ${detail.file}${detail.line != null ? `:${detail.line}` : ''}${detail.column != null ? `:${detail.column}` : ''}`
          : '';
        log(`Warning: config parse error${location} — ${err.message}`);
        const restored = restoreFromBackup(userPath, log);
        if (restored) {
          userRaw = loadConfigFile(restored);
        } else {
          log('Warning: no valid config found, using defaults');
          userRaw = null;
        }
      } else {
        throw err;
      }
    }

    // Handle old Python format: YAML array of providers [{name, base-url, api-key-name, model}, ...]
    if (userRaw && Array.isArray(userRaw)) {
      const mapped: Record<string, Record<string, unknown>> = {};
      for (const item of userRaw) {
        if (!item || typeof item !== 'object') continue;
        const entry = item as Record<string, unknown>;
        const name = String(entry.name ?? '');
        if (!name) continue;
        const models = normalizeModelField(entry.model);
        const modelNames = models.map(m => String((m as Record<string, unknown>).api_name ?? m.name));
        mapped[name] = {
          type: entry.type ?? 'openai',
          apiKey: entry.api_key_name ? `$${entry.api_key_name}` : (entry.api_key ?? ''),
          baseURL: entry.base_url ?? '',
          models: modelNames,
          defaultModel: String(entry.default_model ?? modelNames[0] ?? ''),
        };
      }
      userRaw = { providers: mapped } as Record<string, unknown>;
    }

    if (userRaw) {
      // New format: top-level providers key
      // Old format: services or assistants key wrapping providers
      const isNewFormat = typeof userRaw.providers === 'object' && userRaw.providers !== null;
      const providerSource = isNewFormat
        ? userRaw.providers as Record<string, unknown>
        : (userRaw.services ?? userRaw.assistants ?? userRaw) as Record<string, unknown>;

      if (typeof providerSource === 'object' && providerSource) {
        const providers = parseProviderConfig(providerSource);
        Object.assign(config.providers, providers);

        const keys = Object.keys(providers);
        if (keys.length > 0 && !config.defaults.provider) {
          config.defaults.provider = keys[0]!;
          config.defaults.model = providers[keys[0]!]?.defaultModel ?? '';
        }
      }

      // Apply defaults from new-format config
      if (isNewFormat && typeof userRaw.defaults === 'object' && userRaw.defaults) {
        const cfgDefaults = userRaw.defaults as Record<string, unknown>;
        if (cfgDefaults.provider) config.defaults.provider = String(cfgDefaults.provider);
        if (cfgDefaults.model) config.defaults.model = String(cfgDefaults.model);
        if (cfgDefaults.temperature !== undefined) config.defaults.temperature = Number(cfgDefaults.temperature);
        if (cfgDefaults.maxTokens !== undefined) config.defaults.maxTokens = Number(cfgDefaults.maxTokens);
        if (cfgDefaults.language) config.language = String(cfgDefaults.language);
      }

      createConfigBackup(userPath, opts.logger);
    }
  }

  // Layer 2: Project config
  const projectPath = resolveProjectConfigPath();
  if (projectPath) {
    const projRaw = loadConfigFile(projectPath);
    if (projRaw) {
      // Merge sandbox from project config
      const sandbox = projRaw.sandbox as Record<string, unknown> | undefined;
      if (sandbox) {
        if (sandbox.enabled !== undefined) config.sandbox.enabled = Boolean(sandbox.enabled);
        if (sandbox.type) config.sandbox.type = sandbox.type as 'none' | 'bwrap';
        if (sandbox.work_dir ?? sandbox.workDir) config.sandbox.workDir = String(sandbox.work_dir ?? sandbox.workDir);
        if (sandbox.timeout !== undefined) config.sandbox.timeout = Number(sandbox.timeout);
      }
      // Merge defaults from project config (AC2: project overrides user)
      const projDefaults = projRaw.defaults as Record<string, unknown> | undefined;
      if (projDefaults) {
        if (projDefaults.provider) config.defaults.provider = String(projDefaults.provider);
        if (projDefaults.model) config.defaults.model = String(projDefaults.model);
        if (projDefaults.temperature !== undefined) config.defaults.temperature = Number(projDefaults.temperature);
        if (projDefaults.maxTokens !== undefined) config.defaults.maxTokens = Number(projDefaults.maxTokens);
        if (projDefaults.language) config.language = String(projDefaults.language);
      }
    }
  }

  // Layer 3: Overrides (CLI flags, env vars)
  if (opts.overrides) {
    if (opts.overrides.language) config.language = opts.overrides.language;
    if (opts.overrides.defaults?.provider !== undefined) config.defaults.provider = opts.overrides.defaults.provider;
    if (opts.overrides.defaults?.model !== undefined) config.defaults.model = opts.overrides.defaults.model;
    if (opts.overrides.providers) config.providers = { ...opts.overrides.providers };
  }

  // Resolve environment variables ($VAR_NAME patterns)
  resolveEnvVars(config);

  // Mark providers with unresolved env vars as unavailable
  markUnavailableProviders(config.providers as unknown as Record<string, Record<string, unknown>>);

  // Validate (skip provider check for MVP/engine-start mode)
  validateConfig(config, { skipProviderCheck: !config.defaults.provider });

  return deepFreeze(config) as ZaiConfig;
}

export { DEFAULT_CONFIG };
