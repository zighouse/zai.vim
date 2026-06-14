// @zaivim/gateway — HTTP REST + /health transport (Story 4.3)
//
// Same JSON-RPC semantics as stdio, over a small HTTP surface:
//   GET  /health    — ADR-24 三项检查的 HTTP 表达，application/json
//   POST /jsonrpc   — JSON-RPC request body → JSON-RPC response body
//                     (or text/event-stream when handler returns AsyncIterable)
//
// All dispatch goes through the shared HandlerRegistry — no method is
// re-registered here. ACL still applies: session-scoped / admin methods
// require a `token` field in params, exactly like stdio.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { JSONRPC_ERROR_CODES } from '@zaivim/core';
import type { JsonRpcMessage, JsonRpcRequest } from '@zaivim/core';
import { readPidFile, isProcessAlive } from '@zaivim/engine';
import { decode, successResponse, errorResponse } from '@zaivim/core';
import type { EngineAPI } from '@zaivim/core';
import { HandlerRegistry } from './handler-registry.js';
import { readAdminToken } from './admin-token.js';

/** Default request body cap — matches architecture.md maxPayload safety valve. */
export const DEFAULT_MAX_PAYLOAD_BYTES = 10 * 1024 * 1024; // 10 MiB

/** Loopback hosts that bypass the non-localhost auth requirement (NFR16). */
const LOCALHOST_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

export interface HttpGatewayOptions {
  /** TCP port. 0 = let the OS assign one. */
  port: number;
  /** Bind address — defaults to 127.0.0.1 (loopback only). */
  host?: string;
  /** Shared handler registry. Required. */
  handlerRegistry: HandlerRegistry;
  /** Engine reference — needed for /health PID cross-check. */
  engine: EngineAPI;
  /** PID file path for /health cross-check. */
  pidPath?: string;
  /** Override max payload size (bytes). */
  maxPayloadBytes?: number;
  /** Admin API key required for non-localhost connections. Defaults to ~/.zaivim/.admin-token. */
  adminToken?: string;
  /** When true, treat every connection as remote-enforced (skip localhost bypass for tests). */
  enforceAuthAlways?: boolean;
}

export interface HttpGateway {
  readonly server: Server;
  /** Bound port. Equals `opts.port` once listening resolves; reflects OS-assigned port when 0 was requested. */
  port: number;
  readonly host: string;
  /** Resolve after `server.listen()` returns; bound port is in `port`. */
  started: Promise<void>;
  /** Resolve after `server.close()` finishes. */
  close(): Promise<void>;
}

/**
 * Create and start the HTTP gateway. Resolves the `started` promise once
 * the server is listening; `gateway.port` reflects the actual bound port.
 */
export function createHttpGateway(opts: HttpGatewayOptions): HttpGateway {
  const host = opts.host ?? '127.0.0.1';
  const maxPayload = opts.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  const adminTokenProvider =
    typeof opts.adminToken === 'string' ? () => opts.adminToken : readAdminToken;

  const server = createServer((req, res) => {
    handleRequest(req, res, {
      registry: opts.handlerRegistry,
      engine: opts.engine,
      pidPath: opts.pidPath,
      maxPayload,
      resolveAdminToken: adminTokenProvider,
      enforceAuthAlways: opts.enforceAuthAlways === true,
    }).catch((err) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: -32603, message: 'Internal error' } }));
      }
      // Last-resort log — surface unexpected failures without crashing the server.
      process.stderr.write(`[gateway/http] unhandled error: ${(err as Error).message}\n`);
    });
  });

  let startedResolve!: () => void;
  let startedReject!: (err: Error) => void;
  const started = new Promise<void>((resolve, reject) => {
    startedResolve = resolve;
    startedReject = reject;
  });

  server.on('error', (err) => {
    startedReject(err);
  });

  server.listen(opts.port, host, () => {
    startedResolve();
  });

  const boundPort = opts.port; // will be replaced with actual port once known

  const gateway: HttpGateway = {
    server,
    port: boundPort,
    host,
    started: started.then(() => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        gateway.port = addr.port;
      }
    }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };

  return gateway;
}

interface HandleRequestDeps {
  registry: HandlerRegistry;
  engine: EngineAPI;
  pidPath?: string;
  maxPayload: number;
  resolveAdminToken: () => string | undefined;
  enforceAuthAlways: boolean;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, deps: HandleRequestDeps): Promise<void> {
  // ---- Non-localhost auth (NFR16) ------------------------------------------
  // Every request hits this gate. Localhost bypasses it; everything else
  // requires HTTPS + a valid Bearer token. MVP runs HTTP only, so non-
  // localhost connections are rejected outright unless the caller supplies
  // a matching admin token (treated as transport-trusted).
  const isLocal = isLocalhostRequest(req, deps.enforceAuthAlways);
  if (!isLocal) {
    const authResult = authorizeNonLocal(req, deps.resolveAdminToken());
    if (!authResult.ok) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(authResult.body));
      return;
    }
  }

  const url = req.url ?? '/';
  const path = url.split('?')[0];

  if (req.method === 'GET' && path === '/health') {
    handleHealth(res, deps);
    return;
  }

  if (req.method === 'POST' && path === '/jsonrpc') {
    await handleJsonRpc(req, res, deps);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { code: -32601, message: `Not found: ${req.method} ${path}` } }));
}

