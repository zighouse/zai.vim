// =============================================================================
// @zaivim/engine — Config backup and recovery tests
// createConfigBackup, restoreFromBackup, getDefaultConfig
// =============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createConfigBackup, restoreFromBackup, getDefaultConfig } from '../config/config-backup.js';

let tempDir: string;

beforeEach(() => {
  tempDir = resolve(tmpdir(), `zai-config-backup-test-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ---- createConfigBackup ----

describe('createConfigBackup', () => {
  it('creates .backup file', () => {
    const config = resolve(tempDir, 'config.yaml');
    writeFileSync(config, 'providers: {}\n');

    createConfigBackup(config);
    expect(existsSync(resolve(tempDir, 'config.yaml.backup'))).toBe(true);
    expect(readFileSync(resolve(tempDir, 'config.yaml.backup'), 'utf-8')).toBe('providers: {}\n');
  });

  it('creates .timestamp.bak history file', () => {
    const config = resolve(tempDir, 'config.yaml');
    writeFileSync(config, 'test: 1\n');

    createConfigBackup(config);
    const files = require('node:fs').readdirSync(tempDir);
    const bakFiles = files.filter((f: string) => f.endsWith('.bak'));
    expect(bakFiles.length).toBeGreaterThanOrEqual(1);
  });

  it('does nothing if file does not exist', () => {
    const config = resolve(tempDir, 'nonexistent.yaml');
    createConfigBackup(config); // should not throw
    expect(existsSync(resolve(tempDir, 'nonexistent.yaml.backup'))).toBe(false);
  });

  it('prunes history backups beyond 3', () => {
    const config = resolve(tempDir, 'config.yaml');
    // Create 5 backups
    for (let i = 0; i < 5; i++) {
      writeFileSync(config, `version: ${i}\n`);
      createConfigBackup(config);
    }

    const files = require('node:fs').readdirSync(tempDir);
    const bakFiles = files.filter((f: string) => f.match(/\.bak$/));
    expect(bakFiles.length).toBeLessThanOrEqual(3);
  });
});

// ---- restoreFromBackup ----

describe('restoreFromBackup', () => {
  it('restores from .backup file', () => {
    const config = resolve(tempDir, 'config.yaml');
    const backup = resolve(tempDir, 'config.yaml.backup');

    writeFileSync(backup, 'providers:\n  restored: true\n');
    writeFileSync(config, 'corrupted: {{{\n');

    const logs: string[] = [];
    const result = restoreFromBackup(config, (msg) => logs.push(msg));

    expect(result).toBe(config);
    expect(readFileSync(config, 'utf-8')).toContain('restored: true');
    expect(logs.some((l) => l.includes('corrupted'))).toBe(true);
  });

  it('restores from history .bak file when .backup is corrupted', () => {
    const config = resolve(tempDir, 'config.yaml');
    const backup = resolve(tempDir, 'config.yaml.backup');
    const histBak = resolve(tempDir, 'config.yaml.2026-01-15T10-30-00-000Z.bak');

    writeFileSync(backup, 'corrupted: {{{\n');
    writeFileSync(histBak, 'providers:\n  from_history: true\n');
    writeFileSync(config, 'corrupted: {{{\n');

    const result = restoreFromBackup(config);
    expect(result).toBe(config);
    expect(readFileSync(config, 'utf-8')).toContain('from_history: true');
  });

  it('returns null when no valid backup exists', () => {
    const config = resolve(tempDir, 'config.yaml');
    writeFileSync(config, 'corrupted: {{{\n');

    const result = restoreFromBackup(config);
    expect(result).toBeNull();
  });
});

// ---- getDefaultConfig ----

describe('getDefaultConfig', () => {
  it('returns valid default config structure', () => {
    const config = getDefaultConfig();
    expect(config).toHaveProperty('language');
    expect(config).toHaveProperty('sandbox');
    expect(config).toHaveProperty('providers');
    expect(config).toHaveProperty('defaults');
    expect((config.defaults as Record<string, unknown>).temperature).toBe(0.7);
  });
});
