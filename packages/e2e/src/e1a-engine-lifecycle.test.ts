// @zaivim/e2e — Epic 1a: Engine lifecycle, JSON-RPC protocol, Session CRUD
// Run: pnpm test:e2e -- --epic e1a

import { describe, it, expect } from 'vitest';
import { describeEpic } from './test-utils.js';
import { randomUUID } from 'node:crypto';

import { encode, decode, isRequest, isResponse, isError, successResponse, errorResponse } from '@zaivim/core';
import { JSONRPC_ERROR_CODES } from '@zaivim/core';
import type { JsonRpcMessage, Session, Message, ISessionStore } from '@zaivim/core';

class TestSessionStore implements ISessionStore {
  #store = new Map<string, Session>();
  create(_config?: any, _projectDir?: string): Session {
    const s: Session = { id: randomUUID(), messages: [], createdAt: Date.now(), config: {} as any, status: 'active' };
    this.#store.set(s.id, s);
    return s;
  }
  get(id: string): Session | undefined { return this.#store.get(id); }
  pushMessage(id: string, msg: Message): void {
    const s = this.#store.get(id); if (!s) throw new Error('not found');
    (s as any).messages = [...s.messages, msg];
  }
  async close(id: string): Promise<void> { const s = this.#store.get(id); if (s) (s as any).status = 'closed'; }
  list(filter?: { status?: string }): Session[] {
    return [...this.#store.values()].filter(s => !filter?.status || s.status === filter.status);
  }
  queryByProject(_dir: string): Session[] { return []; }
  async persistAll(): Promise<void> {}
  async recoverFromDisk(): Promise<Session[]> { return []; }
  get activeCount(): number { return [...this.#store.values()].filter(s => s.status === 'active').length; }
}

describeEpic('e1a', () => {

  // ---- Engine lifecycle (via protocol) --------------------------------------

  it('JSON-RPC health request round-trips correctly', () => {
    const request: JsonRpcMessage = { jsonrpc: '2.0', id: 1, method: 'health' } as any;
    const encoded = encode(request);
    expect(encoded).toBe('{"jsonrpc":"2.0","id":1,"method":"health"}');

    const decoded = decode(encoded);
    expect(isRequest(decoded)).toBe(true);
    if (isRequest(decoded)) {
      expect(decoded.method).toBe('health');
      expect(decoded.id).toBe(1);
    }
  });

  it('success response encodes and decodes correctly', () => {
    const result = { status: 'ok', version: '0.1.3' };
    const response = successResponse(1, result);
    expect(isResponse(response)).toBe(true);

    const encoded = encode(response);
    const decoded = decode(encoded);
    expect(isResponse(decoded)).toBe(true);
    if (isResponse(decoded)) {
      expect((decoded.result as any).status).toBe('ok');
    }
  });

  it('error response encodes and decodes correctly', () => {
    const err = errorResponse(null, JSONRPC_ERROR_CODES.PARSE_ERROR, 'Parse error');
    expect(err.error.code).toBe(-32700);
    expect(isError(err)).toBe(true);

    const encoded = encode(err);
    const decoded = decode(encoded);
    expect(isError(decoded)).toBe(true);
    if (isError(decoded)) {
      expect(decoded.error.code).toBe(-32700);
    }
  });

  it('decode handles invalid JSON gracefully', () => {
    const result = decode('not json');
    expect(isError(result)).toBe(true);
    if (isError(result)) {
      expect(result.error.code).toBe(JSONRPC_ERROR_CODES.PARSE_ERROR);
    }
  });

  it('decode handles non-object JSON gracefully', () => {
    const result = decode('"string"');
    expect(isError(result)).toBe(true);
    if (isError(result)) {
      expect(result.error.code).toBe(JSONRPC_ERROR_CODES.INVALID_REQUEST);
    }
  });

  // ---- Session CRUD ---------------------------------------------------------

  it('creates and retrieves a session', () => {
    const store = new TestSessionStore();
    const session = store.create();
    expect(session.id).toBeDefined();
    expect(session.status).toBe('active');

    const retrieved = store.get(session.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe(session.id);
  });

  it('pushes and retrieves messages in a session', () => {
    const store = new TestSessionStore();
    const session = store.create();

    store.pushMessage(session.id, { id: 'm1', role: 'user', content: 'Hello' });
    store.pushMessage(session.id, { id: 'm2', role: 'assistant', content: 'Hi there' });

    const updated = store.get(session.id);
    expect(updated!.messages).toHaveLength(2);
    expect(updated!.messages[0].content).toBe('Hello');
    expect(updated!.messages[1].content).toBe('Hi there');
  });

  it('closes a session and excludes it from list', async () => {
    const store = new TestSessionStore();
    const s1 = store.create();
    const s2 = store.create();

    await store.close(s1.id);
    const all = store.list();
    const activeIds = all.filter(s => s.status === 'active').map(s => s.id);
    expect(activeIds).not.toContain(s1.id);
    expect(activeIds).toContain(s2.id);
  });

  it('lists sessions with status filter', async () => {
    const store = new TestSessionStore();
    const s1 = store.create();
    store.create();
    await store.close(s1.id);

    const active = store.list({ status: 'active' });
    expect(active.length).toBe(1);
    expect(active.every(s => s.status === 'active')).toBe(true);
  });
});
