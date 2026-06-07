// =============================================================================
// @zaivim/engine — Config redaction tests (Story 1b.1 AC3)
// =============================================================================

import { describe, it, expect } from 'vitest';
import { redactSensitiveInfo } from '../config/redact.js';

describe('redactSensitiveInfo (Story 1b.1 AC3)', () => {
  it('redacts API key patterns', () => {
    const input = 'Provider deepseek returned 401: Invalid API key sk-abc123def456';
    const result = redactSensitiveInfo(input);
    expect(result).toBe('Provider deepseek returned 401: Invalid API key ***REDACTED***');
  });

  it('redacts api_key with underscore', () => {
    const input = 'api_key=sk-abc123def456';
    const result = redactSensitiveInfo(input);
    expect(result).toBe('api_key=***REDACTED***');
  });

  it('redacts token patterns', () => {
    const input = 'Authorization: token ghp_abcdef123456';
    const result = redactSensitiveInfo(input);
    expect(result).toBe('Authorization: token ***REDACTED***');
  });

  it('redacts password patterns', () => {
    const input = 'password=mySecretPass123';
    const result = redactSensitiveInfo(input);
    expect(result).toBe('password=***REDACTED***');
  });

  it('handles multiple patterns in one string', () => {
    const input = 'apiKey=sk-abc token=ghp_123 password=pass';
    const result = redactSensitiveInfo(input);
    expect(result).toBe('apiKey=***REDACTED*** token=***REDACTED*** password=***REDACTED***');
  });

  it('preserves label and separator', () => {
    const input = 'Api-Key: sk-abc123';
    const result = redactSensitiveInfo(input);
    expect(result).toBe('Api-Key: ***REDACTED***');
  });

  it('handles case-insensitive matching', () => {
    const input = 'API KEY = sk-test';
    const result = redactSensitiveInfo(input);
    expect(result).toBe('API KEY = ***REDACTED***');
  });

  it('returns unchanged string when no matches', () => {
    const input = 'Provider returned 200: OK';
    const result = redactSensitiveInfo(input);
    expect(result).toBe(input);
  });
});
