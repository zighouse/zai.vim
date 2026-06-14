// @zaivim/gateway — HTTP gateway integration tests (Story 4.3 Task 5)
//
// Spins up the gateway on an OS-assigned port, then uses node:http to issue
// real requests. Covers AC1 (/health), AC2 (/jsonrpc), AC4 (non-localhost
// auth), and AC7 (max payload 413).

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { get, request, type RequestOptions } from 'node:http';
import { HandlerRegistry } from '../handler-registry.js';
import { createHttpGateway, DEFAULT_MAX_PAYLOAD_BYTES } from '../http.js';
import { MethodACL } from '../method-acl.js';
import { TransportContext } from '../stdio/transport-context.js';
import { EventBus, ClientManager } from '@zaivim/engine';
import type { EngineAPI } from '@zaivim/core';

function createMockEngine(): EngineAPI {
  return {
    version: '0.1.0-test',
    getHealth: vi.fn().mockReturnValue({
      status: 'ok',
      sandboxAvailable: true,
      activeSessions: 2,
    }),
    uptime: 1234,
    createSession: vi.fn().mockResolvedValue({ id: 'sess-x', status: 'active', createdAt: 1 }),
    listSessions: vi.fn().mockReturnValue([]),
    getSession: vi.fn().mockReturnValue(undefined),
    closeSession: vi.fn().mockResolvedValue(undefined),
    pushSessionMessage: vi.fn(),
    createAgent: vi.fn(),
    destroy: vi.fn().mockResolvedValue(undefined),
  } as unknown as EngineAPI;
}

function buildRegistry(engine: EngineAPI, acl?: MethodACL) {
  if (acl) {
    return new HandlerRegistry(engine, undefined, undefined, acl);
  }
  const eventBus = new EventBus();
  const clientManager = new ClientManager(eventBus);
  const transportContext = new TransportContext({ eventBus, clientManager });
  return new HandlerRegistry(engine, undefined, transportContext);
}

function jsonGet(port: number, path: string, headers?: Record<string, string>): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const opts: RequestOptions = { host: '127.0.0.1', port, path, method: 'GET', headers: headers ?? {} };
    const req = get(opts, (res) => {
      let body = '';
      res.setEncoding('utf-8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
  });
}

function jsonPost(
  port: number,
  path: string,
  payload: string | Buffer,
  headers?: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const bodyBuf = typeof payload === 'string' ? Buffer.from(payload, 'utf-8') : payload;
    const opts: RequestOptions = {
      host: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(bodyBuf.length),
        ...(headers ?? {}),
      },
    };
    const req = request(opts, (res) => {
      let body = '';
      res.setEncoding('utf-8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end(bodyBuf);
  });
}

