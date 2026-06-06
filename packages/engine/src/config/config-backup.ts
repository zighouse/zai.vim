// @zaivim/engine — Config backup and recovery
// Creates backups on successful load, restores from backup on corruption, falls back to defaults

import { existsSync, readFileSync, writeFileSync, readdirSync, copyFileSync, unlinkSync } from 'node:fs';
import { resolve, basename } from 'node:path';

const MAX_HISTORY_BACKUPS = 3;

/**
 * Create a config backup after successful load.
 * - config.yaml.backup: latest backup (fast recovery)
 * - config.yaml.{timestamp}.bak: history backup (keep last N)
 */
export function createConfigBackup(configPath: string, logger?: (msg: string) => void): void {
  if (!existsSync(configPath)) return;

  const dir = resolve(configPath, '..');
  const base = basename(configPath);

  // Latest backup
  const latestBackup = resolve(dir, `${base}.backup`);
  try {
    copyFileSync(configPath, latestBackup);
  } catch (err) {
    logger?.(`Warning: failed to create latest backup: ${String(err)}`);
    return;
  }

  // History backup with timestamp
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const historyBackup = resolve(dir, `${base}.${timestamp}.bak`);
  try {
    copyFileSync(configPath, historyBackup);
  } catch (err) {
    logger?.(`Warning: failed to create history backup: ${String(err)}`);
  }

  // Prune old history backups
  pruneHistoryBackups(dir, base, logger);
}

function pruneHistoryBackups(dir: string, base: string, logger?: (msg: string) => void): void {
  const pattern = new RegExp(`^${escapeRegex(base)}\\.\\d{4}-\\d{2}-\\d{2}T[\\d-]+Z?\\.bak$`);
  try {
    const files = readdirSync(dir)
      .filter((f) => pattern.test(f))
      .sort()
      .reverse();

    // Keep only MAX_HISTORY_BACKUPS
    for (let i = MAX_HISTORY_BACKUPS; i < files.length; i++) {
      try {
        unlinkSync(resolve(dir, files[i]!));
      } catch {
        // ignore prune failures
      }
    }
  } catch {
    // ignore directory read failures
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Restore config from backup when main config is corrupted.
 * Tries: config.yaml.backup → most recent config.yaml.{timestamp}.bak
 */
export function restoreFromBackup(configPath: string, logger?: (msg: string) => void): string | null {
  const dir = resolve(configPath, '..');
  const base = basename(configPath);

  // Try latest backup first
  const latestBackup = resolve(dir, `${base}.backup`);
  if (existsSync(latestBackup)) {
    try {
      const content = readFileSync(latestBackup, 'utf-8');
      // Verify it's valid by attempting to parse
      if (isYamlValid(content)) {
        writeFileSync(configPath, content, 'utf-8');
        logger?.(`Warning: config.yaml corrupted, using backup from latest backup`);
        return configPath;
      }
    } catch {
      // backup is also corrupted, continue to history
    }
  }

  // Try history backups (newest first)
  const pattern = new RegExp(`^${escapeRegex(base)}\\.\\d{4}-\\d{2}-\\d{2}T[\\d-]+Z?\\.bak$`);
  try {
    const files = readdirSync(dir)
      .filter((f) => pattern.test(f))
      .sort()
      .reverse();

    for (const file of files) {
      try {
        const content = readFileSync(resolve(dir, file), 'utf-8');
        if (isYamlValid(content)) {
          writeFileSync(configPath, content, 'utf-8');
          // Extract timestamp from filename
          const tsMatch = file.match(/(\d{4}-\d{2}-\d{2}T[\d-]+)/);
          const ts = tsMatch ? tsMatch[1] : 'unknown';
          logger?.(`Warning: config.yaml corrupted, using backup from ${ts}`);
          return configPath;
        }
      } catch {
        continue;
      }
    }
  } catch {
    // directory read failure
  }

  return null;
}

function isYamlValid(content: string): boolean {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  let y: { parse: (s: string) => unknown } | undefined;
  try {
    y = require('yaml') as { parse: (s: string) => unknown };
  } catch {
    // If yaml is not installed, treat any non-empty content as valid
    return content.trim().length > 0;
  }
  try {
    y.parse(content);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get a copy of the DEFAULT_CONFIG for fallback.
 * Used when both config and backups are corrupted.
 */
export function getDefaultConfig(): Record<string, unknown> {
  return {
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
}
