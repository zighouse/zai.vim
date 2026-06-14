// @zaivim/gateway — WebSocket transport (Story 4.3)
//
// Same JSON-RPC semantics as stdio/HTTP, over a single long-lived socket.
// Outbound engine events (session.*, approval.*, etc.) are pushed as
// $/notification frames so a connected TUI/browser stays in sync with
// stdio clients subscribed to the same EventBus.
//
// Flood protection (AC6): each connection is rate-limited to 500 req/s.
// Sustained overage (5 consecutive seconds above the limit) terminates
// the socket with close code 1008 (Policy Violation).

import { type Server as HttpServer } from 'node:http';
import { WebSocketServer, type WebSocket, type RawData } from 'ws';
import { JSONRPC_ERROR_CODES } from '@zaivim/core';
import { ZaiError } from '@zaivim/core';
import { decode, successResponse, errorResponse } from '@zaivim/core';
import type { JsonRpcMessage, JsonRpcRequest } from '@zaivim/core';
import type { EventBus } from '@zaivim/engine';
import { HandlerRegistry } from './handler-registry.js';
import { encodeNotification } from './stdio/notification-sender.js';
import { FORWARDED_EVENT_TYPES } from './stdio/transport.js';

/** AC6 — hard cap per second. */
export const RATE_LIMIT_PER_SECOND = 500;
/** AC6 — sustained overage window (ms) before we close the socket. */
export const RATE_LIMIT_SUSTAINED_MS = 5000;
/** WS close code 1008 (Policy Violation) — used when a client floods. */
export const CLOSE_CODE_POLICY_VIOLATION = 1008;

export interface WebSocketGatewayOptions {
  /** Existing HTTP server to upgrade from — typically the HTTP gateway's server. */
  server: HttpServer;
  /** Shared handler registry — same instance as HTTP/stdio. */
  handlerRegistry: HandlerRegistry;
  /** Engine event bus — connections subscribe so they receive $/notification frames. */
  eventBus: EventBus;
  /** Per-connection rate limit (requests/sec). Defaults to 500. */
  rateLimitPerSecond?: number;
  /** Sustained overage window (ms) before we close the socket. Defaults to 5000. */
  rateLimitSustainedMs?: number;
  /** Path the WS server listens on. Defaults to '/ws'. */
  path?: string;
}

export interface WebSocketGateway {
  readonly wss: WebSocketServer;
  /** Resolve after `wss.close()` finishes. */
  close(): Promise<void>;
}

interface ConnectionState {
  /** Disposers for EventBus subscriptions — called on socket close. */
  readonly disposers: Array<() => void>;
  /** Rolling request timestamps used by the rate limiter. */
  readonly timestamps: number[];
  /** Timestamp (ms) when the current overage streak started; reset on a successful request. */
  overageStreakStart: number | null;
  /** Per-connection monotonic counter stamped onto $/notification frames (AC5). */
  notificationSeq: number;
}

/**
 * Attach a WebSocket server to an existing HTTP server. Each connection:
 *   1. Subscribes to every forwarded engine event → $/notification frame
 *   2. Tracks request rate per second; rejects requests above the limit
 *   3. Closes with 1008 after sustained overage (AC6)
 *   4. Cleans up EventBus subscriptions on disconnect
 */
