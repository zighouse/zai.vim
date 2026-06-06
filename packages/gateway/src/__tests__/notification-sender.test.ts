// @zaivim/gateway — Notification sender unit tests
// Tests: $/notification encoding, chat chunk encoding

import { describe, it, expect } from 'vitest';
import { encodeNotification, encodeChatChunk } from '../stdio/notification-sender.js';

describe('encodeNotification', () => {
  it('encodes a session.created notification correctly', () => {
    const result = encodeNotification('session.created', { sessionId: 'sess-abc-123' });
    const parsed = JSON.parse(result);

    expect(parsed.jsonrpc).toBe('2.0');
    expect(parsed.method).toBe('$/notification');
    expect(parsed.params).toEqual({
      type: 'session.created',
      data: { sessionId: 'sess-abc-123' },
    });
    // JSON-RPC notification must not have an 'id' field
    expect(parsed.id).toBeUndefined();
  });

  it('encodes a session.closed notification correctly', () => {
    const result = encodeNotification('session.closed', { sessionId: 'sess-xyz', reason: 'user_disconnect' });
    const parsed = JSON.parse(result);

    expect(parsed.jsonrpc).toBe('2.0');
    expect(parsed.method).toBe('$/notification');
    expect(parsed.params.type).toBe('session.closed');
    expect(parsed.params.data.reason).toBe('user_disconnect');
    expect(parsed.id).toBeUndefined();
  });

  it('encodes a security.degraded notification correctly', () => {
    const result = encodeNotification('security.degraded', {
      reason: 'Sandbox unavailable',
      implications: ['No code execution', 'No file access'],
    });
    const parsed = JSON.parse(result);

    expect(parsed.jsonrpc).toBe('2.0');
    expect(parsed.method).toBe('$/notification');
    expect(parsed.params.type).toBe('security.degraded');
    expect(parsed.params.data.implications).toHaveLength(2);
    expect(parsed.id).toBeUndefined();
  });

  it('encodes an engine.warning notification correctly', () => {
    const result = encodeNotification('engine.warning', {
      message: 'High memory usage',
    });
    const parsed = JSON.parse(result);

    expect(parsed.jsonrpc).toBe('2.0');
    expect(parsed.method).toBe('$/notification');
    expect(parsed.params.type).toBe('engine.warning');
    expect(parsed.params.data.message).toBe('High memory usage');
    expect(parsed.id).toBeUndefined();
  });

  it('produces a single line with newline terminator', () => {
    const result = encodeNotification('engine.shutdown', { reason: 'manual', force: false });
    // Should end with newline
    expect(result.endsWith('\n')).toBe(true);
    // Should be exactly one line
    expect(result.split('\n').length).toBe(2); // one line + trailing newline = 2 elements
  });

  it('output is valid JSON', () => {
    const result = encodeNotification('session.created', { sessionId: 'test' });
    expect(() => JSON.parse(result)).not.toThrow();
  });
});

describe('encodeChatChunk', () => {
  it('encodes a chat chunk notification correctly', () => {
    const result = encodeChatChunk({ content: 'Hello', index: 0 });
    const parsed = JSON.parse(result);

    expect(parsed.jsonrpc).toBe('2.0');
    expect(parsed.method).toBe('$/chat/chunk');
    expect(parsed.params).toEqual({ content: 'Hello', index: 0 });
    expect(parsed.id).toBeUndefined();
  });

  it('produces valid JSON with newline', () => {
    const result = encodeChatChunk({ content: 'World' });
    expect(() => JSON.parse(result)).not.toThrow();
    expect(result.endsWith('\n')).toBe(true);
  });
});
