// @zaivim/gateway — stdio transport layer
// Reads lines from stdin → parse → dispatch via shared HandlerRegistry → write to stdout
// Supports event forwarding from EventBus → client stdout via $/notification

import { createInterface } from 'node:readline';
import { decodeLine, isRequest, isError, successResponse, errorResponse, encodeLine } from './jsonrpc-codec.js';
import { JSONRPC_ERROR_CODES } from '@zaivim/core';
import type { JsonRpcRequest } from '@zaivim/core';
import type { EngineAPI } from '@zaivim/core';
import { encodeNotification } from './notification-sender.js';
import type { TransportContext } from './transport-context.js';
import { HandlerRegistry, type MethodHandler } from '../handler-registry.js';

/** Event types forwarded to clients as $/notification. Keep in sync across transports. */
export const FORWARDED_EVENT_TYPES: readonly string[] = [
  'session.created',
  'session.closed',
  'session.approaching_limit',
  'session.auto_trimmed',
  'session.persistence.dropped',
  'session.recovered',
  'session.project_context_updated',
  'security.degraded',
  'security.secure',
  'engine.warning',
  'engine.shutdown',
  'provider.retry',
  'provider.recovered',
  'provider.auth_failed',
  'provider.model_not_found',
  'provider.rate_limited',
  'provider.fallback',
  'provider.status',
  'context.auto_trimmed',
  'approval.request',
  'approval.resolved',
  'approval.timeout',
  'approval.queued',
  'approval.stale',
  'approval.loop_detected',
];

/**
 * Context for ACL and event system integration.
 */
export interface TransportOptions {
  /** Deprecated — prefer transportContext.acl. Kept for backward compatibility. */
  acl?: import('../method-acl.js').MethodACL;
  /** Deprecated — prefer transportContext.eventBus. Kept for backward compatibility. */
  eventBus?: import('@zaivim/engine').EventBus;
  /** Deprecated — prefer transportContext.clientManager. Kept for backward compatibility. */
  clientManager?: import('@zaivim/engine').ClientManager;
  transportContext?: TransportContext;
  /** Pre-built HandlerRegistry to share with HTTP/WS transports. */
  handlerRegistry?: HandlerRegistry;
}

/**
 * Create a stdio transport that reads JSON-RPC from stdin and writes to stdout.
 *
 * If `opts.handlerRegistry` is provided, it is used as-is so stdio, HTTP, and
 * WebSocket all share one set of handlers. Otherwise a fresh HandlerRegistry
 * is constructed from the engine — backward compatible with pre-4.3 callers.
 */
export function createStdioTransport(
  engine: EngineAPI,
  pidPath?: string,
  streams?: { stdin: NodeJS.ReadStream; stdout: NodeJS.WriteStream },
  opts?: TransportOptions,
): { registry: HandlerRegistry } {
  const ctx = opts?.transportContext;
  // Backward-compat: pre-4.3 callers pass `opts.acl` without a transportContext.
  const standaloneAcl = ctx ? undefined : opts?.acl;
  const registry =
    opts?.handlerRegistry ?? new HandlerRegistry(engine, pidPath, ctx, standaloneAcl);

  const input = streams?.stdin ?? process.stdin;
  const output = streams?.stdout ?? process.stdout;
  const rl = createInterface({ input });

  // ---- Event forwarding: EventBus → stdout via $/notification ---------------
  let eventDisposers: Array<() => void> = [];

  if (ctx) {
    const clientId = ctx.clientManager.generateId();

    for (const type of FORWARDED_EVENT_TYPES) {
      const handler = (data: unknown) => output.write(encodeNotification(type, data));
      const dispose = ctx.eventBus.on(type as any, handler as any);
      eventDisposers.push(dispose);
      ctx.clientManager.trackDisposer(clientId, dispose);
    }
  }

  // ---- Main dispatch loop ---------------------------------------------------

  rl.on('line', async (line: string) => {
    const msg = decodeLine(line);

    if (isError(msg)) {
      output.write(encodeLine(msg));
      return;
    }

    if (isRequest(msg)) {
      const request = msg as JsonRpcRequest;
      const dispatch = await registry.dispatch(request);

      if (dispatch.ok) {
        output.write(encodeLine(successResponse(request.id, dispatch.result)));
      } else {
        output.write(
          encodeLine(
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
    // Notifications (no id) are silently handled or ignored in MVP
  });

  rl.on('close', () => {
    for (const dispose of eventDisposers) {
      dispose();
    }
    eventDisposers = [];

    // stdin closed — exit cleanly (pipe mode: echo '...' | zaivim)
    process.exit(0);
  });

  return { registry };
}

/**
 * Register a custom method handler on an existing registry.
 * Kept for backward compatibility with pre-4.3 callers.
 */
export function registerMethod(
  registry: HandlerRegistry,
  method: string,
  handler: MethodHandler,
): void {
  registry.register(method, handler);
}

// Re-export the registry type for callers that need to share it.
export { HandlerRegistry } from '../handler-registry.js';
export type { MethodHandler } from '../handler-registry.js';