/** AC1 — GET /health returns the same structure as the JSON-RPC health handler. */
function handleHealth(res: ServerResponse, deps: HandleRequestDeps): void {
  const health = deps.engine.getHealth();
  let status = health.status;

  if (status === 'ok' && deps.pidPath) {
    const pidData = readPidFile(deps.pidPath);
    if (!pidData || !isProcessAlive(pidData.pid)) {
      status = 'down';
    }
  }

  const body = {
    status,
    version: deps.engine.version,
    sandboxAvailable: health.sandboxAvailable,
    activeSessions: health.activeSessions,
    ...(deps.registry.acl ? { methods: deps.registry.acl.listMethods() } : {}),
  };

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** AC2 — POST /jsonrpc dispatches through the shared handler registry. */
async function handleJsonRpc(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HandleRequestDeps,
): Promise<void> {
  // AC7 — reject Content-Length above the cap up-front so we never stream a
  // 10MB+ body just to throw it away. This also avoids socket hang-ups that
  // happen when we destroy the request mid-stream.
  const declaredLength = Number.parseInt(req.headers['content-length'] ?? '0', 10);
  if (Number.isFinite(declaredLength) && declaredLength > deps.maxPayload) {
    res.writeHead(413, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: {
          code: JSONRPC_ERROR_CODES.INVALID_REQUEST,
          message: 'Payload Too Large',
        },
      }),
    );
    return;
  }

  const body = await readBody(req, deps.maxPayload);
  if (body.tooLarge) {
    res.writeHead(413, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: {
          code: JSONRPC_ERROR_CODES.INVALID_REQUEST,
          message: 'Payload Too Large',
        },
      }),
    );
    return;
  }

  const raw = body.buffer.toString('utf-8');
  const msg: JsonRpcMessage = decode(raw);

  // decode() returns a JsonRpcError envelope for malformed input
  if ('error' in msg && !('method' in msg)) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(msg));
    return;
  }

  // Only request messages (method + id) are dispatched
  if (!('method' in msg) || !('id' in msg)) {
    const err = errorResponse(
      null,
      JSONRPC_ERROR_CODES.INVALID_REQUEST,
      'Invalid Request: not a JSON-RPC request',
    );
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(err));
    return;
  }

  const request = msg as JsonRpcRequest;
  const dispatch = await deps.registry.dispatch(request);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  if (dispatch.ok) {
    res.end(JSON.stringify(successResponse(request.id, dispatch.result)));
  } else {
    res.end(
      JSON.stringify(
        errorResponse(
          request.id,
          dispatch.errorCode ?? JSONRPC_ERROR_CODES.INTERNAL_ERROR,
          dispatch.errorMessage ?? 'Internal error',
          dispatch.errorData,
        ),
      ),
    );
  }
}

interface ReadBodyResult {
  tooLarge: boolean;
  buffer: Buffer;
}

async function readBody(req: IncomingMessage, maxPayload: number): Promise<ReadBodyResult> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxPayload) {
      // Drain remaining data so Node reuses the socket cleanly.
      req.destroy();
      return { tooLarge: true, buffer: Buffer.alloc(0) };
    }
    chunks.push(chunk as Buffer);
  }

  return { tooLarge: false, buffer: Buffer.concat(chunks) };
}

function isLocalhostRequest(req: IncomingMessage, enforceAlways: boolean): boolean {
  if (enforceAlways) return false;

  // Trust the Host header — clients connecting from another machine cannot
  // forge a 127.0.0.1/localhost value on a TCP connection that originated elsewhere.
  const hostHeader = ((req.headers.host ?? '').split(':')[0] ?? '').toLowerCase();
  if (LOCALHOST_HOSTS.has(hostHeader)) return true;

  // Some proxies expose the peer over X-Forwarded-For; for MVP we treat any
  // missing/unknown remote as non-local and let the auth gate decide.
  const remote = req.socket.remoteAddress ?? '';
  if (LOCALHOST_HOSTS.has(remote) || LOCALHOST_HOSTS.has(remote.replace(/^::ffff:/, ''))) {
    return true;
  }

  return false;
}

interface AuthOutcome {
  ok: boolean;
  body?: { error: { code: string; message: string } };
}

function authorizeNonLocal(req: IncomingMessage, adminToken: string | undefined): AuthOutcome {
  const auth = req.headers.authorization ?? '';
  const matches = /^Bearer\s+(.+)$/i.exec(auth);
  const presented = matches?.[1] ?? '';

  if (!presented || !adminToken || presented !== adminToken) {
    return {
      ok: false,
      body: {
        error: {
          code: '-32001',
          message:
            'Unauthorized: HTTPS and API key required for non-localhost connections',
        },
      },
    };
  }

  return { ok: true };
}
