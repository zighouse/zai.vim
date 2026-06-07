// =============================================================================
// @zaivim/core — ProviderConfig extensions and ProviderStatus type tests
// Story 1b.1 Task 1: AC1, AC2, AC5, AC8
// =============================================================================

import { describe, it, expect } from 'vitest';
import type { ProviderConfig, ProviderCapabilities, ProviderStatus } from '../types/index.js';
import { ZaiConfigError } from '../errors/index.js';

describe('ProviderConfig extensions (Story 1b.1 Task 1)', () => {
  it('ProviderConfig accepts status with untested value', () => {
    const config: ProviderConfig = {
      type: 'openai',
      apiKey: 'sk-test',
      baseURL: 'https://api.deepseek.com',
      models: ['deepseek-chat'],
      defaultModel: 'deepseek-chat',
      status: 'untested',
    };
    expect(config.status).toBe('untested');
  });

  it('ProviderConfig accepts all three status values', () => {
    const statuses: ProviderConfig['status'][] = ['available', 'unavailable', 'untested'];
    expect(statuses).toHaveLength(3);
    expect(statuses).toContain('untested');
  });

  it('ProviderConfig accepts protocol field', () => {
    const config: ProviderConfig = {
      type: 'openai',
      apiKey: 'sk-test',
      baseURL: 'https://api.deepseek.com',
      models: ['deepseek-chat'],
      defaultModel: 'deepseek-chat',
      protocol: 'openai-compatible',
    };
    expect(config.protocol).toBe('openai-compatible');
  });

  it('ProviderConfig accepts lastChecked field', () => {
    const now = Date.now();
    const config: ProviderConfig = {
      type: 'openai',
      apiKey: 'sk-test',
      baseURL: 'https://api.deepseek.com',
      models: ['deepseek-chat'],
      defaultModel: 'deepseek-chat',
      lastChecked: now,
    };
    expect(config.lastChecked).toBe(now);
  });

  it('ProviderConfig status is optional', () => {
    const config: ProviderConfig = {
      type: 'openai',
      apiKey: 'sk-test',
      baseURL: 'https://api.deepseek.com',
      models: ['deepseek-chat'],
      defaultModel: 'deepseek-chat',
    };
    expect(config.status).toBeUndefined();
  });

  it('ProviderConfig protocol is optional', () => {
    const config: ProviderConfig = {
      type: 'openai',
      apiKey: 'sk-test',
      baseURL: 'https://api.deepseek.com',
      models: ['deepseek-chat'],
      defaultModel: 'deepseek-chat',
    };
    expect(config.protocol).toBeUndefined();
  });
});

describe('ProviderStatus type (Story 1b.1 Task 1.3)', () => {
  it('ProviderStatus accepts all three literal values', () => {
    const available: ProviderStatus = 'available';
    const unavailable: ProviderStatus = 'unavailable';
    const untested: ProviderStatus = 'untested';
    expect([available, unavailable, untested]).toEqual(['available', 'unavailable', 'untested']);
  });
});

describe('ProviderCapabilities protocol field (Story 1b.1 Task 1.2)', () => {
  it('ProviderCapabilities accepts protocol field', () => {
    const caps: ProviderCapabilities = {
      streaming: true,
      toolUse: true,
      caching: false,
      thinking: false,
      vision: false,
      maxContextTokens: 128000,
      protocol: 'openai-compatible',
    };
    expect(caps.protocol).toBe('openai-compatible');
  });

  it('ProviderCapabilities accepts anthropic-native protocol', () => {
    const caps: ProviderCapabilities = {
      streaming: true,
      toolUse: true,
      caching: true,
      thinking: true,
      vision: true,
      maxContextTokens: 200000,
      protocol: 'anthropic-native',
    };
    expect(caps.protocol).toBe('anthropic-native');
  });

  it('ProviderCapabilities protocol is optional', () => {
    const caps: ProviderCapabilities = {
      streaming: true,
      toolUse: false,
      caching: false,
      thinking: false,
      vision: false,
      maxContextTokens: 32000,
    };
    expect(caps.protocol).toBeUndefined();
  });
});

describe('ZaiConfigError with provider context (Story 1b.1 Task 1.4)', () => {
  it('ZaiConfigError carries provider name and reason in detail', () => {
    const detail = { provider: 'deepseek', reason: 'API key not set (DEEPSEEK_API_KEY)' };
    const err = new ZaiConfigError("provider 'deepseek': API key not set", detail);
    expect(err.detail).toEqual(detail);
    expect(err.message).toContain('deepseek');
  });

  it('ZaiConfigError carries baseURL validation failure in detail', () => {
    const detail = { provider: 'glm', reason: 'invalid baseURL format' };
    const err = new ZaiConfigError('invalid provider config', detail);
    expect(err.detail).toEqual(detail);
  });
});
