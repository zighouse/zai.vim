import { describe, it, expect } from 'vitest';
import { ZaiNetworkError } from '@zaivim/core';
import { classifyProviderError } from '../error-classifier.js';

function makeError(statusCode: number, message: string): ZaiNetworkError {
  return new ZaiNetworkError(message, 'ENGINE_PROVIDER_ERROR', statusCode);
}

describe('classifyProviderError', () => {
  describe('non-recoverable errors', () => {
    it('should classify 401 as non-recoverable (auth failure)', () => {
      const result = classifyProviderError(makeError(401, 'Invalid API key'));
      expect(result.recoverable).toBe(false);
    });

    it('should classify 403 as non-recoverable (auth failure)', () => {
      const result = classifyProviderError(makeError(403, 'Forbidden'));
      expect(result.recoverable).toBe(false);
    });

    it('should classify 402 as non-recoverable (billing)', () => {
      const result = classifyProviderError(makeError(402, 'Insufficient credits'));
      expect(result.recoverable).toBe(false);
    });

    it('should classify 404 as non-recoverable (model not found)', () => {
      const result = classifyProviderError(makeError(404, 'Model not found'));
      expect(result.recoverable).toBe(false);
    });

    it('should classify 400 as non-recoverable (bad request)', () => {
      const result = classifyProviderError(makeError(400, 'Invalid request format'));
      expect(result.recoverable).toBe(false);
    });
  });

  describe('recoverable errors', () => {
    it('should classify 429 as recoverable (rate limit)', () => {
      const result = classifyProviderError(makeError(429, 'Too many requests'));
      expect(result.recoverable).toBe(true);
    });

    it('should classify 500 as recoverable (server error)', () => {
      const result = classifyProviderError(makeError(500, 'Internal server error'));
      expect(result.recoverable).toBe(true);
    });

    it('should classify 502 as recoverable (bad gateway)', () => {
      const result = classifyProviderError(makeError(502, 'Bad gateway'));
      expect(result.recoverable).toBe(true);
    });

    it('should classify 503 as recoverable (service unavailable)', () => {
      const result = classifyProviderError(makeError(503, 'Service unavailable'));
      expect(result.recoverable).toBe(true);
    });

    it('should classify 504 as recoverable (timeout)', () => {
      const result = classifyProviderError(makeError(504, 'Gateway timeout'));
      expect(result.recoverable).toBe(true);
    });

    it('should classify context_length_exceeded as recoverable', () => {
      const result = classifyProviderError(
        makeError(400, 'context_length_exceeded: maximum context length exceeded'),
      );
      expect(result.recoverable).toBe(true);
      expect(result.code).toBe('PIPELINE_CONTEXT_LENGTH_EXCEEDED');
    });
  });

  describe('network-level errors', () => {
    it('should classify ECONNRESET as recoverable', () => {
      const result = classifyProviderError(makeError(502, 'ECONNRESET: connection reset'));
      expect(result.recoverable).toBe(true);
    });

    it('should classify ETIMEDOUT as recoverable', () => {
      const result = classifyProviderError(makeError(502, 'ETIMEDOUT: connection timed out'));
      expect(result.recoverable).toBe(true);
    });
  });
});
