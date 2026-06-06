// =============================================================================
// @zaivim/engine — Config migrator tests
// detectLegacyFormat, generateDiffPreview, tryMigrate
// =============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { detectLegacyFormat, generateDiffPreview, tryMigrate } from '../config/config-migrator.js';

let tempDir: string;

beforeEach(() => {
  tempDir = resolve(tmpdir(), `zai-config-migrator-test-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ---- detectLegacyFormat ----

describe('detectLegacyFormat', () => {
  it('detects services top-level key', () => {
    const file = resolve(tempDir, 'assistants.yaml');
    writeFileSync(file, 'services:\n  deepseek:\n    api_key: test\n');
    expect(detectLegacyFormat(file)).toBe(true);
  });

  it('detects assistants top-level key', () => {
    const file = resolve(tempDir, 'assistants.yaml');
    writeFileSync(file, 'assistants:\n  deepseek:\n    api_key: test\n');
    expect(detectLegacyFormat(file)).toBe(true);
  });

  it('returns false for new format config', () => {
    const file = resolve(tempDir, 'config.yaml');
    writeFileSync(file, 'providers:\n  deepseek:\n    api_key: test\n');
    expect(detectLegacyFormat(file)).toBe(false);
  });

  it('returns false for non-existent file', () => {
    expect(detectLegacyFormat('/nonexistent/file.yaml')).toBe(false);
  });

  it('returns false for empty file', () => {
    const file = resolve(tempDir, 'empty.yaml');
    writeFileSync(file, '');
    expect(detectLegacyFormat(file)).toBe(false);
  });
});

// ---- generateDiffPreview ----

describe('generateDiffPreview', () => {
  it('generates diff header', () => {
    const preview = generateDiffPreview('/dummy/old.yaml', 'providers:\n  test:\n');
    expect(preview).toContain('--- a/config.yaml (old)');
    expect(preview).toContain('+++ b/config.yaml (new)');
  });

  it('marks added lines with +', () => {
    const file = resolve(tempDir, 'old.yaml');
    writeFileSync(file, 'old: content\n');
    const preview = generateDiffPreview(file, 'new: content\n');
    expect(preview).toContain('- old: content');
    expect(preview).toContain('+ new: content');
  });

  it('marks unchanged lines with space', () => {
    const file = resolve(tempDir, 'old.yaml');
    writeFileSync(file, 'same: content\n');
    const preview = generateDiffPreview(file, 'same: content\n');
    expect(preview).toContain('  same: content');
  });
});

// ---- tryMigrate ----

describe('tryMigrate', () => {
  it('returns false if config.yaml already exists', () => {
    const newConfig = resolve(tempDir, 'config.yaml');
    writeFileSync(newConfig, 'providers: {}\n');
    const result = tryMigrate({ yes: true, configDir: tempDir });
    expect(result.migrated).toBe(false);
    expect(result.newConfigPath).toBe(newConfig);
  });

  it('returns false if no assistants.yaml exists', () => {
    const result = tryMigrate({ yes: true, configDir: tempDir });
    expect(result.migrated).toBe(false);
    expect(result.newConfigPath).toBeNull();
  });

  it('migrates on --yes and writes config.yaml', () => {
    const oldConfig = resolve(tempDir, 'assistants.yaml');
    writeFileSync(oldConfig, [
      'services:',
      '  deepseek:',
      '    type: openai',
      '    api_key: sk-test',
      '    base_url: https://api.deepseek.com',
      '    models:',
      '      - deepseek-v3',
      '    default_model: deepseek-v3',
    ].join('\n'));

    const logs: string[] = [];
    const result = tryMigrate({
      yes: true,
      configDir: tempDir,
      stderr: (msg) => logs.push(msg),
    });

    expect(result.migrated).toBe(true);
    expect(result.newConfigPath).toBe(resolve(tempDir, 'config.yaml'));
    expect(existsSync(resolve(tempDir, 'config.yaml'))).toBe(true);
    expect(logs.some((l) => l.includes('Migrated'))).toBe(true);
  });

  it('does not write without --yes', () => {
    const oldConfig = resolve(tempDir, 'assistants.yaml');
    writeFileSync(oldConfig, [
      'services:',
      '  deepseek:',
      '    api_key: sk-test',
    ].join('\n'));

    const result = tryMigrate({ yes: false, configDir: tempDir });
    expect(result.migrated).toBe(false);
    expect(existsSync(resolve(tempDir, 'config.yaml'))).toBe(false);
  });

  it('returns false for non-legacy format', () => {
    const oldConfig = resolve(tempDir, 'assistants.yaml');
    writeFileSync(oldConfig, 'providers:\n  test:\n    api_key: x\n');

    const result = tryMigrate({ yes: true, configDir: tempDir });
    expect(result.migrated).toBe(false);
  });
});
