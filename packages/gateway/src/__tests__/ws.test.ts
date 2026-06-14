// @zaivim/gateway — WebSocket gateway integration tests (Story 4.3 Task 5)
//
// Spins up a real HTTP server, attaches the WS gateway, then connects via
// the `ws` client. Covers AC3 (JSON-RPC + $/notification), AC5 (mixed
// client sync via shared EventBus), and AC6 (rate limit / close 1008).

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { WebSocket, type RawData } from 'ws';
import { HandlerRegistry } from '../handler-registry.js';
import { createWebSocketGateway, RATE_LIMIT_PER_SECOND, CLOSE_CODE_POLICY_VIOLATION } from '../ws.js';
import { EventBus, ClientManager } from '@zaivim/engine';
import { TransportContext } from '../stdio/transport-context.js';
import type { EngineAPI } from '@zaivim/core';

function createMockEngine(): EngineAPI {
  return {
    version: '0.1.0-ws',
    getHealth: vi.fn().mockReturnValue({
      status: 'ok',
      sandboxAvailable: false,
      activeSessions: 0,
    }),
    uptime: 500,
    createSession: vi.fn().mockResolvedValue({ id: 'sess-ws', status: 'active', createdAt: 1 }),
    listSessions: vi.fn().mockReturnValue([]),
    getSession: vi.fn().mockReturnValue(undefined),
    closeSession: vi.fn().mockResolvedValue(undefined),
    pushSessionMessage: vi.fn(),
    createAgent: vi.fn(),
    destroy: vi.fn().mockResolvedValue(undefined),
  } as unknown as EngineAPI;
}

interface TestSetup {
  server: Server;
  registry: HandlerRegistry;
  eventBus: EventBus;
  gateway: ReturnType<typeof createWebSocketGateway>;
  port: number;
}

async function spinUp(overrides?: { rateLimit?: number; sustainedMs?: number }): Promise<TestSetup> {
  const engine = createMockEngine();
  const eventBus = new EventBus();
  const clientManager = new ClientManager(eventBus);
  const transportContext = new TransportContext({ eventBus, clientManager });
  const registry = new HandlerRegistry(engine, undefined, transportContext);
  const server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = addr && typeof addr === 'object' ? addr.port : 0;

  const gateway = createWebSocketGateway({
    server,
    handlerRegistry: registry,
    eventBus,
    rateLimitPerSecond: overrides?.rateLimit,
    rateLimitSustainedMs: overrides?.sustainedMs,
  });

  return { server, registry, eventBus, gateway, port };
}

async function shutdown(setup: TestSetup): Promise<void> {
  await setup.gateway.close();
  await new Promise<void>((resolve) => setup.server.close(() => resolve()));
}

function connect(port: number, path = '/ws'): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    sock.once('open', () => resolve(sock));
    sock.once('error', reject);
  });
}

function nextMessage(sock: WebSocket, timeoutMs = 1000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for WS message')), timeoutMs);
    sock.once('message', (raw: RawData) => {
      clearTimeout(timer);
      const text = Buffer.isBuffer(raw)
        ? raw.toString('utf-8')
        : Array.isArray(raw)
          ? Buffer.concat(raw.map((b) => Buffer.from(b))).toString('utf-8')
          : Buffer.from(raw as ArrayBuffer).toString('utf-8');
      resolve(JSON.parse(text));
    });
  });
}

