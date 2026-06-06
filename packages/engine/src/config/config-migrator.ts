// @zaivim/engine — Config migrator
// Detects legacy assistants.yaml, generates diff preview, writes config.yaml on --yes

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

// eslint-disable-next-line @typescript-eslint/no-require-imports
let yaml: { parse: (s: string) => unknown; stringify: (obj: unknown) => string } | undefined;
try {
  yaml = require('yaml') as { parse: (s: string) => unknown; stringify: (obj: unknown) => string };
} catch {
  // yaml not installed
}

const CONFIG_DIR = resolve(homedir(), '.zaivim');
const NEW_CONFIG = resolve(CONFIG_DIR, 'config.yaml');
const OLD_CONFIG = resolve(CONFIG_DIR, 'assistants.yaml');

const LEGACY_TOP_KEYS = ['services', 'assistants'] as const;

/**
 * Detect whether a YAML file uses the legacy format (has `services` or `assistants` top-level key).
 */
export function detectLegacyFormat(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  if (!yaml) return false;
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = yaml.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return false;
    const keys = Object.keys(parsed as Record<string, unknown>);
    return LEGACY_TOP_KEYS.some((k) => keys.includes(k));
  } catch {
    return false;
  }
}

interface ConvertedConfig {
  providers: Record<string, {
    type: string;
    apiKey: string;
    baseURL: string;
    models: string[];
    defaultModel: string;
  }>;
  defaults: {
    provider: string;
    model: string;
    temperature: number;
    maxTokens: number;
  };
}

function convertLegacyFormat(filePath: string): ConvertedConfig | null {
  if (!yaml) return null;
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = yaml.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;

    const services = obj.services ?? obj.assistants ?? obj;
    if (typeof services !== 'object' || services === null) return null;

    const providers: ConvertedConfig['providers'] = {};
    let firstProvider = '';
    let firstModel = '';

    for (const [name, cfg] of Object.entries(services as Record<string, unknown>)) {
      if (!cfg || typeof cfg !== 'object') continue;
      const c = cfg as Record<string, unknown>;
      const models = Array.isArray(c.models)
        ? c.models.map((m: unknown) => typeof m === 'object' && m !== null && 'name' in (m as object) ? String((m as { name: unknown }).name) : String(m))
        : [];
      const apiValue = String(c.api_key ?? c.apiKey ?? c['api-key'] ?? '');
      const baseValue = String(c.base_url ?? c.baseURL ?? c['base-url'] ?? '');
      const defaultModel = String(c.default_model ?? c.defaultModel ?? c['default-model'] ?? models[0] ?? '');

      providers[name] = {
        type: String(c.type ?? 'openai'),
        apiKey: apiValue,
        baseURL: baseValue,
        models,
        defaultModel,
      };

      if (!firstProvider) {
        firstProvider = name;
        firstModel = defaultModel;
      }
    }

    const defaults = obj.defaults as Record<string, unknown> | undefined;
    return {
      providers,
      defaults: {
        provider: String(defaults?.provider ?? firstProvider),
        model: String(defaults?.model ?? firstModel),
        temperature: Number(defaults?.temperature ?? 0.7),
        maxTokens: Number(defaults?.maxTokens ?? 4096),
      },
    };
  } catch {
    return null;
  }
}

/**
 * Generate a unified diff preview between the old config and the new converted format.
 */
export function generateDiffPreview(oldPath: string, newContent: string): string {
  const oldRaw = existsSync(oldPath) ? readFileSync(oldPath, 'utf-8') : '';
  const oldLines = oldRaw.split('\n');
  const newLines = newContent.split('\n');

  const lines: string[] = [
    '--- a/config.yaml (old)',
    '+++ b/config.yaml (new)',
  ];

  const maxLen = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < maxLen; i++) {
    const o = oldLines[i] ?? '';
    const n = newLines[i] ?? '';
    if (o === n) {
      lines.push(`  ${o}`);
    } else {
      if (o) lines.push(`- ${o}`);
      if (n) lines.push(`+ ${n}`);
    }
  }

  return lines.join('\n');
}

export interface MigrateOptions {
  yes: boolean;
  configDir?: string;
  stderr?: (msg: string) => void;
}

/**
 * Attempt migration from legacy assistants.yaml to new config.yaml.
 * - If config.yaml already exists → no migration needed.
 * - If no assistants.yaml → nothing to migrate.
 * - Otherwise → generate preview, optionally write on --yes.
 */
export function tryMigrate(opts: MigrateOptions): { migrated: boolean; newConfigPath: string | null } {
  const configDir = opts.configDir ?? CONFIG_DIR;
  const newConfig = resolve(configDir, 'config.yaml');
  const oldConfig = resolve(configDir, 'assistants.yaml');

  const log = opts.stderr ?? ((msg: string) => process.stderr.write(msg + '\n'));

  // Already migrated
  if (existsSync(newConfig)) {
    return { migrated: false, newConfigPath: newConfig };
  }

  // Nothing to migrate
  if (!existsSync(oldConfig)) {
    return { migrated: false, newConfigPath: null };
  }

  if (!detectLegacyFormat(oldConfig)) {
    // File exists but not legacy format — just point to it
    return { migrated: false, newConfigPath: null };
  }

  const converted = convertLegacyFormat(oldConfig);
  if (!converted || !yaml) {
    return { migrated: false, newConfigPath: null };
  }

  const newContent = yaml.stringify({
    providers: converted.providers,
    defaults: converted.defaults,
  });

  // Generate and show diff preview
  const preview = generateDiffPreview(oldConfig, newContent);
  log('=== Config Migration Preview ===');
  log(preview);
  log('=== End Preview ===');

  if (opts.yes) {
    writeFileSync(newConfig, newContent, 'utf-8');
    log(`Migrated config written to ${newConfig}`);
    return { migrated: true, newConfigPath: newConfig };
  }

  log('Migration not applied (use --yes to apply). Engine will read legacy config directly.');
  return { migrated: false, newConfigPath: null };
}
