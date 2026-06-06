// =============================================================================
// @zaivim/engine — Config compatibility tests
// stripJsComments, normalizeModelField, normalizeConfigKeys
// =============================================================================

import { describe, it, expect } from 'vitest';
import { stripJsComments, normalizeModelField, normalizeConfigKeys } from '../config/config-compat.js';

// ---- stripJsComments ----

describe('stripJsComments', () => {
  it('strips single-line comments', () => {
    const input = 'key: value // this is a comment';
    expect(stripJsComments(input)).toBe('key: value ');
  });

  it('strips block comments', () => {
    const input = 'key: /* removed */ value';
    expect(stripJsComments(input)).toBe('key:  value');
  });

  it('preserves // inside string literals', () => {
    const input = 'url: "https://example.com/api" // comment';
    expect(stripJsComments(input)).toBe('url: "https://example.com/api" ');
  });

  it('preserves /* inside string literals', () => {
    const input = 'regex: "/a/*/g" /* block comment */';
    expect(stripJsComments(input)).toBe('regex: "/a/*/g" ');
  });

  it('handles empty string', () => {
    expect(stripJsComments('')).toBe('');
  });

  it('handles string with only comments', () => {
    expect(stripJsComments('// just a comment')).toBe('');
  });

  it('handles multi-line block comments', () => {
    const input = 'before /* line1\nline2\nline3 */ after';
    expect(stripJsComments(input)).toBe('before  after');
  });

  it('handles escaped quotes in strings', () => {
    const input = 'key: "value with \\" // not comment \\" end" // real comment';
    expect(stripJsComments(input)).toBe('key: "value with \\" // not comment \\" end" ');
  });

  it('preserves URLs with https://', () => {
    const input = 'base_url: https://api.deepseek.com // comment';
    const result = stripJsComments(input);
    expect(result).toContain('https://api.deepseek.com');
    expect(result).not.toContain('// comment');
  });

  it('preserves URLs with http://', () => {
    const input = 'url: http://localhost:8080/api/v1';
    const result = stripJsComments(input);
    expect(result).toContain('http://localhost:8080/api/v1');
  });

  it('preserves ws:// and other schemes', () => {
    const input = 'ws: ws://example.com/socket';
    const result = stripJsComments(input);
    expect(result).toContain('ws://example.com/socket');
  });
});

// ---- normalizeModelField ----

describe('normalizeModelField', () => {
  it('converts string to single-element array', () => {
    expect(normalizeModelField('deepseek-v3')).toEqual([{ name: 'deepseek-v3' }]);
  });

  it('converts array of strings', () => {
    expect(normalizeModelField(['model-a', 'model-b'])).toEqual([
      { name: 'model-a' },
      { name: 'model-b' },
    ]);
  });

  it('preserves array of objects', () => {
    const input = [{ name: 'deepseek-v3', maxTokens: 8192 }];
    expect(normalizeModelField(input)).toEqual(input);
  });

  it('handles mixed array (strings + objects)', () => {
    expect(normalizeModelField(['model-a', { name: 'model-b', maxTokens: 4096 }])).toEqual([
      { name: 'model-a' },
      { name: 'model-b', maxTokens: 4096 },
    ]);
  });

  it('returns empty array for null/undefined/number', () => {
    expect(normalizeModelField(null)).toEqual([]);
    expect(normalizeModelField(undefined)).toEqual([]);
    expect(normalizeModelField(42)).toEqual([]);
  });

  it('returns empty array for empty array input', () => {
    expect(normalizeModelField([])).toEqual([]);
  });
});

// ---- normalizeConfigKeys ----

describe('normalizeConfigKeys', () => {
  it('replaces hyphens with underscores in keys', () => {
    const input = { 'api-key': 'test', 'base-url': 'http://example.com' };
    expect(normalizeConfigKeys(input)).toEqual({
      api_key: 'test',
      base_url: 'http://example.com',
    });
  });

  it('recursively normalizes nested objects', () => {
    const input = {
      providers: {
        deepseek: { 'api-key': 'xxx', 'default-model': 'v3' },
      },
    };
    expect(normalizeConfigKeys(input)).toEqual({
      providers: {
        deepseek: { api_key: 'xxx', default_model: 'v3' },
      },
    });
  });

  it('handles arrays correctly', () => {
    const input = [{ 'api-key': 'a' }, { 'api-key': 'b' }];
    expect(normalizeConfigKeys(input)).toEqual([
      { api_key: 'a' },
      { api_key: 'b' },
    ]);
  });

  it('returns primitives unchanged', () => {
    expect(normalizeConfigKeys('hello')).toBe('hello');
    expect(normalizeConfigKeys(42)).toBe(42);
    expect(normalizeConfigKeys(null)).toBe(null);
    expect(normalizeConfigKeys(true)).toBe(true);
  });
});