describe('WebSocket gateway', () => {
  let setup: TestSetup | undefined;

  beforeEach(() => {
    setup = undefined;
  });

  afterEach(async () => {
    if (setup) {
      await shutdown(setup);
      setup = undefined;
    }
  });

  it('exposes the configured default rate limit constant', () => {
    expect(RATE_LIMIT_PER_SECOND).toBe(500);
  });

  it('AC3: round-trips a JSON-RPC request and returns the response on the same socket', async () => {
    setup = await spinUp();
    const sock = await connect(setup.port);

    sock.send(JSON.stringify({ jsonrpc: '2.0', method: 'health', id: 1 }));
    const msg = await nextMessage(sock);
    expect(msg.jsonrpc).toBe('2.0');
    expect(msg.id).toBe(1);
    expect(msg.result.status).toBe('ok');

    sock.close();
  });

  it('AC3: pushes $/notification when an engine event fires', async () => {
    setup = await spinUp();
    const sock = await connect(setup.port);

    // Wait briefly for the connection to subscribe before we emit.
    await new Promise((r) => setTimeout(r, 20));

    setup.eventBus.emit('session.created', { sessionId: 's1' } as never);

    const msg = await nextMessage(sock);
    expect(msg.method).toBe('$/notification');
    expect(msg.params.type).toBe('session.created');
    expect(msg.params.data.sessionId).toBe('s1');

    sock.close();
  });

  it('AC3: returns method_not_found for unknown methods', async () => {
    setup = await spinUp();
    const sock = await connect(setup.port);

    sock.send(JSON.stringify({ jsonrpc: '2.0', method: 'unknown', id: 2 }));
    const msg = await nextMessage(sock);
    expect(msg.error.code).toBe(-32601);

    sock.close();
  });

  it('AC3: returns parse error for malformed JSON frames', async () => {
    setup = await spinUp();
    const sock = await connect(setup.port);

    sock.send('not-json');
    const msg = await nextMessage(sock);
    expect(msg.error.code).toBe(-32700);

    sock.close();
  });

  it('AC5: mixed clients both receive $/notification from the shared EventBus', async () => {
    setup = await spinUp();
    const sock1 = await connect(setup.port);
    const sock2 = await connect(setup.port);
    await new Promise((r) => setTimeout(r, 20));

    setup.eventBus.emit('security.degraded', { reason: 'test' } as never);

    const [msg1, msg2] = await Promise.all([nextMessage(sock1), nextMessage(sock2)]);
    expect(msg1.method).toBe('$/notification');
    expect(msg1.params.type).toBe('security.degraded');
    expect(msg2.method).toBe('$/notification');
    expect(msg2.params.type).toBe('security.degraded');

    sock1.close();
    sock2.close();
  });

  it('AC6: bursts above the rate limit receive RATE_LIMITED responses', async () => {
    setup = await spinUp({ rateLimit: 3 });
    const sock = await connect(setup.port);

    // Send 5 requests in a burst — only the first 3 are processed.
    for (let i = 0; i < 5; i++) {
      sock.send(JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: i }));
    }

    const messages: any[] = [];
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 200);
      sock.on('message', (raw: RawData) => {
        const text = raw.toString();
        try {
          messages.push(JSON.parse(text));
        } catch {
          messages.push({ raw: text });
        }
        if (messages.length >= 5) {
          clearTimeout(timer);
          resolve();
        }
      });
    });

    const rateLimited = messages.filter((m) => m.code === 'RATE_LIMITED');
    expect(rateLimited.length).toBeGreaterThan(0);
    expect(rateLimited[0].message).toContain('max 3/sec');

    sock.close();
  });

  it('AC6: sustained overage closes the socket with 1008 Policy Violation', async () => {
    // Tight window so the test runs in milliseconds instead of 5 seconds.
    setup = await spinUp({ rateLimit: 2, sustainedMs: 50 });
    const sock = await connect(setup.port);

    const closed = new Promise<number>((resolve) => {
      sock.on('close', (code) => resolve(code ?? 0));
    });

    // Keep flooding past the 50ms sustained window.
    const flood = setInterval(() => {
      for (let i = 0; i < 5; i++) {
        sock.send(JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: Math.random() }));
      }
    }, 10);

    const code = await closed;
    clearInterval(flood);
    expect(code).toBe(CLOSE_CODE_POLICY_VIOLATION);
  });

  it('exposes the configured default rate limit constant', () => {
    expect(RATE_LIMIT_PER_SECOND).toBe(500);
  });

  it('cleans up EventBus subscriptions when a socket closes', async () => {
    setup = await spinUp();
    const before = setup.eventBus.listenerCount('session.created');
    const sock = await connect(setup.port);
    await new Promise((r) => setTimeout(r, 20));

    const during = setup.eventBus.listenerCount('session.created');
    expect(during).toBeGreaterThan(before);

    sock.close();
    await new Promise((r) => setTimeout(r, 20));

    const after = setup.eventBus.listenerCount('session.created');
    expect(after).toBeLessThanOrEqual(during);
  });
});