export function createWebSocketGateway(opts: WebSocketGatewayOptions): WebSocketGateway {
  const rateLimit = opts.rateLimitPerSecond ?? RATE_LIMIT_PER_SECOND;
  const sustainedMs = opts.rateLimitSustainedMs ?? RATE_LIMIT_SUSTAINED_MS;
  const path = opts.path ?? '/ws';

  const wss = new WebSocketServer({ server: opts.server, path });

  wss.on('connection', (socket, req) => {
    handleConnection(socket, req, {
      registry: opts.handlerRegistry,
      eventBus: opts.eventBus,
      rateLimit,
      sustainedMs,
    }).catch((err) => {
      // handleConnection is expected to never throw — its internals are
      // defensive — but if it does, log and tear the socket down rather
      // than silently drop the error.
      process.stderr.write(`[gateway/ws] connection setup failed: ${(err as Error).message}\n`);
      try {
        socket.close(CLOSE_CODE_POLICY_VIOLATION, 'connection setup failed');
      } catch {
        // socket may already be closed
      }
    });
  });

  return {
    wss,
    close: () =>
      new Promise<void>((resolve, reject) => {
        // Close every client first so no new frames arrive mid-shutdown.
        for (const client of wss.clients) {
          client.close();
        }
        wss.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

interface ConnectionDeps {
  registry: HandlerRegistry;
  eventBus: EventBus;
  rateLimit: number;
  sustainedMs: number;
}

async function handleConnection(
  socket: WebSocket,
  _req: unknown,
  deps: ConnectionDeps,
): Promise<void> {
  const state: ConnectionState = {
    disposers: [],
    timestamps: [],
    overageStreakStart: null,
    notificationSeq: 0,
  };

  // ---- Subscribe to every forwarded engine event ---------------------------
  // Each subscription pushes a $/notification frame on the same socket so a
  // WS client receives engine-wide state changes alongside its RPC replies.
  // Each frame carries a per-connection `seq` so the client can detect gaps
  // and reorder (AC5).
  for (const type of FORWARDED_EVENT_TYPES) {
    const handler = (data: unknown): void => {
      if (socket.readyState === socket.OPEN) {
        state.notificationSeq += 1;
        socket.send(encodeNotification(type, data, state.notificationSeq));
      }
    };
    const dispose = deps.eventBus.on(type as never, handler as never);
    state.disposers.push(dispose);
  }

  socket.on('message', (raw: RawData) => onMessage(socket, state, raw, deps));
  socket.on('close', () => cleanup(state));
  socket.on('error', () => cleanup(state));
}

function onMessage(
  socket: WebSocket,
  state: ConnectionState,
  raw: RawData,
  deps: ConnectionDeps,
): void {
  // ---- Rate limit (AC6) ----------------------------------------------------
  const now = Date.now();
  // Drop timestamps older than 1 second.
  while (state.timestamps.length > 0 && now - state.timestamps[0]! >= 1000) {
    state.timestamps.shift();
  }

  if (state.timestamps.length >= deps.rateLimit) {
    // Over the limit — start (or extend) the overage streak.
    if (state.overageStreakStart === null) {
      state.overageStreakStart = now;
    } else if (now - state.overageStreakStart >= deps.sustainedMs) {
      socket.close(CLOSE_CODE_POLICY_VIOLATION, 'rate limit sustained overage');
      return;
    }
    socket.send(
      JSON.stringify({
        code: 'RATE_LIMITED',
        message: `too many requests: max ${deps.rateLimit}/sec per connection`,
      }),
    );
    return;
  }

  // Within rate — reset the overage streak so a single hiccup doesn't compound.
  state.overageStreakStart = null;
  state.timestamps.push(now);

  // ---- Decode + dispatch ---------------------------------------------------
  let msg: JsonRpcMessage;
  try {
    const buf = Buffer.isBuffer(raw)
      ? raw
      : Array.isArray(raw)
        ? Buffer.concat(raw.map((b) => Buffer.from(b)))
        : Buffer.from(raw as ArrayBuffer);
    msg = decode(buf.toString('utf-8'));
  } catch {
    socket.send(
      JSON.stringify(
        errorResponse(null, JSONRPC_ERROR_CODES.PARSE_ERROR, 'Parse error'),
      ),
    );
    return;
  }

  if ('error' in msg && !('method' in msg)) {
    socket.send(JSON.stringify(msg));
    return;
  }

  if (!('method' in msg) || !('id' in msg)) {
    socket.send(
      JSON.stringify(
        errorResponse(
          null,
          JSONRPC_ERROR_CODES.INVALID_REQUEST,
          'Invalid Request: not a JSON-RPC request',
        ),
      ),
    );
    return;
  }

  const request = msg as JsonRpcRequest;
  void deps.registry
    .dispatch(request)
    .then((dispatch) => {
      if (dispatch.ok) {
        socket.send(JSON.stringify(successResponse(request.id, dispatch.result)));
      } else {
        socket.send(
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
    })
    .catch((err) => {
      // dispatch() never throws — defensive guard for runtime bugs.
      socket.send(
        JSON.stringify(
          errorResponse(
            request.id,
            JSONRPC_ERROR_CODES.INTERNAL_ERROR,
            (err as Error)?.message ?? 'Internal error',
            err instanceof ZaiError ? err.toJSON() : undefined,
          ),
        ),
      );
    });
}

function cleanup(state: ConnectionState): void {
  for (const dispose of state.disposers) {
    try {
      dispose();
    } catch (err) {
      // EventBus subscriptions may already be torn down during shutdown —
      // log so a leak is diagnosable instead of silent.
      process.stderr.write(`[gateway/ws] disposer threw during cleanup: ${(err as Error).message}\n`);
    }
  }
  state.disposers.length = 0;
}
