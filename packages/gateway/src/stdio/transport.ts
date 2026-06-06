// @zaivim/gateway — stdio transport layer
// Reads lines from stdin → parse → dispatch → write to stdout

import { createInterface } from 'node:readline';
import { decodeLine, isRequest, isError, successResponse, errorResponse, encodeLine } from './jsonrpc-codec.js';
import { JSONRPC_ERROR_CODES } from '@zaivim/core';
import type { JsonRpcRequest, JsonRpcMessage } from '@zaivim/core';
import type { EngineAPI } from '@zaivim/core';
import { buildHealthResponse } from '@zaivim/engine';

type MethodHandler = (params: unknown) => unknown;

/**
 * Create a stdio transport that reads JSON-RPC from stdin and writes to stdout.
 */
export function createStdioTransport(engine: EngineAPI): void {
  const handlers = new Map<string, MethodHandler>();

  // Register built-in methods
  handlers.set('health', () => {
    const health = engine.getHealth();
    return {
      status: health.status,
      version: engine.version,
      sandboxAvailable: health.sandboxAvailable,
      activeSessions: health.activeSessions,
    };
  });

  handlers.set('ping', () => ({
    status: 'ok',
    version: engine.version,
  }));

  handlers.set('stop', async () => {
    // Trigger graceful shutdown via JSON-RPC
    await engine.destroy({ force: false, reason: 'jsonrpc_stop' });
    return { status: 'stopping' };
  });

  const rl = createInterface({ input: process.stdin });

  rl.on('line', (line: string) => {
    const msg = decodeLine(line);

    // If decode produced an error, write it out
    if (isError(msg)) {
      process.stdout.write(encodeLine(msg));
      return;
    }

    // Only handle requests (have id + method)
    if (isRequest(msg)) {
      const request = msg as JsonRpcRequest;
      const handler = handlers.get(request.method);

      if (handler) {
        try {
          const result = handler(request.params);
          const response = successResponse(request.id, result);
          process.stdout.write(encodeLine(response));
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : 'Internal error';
          const response = errorResponse(request.id, JSONRPC_ERROR_CODES.INTERNAL_ERROR, errMsg);
          process.stdout.write(encodeLine(response));
        }
      } else {
        const response = errorResponse(
          request.id,
          JSONRPC_ERROR_CODES.METHOD_NOT_FOUND,
          `Method not found: ${request.method}`,
        );
        process.stdout.write(encodeLine(response));
      }
    }
    // Notifications (no id) are silently handled or ignored in MVP
  });

  rl.on('close', () => {
    // stdin closed — exit cleanly (pipe mode: echo '...' | zaivim)
    process.exit(0);
  });
}

/**
 * Register a custom method handler.
 */
export function registerMethod(
  handlers: Map<string, MethodHandler>,
  method: string,
  handler: MethodHandler,
): void {
  handlers.set(method, handler);
}
