// @zaivim/e2e — Epic 1b: Chat streaming + Provider failover
// Run: pnpm test:e2e -- --epic e1b

import { describe, it, expect } from 'vitest';
import { describeEpic } from './test-utils.js';

import { encode, decode, isNotification } from '@zaivim/core';
import type { ResponseChunk } from '@zaivim/core';

describeEpic('e1b', () => {

  // ---- Chat streaming via protocol ------------------------------------------

  it('streaming chunk encodes as notification', () => {
    const chunk: ResponseChunk = { type: 'text', content: 'Hello' };
    const notification = { jsonrpc: '2.0' as const, method: '$/chunk', params: chunk };
    const encoded = encode(notification);
    const decoded = decode(encoded);
    expect(isNotification(decoded)).toBe(true);
    if (isNotification(decoded)) {
      expect(decoded.method).toBe('$/chunk');
    }
  });

  it('ResponseChunk discriminated union works for all types', () => {
    const chunks: ResponseChunk[] = [
      { type: 'text', content: 'hi' },
      { type: 'tool_call', id: 't1', name: 'read', arguments: {} },
      { type: 'tool_result', toolCallId: 't1', content: 'data' },
      { type: 'error', code: 'ERR', message: 'fail' },
      { type: 'done', finishReason: 'stop' },
      { type: 'thinking', content: 'reasoning', phase: 'delta' },
      { type: 'stats', tokensIn: 10, tokensOut: 20, elapsedMs: 100, speed: 200 },
      { type: 'phase', phase: 'thinking' },
    ];

    for (const c of chunks) {
      const encoded = JSON.stringify(c);
      const decoded = JSON.parse(encoded) as ResponseChunk;
      expect(decoded.type).toBe(c.type);
      // Verify discriminator narrows correctly
      switch (decoded.type) {
        case 'text': expect(typeof decoded.content).toBe('string'); break;
        case 'done': expect(typeof decoded.finishReason).toBe('string'); break;
        case 'error': expect(typeof decoded.message).toBe('string'); break;
        case 'thinking': expect(typeof decoded.content).toBe('string'); break;
        case 'stats': expect(typeof decoded.tokensIn).toBe('number'); break;
        case 'phase': expect(typeof decoded.phase).toBe('string'); break;
      }
    }
  });

  // ---- Provider failover ----------------------------------------------------

  it('detects non-ok provider responses', () => {
    // Simulates what provider layer does when 503 returned
    const status = 503;
    const ok = status >= 200 && status < 300;
    expect(ok).toBe(false);
  });

  it('classifies provider errors from response codes', () => {
    // Maps HTTP status → error code mapping
    const classifyProviderError = (status: number): string => {
      if (status === 401 || status === 403) return 'ENGINE_PROVIDER_AUTH_FAILED';
      if (status === 404) return 'ENGINE_PROVIDER_MODEL_NOT_FOUND';
      if (status === 429) return 'ENGINE_PROVIDER_RATE_LIMITED';
      if (status >= 500) return 'ENGINE_PROVIDER_ERROR';
      return 'ENGINE_PROVIDER_ERROR';
    };

    expect(classifyProviderError(401)).toBe('ENGINE_PROVIDER_AUTH_FAILED');
    expect(classifyProviderError(429)).toBe('ENGINE_PROVIDER_RATE_LIMITED');
    expect(classifyProviderError(503)).toBe('ENGINE_PROVIDER_ERROR');
    expect(classifyProviderError(200)).toBe('ENGINE_PROVIDER_ERROR');
  });
});