describe('HTTP gateway', () => {
  let engine: EngineAPI;
  let registry: HandlerRegistry;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let gateways: Array<{ close: () => Promise<void> }>;

  beforeEach(() => {
    engine = createMockEngine();
    registry = buildRegistry(engine);
    gateways = [];
  });

  afterEach(async () => {
    for (const g of gateways) {
      await g.close();
    }
  });

  it('AC1: GET /health returns 200 with the same body as the JSON-RPC health handler', async () => {
    const gateway = createHttpGateway({
      port: 0,
      handlerRegistry: registry,
      engine,
      adminToken: 'admin-key',
    });
    gateways.push(gateway);
    await gateway.started;

    const res = await jsonGet(gateway.port, '/health');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');

    const body = JSON.parse(res.body);
    expect(body.status).toBe('ok');
    expect(body.version).toBe('0.1.0-test');
    expect(body.sandboxAvailable).toBe(true);
    expect(body.activeSessions).toBe(2);
  });

  it('AC2: POST /jsonrpc dispatches through the shared handler registry', async () => {
    const gateway = createHttpGateway({
      port: 0,
      handlerRegistry: registry,
      engine,
      adminToken: 'admin-key',
    });
    gateways.push(gateway);
    await gateway.started;

    const res = await jsonPost(
      gateway.port,
      '/jsonrpc',
      JSON.stringify({ jsonrpc: '2.0', method: 'health', id: 1 }),
    );
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBe(1);
    expect(body.result.status).toBe('ok');
  });

  it('AC2: POST /jsonrpc returns method_not_found for unknown methods', async () => {
    const gateway = createHttpGateway({
      port: 0,
      handlerRegistry: registry,
      engine,
      adminToken: 'admin-key',
    });
    gateways.push(gateway);
    await gateway.started;

    const res = await jsonPost(
      gateway.port,
      '/jsonrpc',
      JSON.stringify({ jsonrpc: '2.0', method: 'nope', id: 5 }),
    );
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe(-32601);
  });

  it('AC2: POST /jsonrpc serialises handler errors as internal_error', async () => {
    // Build a registry without an ACL so the dispatch reaches the handler
    // (default ACL marks session.get as session-scoped → would 401 first).
    const registryNoAcl = new HandlerRegistry(engine);
    const gateway = createHttpGateway({
      port: 0,
      handlerRegistry: registryNoAcl,
      engine,
      adminToken: 'admin-key',
    });
    gateways.push(gateway);
    await gateway.started;

    const res = await jsonPost(
      gateway.port,
      '/jsonrpc',
      JSON.stringify({ jsonrpc: '2.0', method: 'session.get', params: { sessionId: 'missing' }, id: 9 }),
    );
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe(-32603);
    expect(body.error.message).toContain('Session not found');
  });

  it('AC7: requests above maxPayload return 413', async () => {
    const gateway = createHttpGateway({
      port: 0,
      handlerRegistry: registry,
      engine,
      adminToken: 'admin-key',
      maxPayloadBytes: 16,
    });
    gateways.push(gateway);
    await gateway.started;

    const oversize = Buffer.alloc(2048, 0x61 /* 'a' */);
    const res = await jsonPost(
      gateway.port,
      '/jsonrpc',
      oversize,
      { 'Content-Type': 'application/json' },
    );
    expect(res.status).toBe(413);
  });

  it('default maxPayload is 10 MiB', () => {
    expect(DEFAULT_MAX_PAYLOAD_BYTES).toBe(10 * 1024 * 1024);
  });

  it('AC4: non-localhost without Bearer token returns 401', async () => {
    const gateway = createHttpGateway({
      port: 0,
      handlerRegistry: registry,
      engine,
      adminToken: 'correct-key',
      enforceAuthAlways: true, // simulate non-localhost
    });
    gateways.push(gateway);
    await gateway.started;

    const res = await jsonGet(gateway.port, '/health');
    expect(res.status).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('-32001');
    expect(body.error.message).toContain('Unauthorized');
  });

  it('AC4: non-localhost with wrong Bearer token returns 401', async () => {
    const gateway = createHttpGateway({
      port: 0,
      handlerRegistry: registry,
      engine,
      adminToken: 'correct-key',
      enforceAuthAlways: true,
    });
    gateways.push(gateway);
    await gateway.started;

    const res = await jsonGet(gateway.port, '/health', { Authorization: 'Bearer wrong' });
    expect(res.status).toBe(401);
  });

  it('AC4: non-localhost with correct Bearer token passes', async () => {
    const gateway = createHttpGateway({
      port: 0,
      handlerRegistry: registry,
      engine,
      adminToken: 'correct-key',
      enforceAuthAlways: true,
    });
    gateways.push(gateway);
    await gateway.started;

    const res = await jsonGet(gateway.port, '/health', { Authorization: 'Bearer correct-key' });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).status).toBe('ok');
  });

  it('ACL still applies to JSON-RPC over HTTP', async () => {
    const acl = MethodACL.createDefault();
    const registryWithAcl = new HandlerRegistry(engine, undefined, undefined, acl);
    const gateway = createHttpGateway({
      port: 0,
      handlerRegistry: registryWithAcl,
      engine,
      adminToken: 'admin-key',
    });
    gateways.push(gateway);
    await gateway.started;

    const res = await jsonPost(
      gateway.port,
      '/jsonrpc',
      JSON.stringify({ jsonrpc: '2.0', method: 'audit.query', id: 1 }),
    );
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe(-32001);
  });

  it('returns 404 for unknown paths', async () => {
    const gateway = createHttpGateway({
      port: 0,
      handlerRegistry: registry,
      engine,
      adminToken: 'admin-key',
    });
    gateways.push(gateway);
    await gateway.started;

    const res = await jsonGet(gateway.port, '/unknown');
    expect(res.status).toBe(404);
  });

  it('returns parse error for malformed JSON body', async () => {
    const gateway = createHttpGateway({
      port: 0,
      handlerRegistry: registry,
      engine,
      adminToken: 'admin-key',
    });
    gateways.push(gateway);
    await gateway.started;

    const res = await jsonPost(gateway.port, '/jsonrpc', 'not-json');
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe(-32700);
  });
});
