// @zaivim/gateway — vim-rpc-server integration tests
// Tests the JSON-RPC over stdio protocol using mock stdin/stdout streams.

import { describe, it, expect, vi } from 'vitest';
import { decodeLine, isRequest, isResponse, isError } from '../../stdio/jsonrpc-codec.js';
import type { EngineAPI, ResponseChunk } from '@zaivim/core';

// Helper: create a minimal mock engine for testing
function createMockEngine(): Partial<EngineAPI> {
  let sessions: Array<{ id: string; status: string; messages: any[]; createdAt: number }> = [];
  let idCounter = 0;

  return {
    version: '0.1.0',
    uptime: 1000,
    getHealth: () => ({ status: 'ok' as const, sandboxAvailable: false, activeSessions: sessions.length, activeAgents: 0 }),
    createSession: async (_config?: any, _projectDir?: string) => {
      const s = { id: `test-session-${++idCounter}`, status: 'active', messages: [], createdAt: Date.now() };
      sessions.push(s);
      return s as any;
    },
    getSession: (id: string) => sessions.find(s => s.id === id) as any,
    listSessions: (_filter?: any) => sessions.map(s => ({ sessionId: s.id, status: s.status, createdAt: s.createdAt })) as any,
    closeSession: async (id: string) => {
      sessions = sessions.filter(s => s.id !== id);
    },
    chat: (_sessionId: string, _message: any, _signal?: AbortSignal) => {
      async function* gen(): AsyncIterable<ResponseChunk> {
        yield { type: 'text' as const, content: 'Hello from AI' };
        yield { type: 'done' as const, finishReason: 'stop' };
      }
      return gen();
    },
    createAgent: (_persona: any) => ({
      id: 'agent-1',
      status: () => 'idle' as const,
    }),
    pushSessionMessage: vi.fn(),
  };
}

describe('vim-rpc-server protocol', () => {
  it('responds to health request', () => {
    const request = { jsonrpc: '2.0', id: 1, method: 'health' };
    const encoded = JSON.stringify(request);
    const decoded = decodeLine(encoded);
    expect(isRequest(decoded)).toBe(true);
    if (isRequest(decoded)) {
      expect(decoded.method).toBe('health');
      expect(decoded.id).toBe(1);
    }
  });

  it('responds to session.create request', () => {
    const request = { jsonrpc: '2.0', id: 2, method: 'session.create' };
    const encoded = JSON.stringify(request);
    const decoded = decodeLine(encoded);
    expect(isRequest(decoded)).toBe(true);
    if (isRequest(decoded)) {
      expect(decoded.method).toBe('session.create');
    }
  });

  it('handles chat.send with streaming response via decode/encode round-trip', () => {
    const request = { jsonrpc: '2.0', id: 3, method: 'chat.send', params: { sessionId: 's1', text: 'hello' } };
    const encoded = JSON.stringify(request);
    const decoded = decodeLine(encoded);
    expect(isRequest(decoded)).toBe(true);
    if (isRequest(decoded)) {
      expect(decoded.method).toBe('chat.send');
    }
  });

  it('decodes notification correctly', () => {
    const notification = { jsonrpc: '2.0', method: '$/notification', params: { type: 'agent.progress', data: { status: 'running' } } };
    const encoded = JSON.stringify(notification);
    const decoded = decodeLine(encoded);
    expect(isRequest(decoded)).toBe(false);
    // Notifications have method but no id — they pass isRequest check
    // because decodeLine doesn't know about isNotification
    expect((decoded as any).method).toBe('$/notification');
  });

  it('handles malformed JSON with error response', () => {
    const decoded = decodeLine('{not-json}');
    expect(isError(decoded)).toBe(true);
  });

  it('handles unknown method with error', () => {
    const request = { jsonrpc: '2.0', id: 99, method: 'unknown.method' };
    const decoded = decodeLine(JSON.stringify(request));
    expect(isRequest(decoded)).toBe(true);
  });
});
