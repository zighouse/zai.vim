import { describe, it, expect } from 'vitest';
import { ZaiNetworkError } from '@zaivim/core';
import { classifyProviderError } from '../error-classifier.js';

function makeError(statusCode: number, message: string, detail?: unknown): ZaiNetworkError {
  return new ZaiNetworkError(message, 'ENGINE_PROVIDER_ERROR', statusCode, detail);
}

describe('classifyProviderError', () => {
  describe('non-recoverable errors', () => {
    it('should classify 401 as non-recoverable with AUTH_FAILED code', () => {
      const result = classifyProviderError(makeError(401, 'Invalid API key'));
      expect(result.recoverable).toBe(false);
      expect(result.code).toBe('ENGINE_PROVIDER_AUTH_FAILED');
    });

    it('should classify 403 as non-recoverable with AUTH_FAILED code', () => {
      const result = classifyProviderError(makeError(403, 'Forbidden'));
      expect(result.recoverable).toBe(false);
      expect(result.code).toBe('ENGINE_PROVIDER_AUTH_FAILED');
    });

    it('should classify 402 as non-recoverable (billing)', () => {
      const result = classifyProviderError(makeError(402, 'Insufficient credits'));
      expect(result.recoverable).toBe(false);
      expect(result.code).toBe('ENGINE_PROVIDER_ERROR');
    });

    it('should classify 404 as non-recoverable with MODEL_NOT_FOUND code', () => {
      const result = classifyProviderError(makeError(404, 'Model not found'));
      expect(result.recoverable).toBe(false);
      expect(result.code).toBe('ENGINE_PROVIDER_MODEL_NOT_FOUND');
    });

    it('should classify 400 as non-recoverable (bad request)', () => {
      const result = classifyProviderError(makeError(400, 'Invalid request format'));
      expect(result.recoverable).toBe(false);
      expect(result.code).toBe('ENGINE_PROVIDER_ERROR');
    });
  });

  describe('recoverable errors', () => {
    it('should classify 429 as recoverable with RATE_LIMITED code', () => {
      const result = classifyProviderError(makeError(429, 'Too many requests'));
      expect(result.recoverable).toBe(true);
      expect(result.code).toBe('ENGINE_PROVIDER_RATE_LIMITED');
    });

    it('should extract retryAfterMs from 429 error detail', () => {
      const result = classifyProviderError(makeError(429, 'Too many requests', { retryAfterMs: 2000 }));
      expect(result.recoverable).toBe(true);
      expect(result.code).toBe('ENGINE_PROVIDER_RATE_LIMITED');
      expect(result.retryAfterMs).toBe(2000);
    });

    it('should return undefined retryAfterMs when no detail', () => {
      const result = classifyProviderError(makeError(429, 'Too many requests'));
      expect(result.retryAfterMs).toBeUndefined();
    });

    it('should classify 500 as recoverable (server error)', () => {
      const result = classifyProviderError(makeError(500, 'Internal server error'));
      expect(result.recoverable).toBe(true);
      expect(result.code).toBe('ENGINE_PROVIDER_ERROR');
    });

    it('should classify 503 as recoverable (service unavailable)', () => {
      const result = classifyProviderError(makeError(503, 'Service unavailable'));
      expect(result.recoverable).toBe(true);
      expect(result.code).toBe('ENGINE_PROVIDER_ERROR');
    });

    it('should classify 504 as recoverable (timeout)', () => {
      const result = classifyProviderError(makeError(504, 'Gateway timeout'));
      expect(result.recoverable).toBe(true);
      expect(result.code).toBe('ENGINE_PROVIDER_ERROR');
    });

    it('should classify context_length_exceeded as recoverable', () => {
      const result = classifyProviderError(
        makeError(400, 'context_length_exceeded: maximum context length exceeded'),
      );
      expect(result.recoverable).toBe(true);
      expect(result.code).toBe('PIPELINE_CONTEXT_LENGTH_EXCEEDED');
    });
  });

  describe('502 classification (Subtask 1.5 fix)', () => {
    it('should classify 502 as PIPELINE_PROVIDER_STREAM_INTERRUPTED, not generic 5xx', () => {
      const result = classifyProviderError(makeError(502, 'Bad gateway'));
      expect(result.recoverable).toBe(true);
      expect(result.code).toBe('PIPELINE_PROVIDER_STREAM_INTERRUPTED');
    });
  });

  describe('network-level errors', () => {
    it('should classify ECONNRESET as stream interrupted', () => {
      const result = classifyProviderError(makeError(502, 'ECONNRESET: connection reset'));
      expect(result.recoverable).toBe(true);
      expect(result.code).toBe('PIPELINE_PROVIDER_STREAM_INTERRUPTED');
    });

    it('should classify ETIMEDOUT as stream interrupted', () => {
      const result = classifyProviderError(makeError(502, 'ETIMEDOUT: connection timed out'));
      expect(result.recoverable).toBe(true);
      expect(result.code).toBe('PIPELINE_PROVIDER_STREAM_INTERRUPTED');
    });
  });
});
