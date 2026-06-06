// @zaivim/gateway — stdio transport layer
// Reads lines from stdin → parse → dispatch → write to stdout

import { createInterface } from 'node:readline';
import { decodeLine, isRequest, isError, successResponse, errorResponse, encodeLine } from './jsonrpc-codec.js';
import { JSONRPC_ERROR_CODES } from '@zaivim/core';
import type { JsonRpcRequest, JsonRpcMessage } from '@zaivim/core';
import type { EngineAPI } from '@zaivim/core';
import { readPidFile, isProcessAlive } from '@zaivim/engine';

type MethodHandler = (params: unknown) => unknown;

/**
 * Create a stdio transport that reads JSON-RPC from stdin and writes to stdout.
 * @param pidPath - Optional PID file path to cross-check daemon state (AC8: pipe mode should not report ok after stop)
 * @param streams - Optional stream overrides for testing (defaults to process.stdin/stdout)
 */
export function createStdioTransport(engine: EngineAPI, pidPath?: string, streams?: { stdin: NodeJS.ReadStream; stdout: NodeJS.WriteStream }): void {
  const handlers = new Map<string, MethodHandler>();

  // Register built-in methods
  handlers.set('health', () => {
    const health = engine.getHealth();
    let status = health.status;

    // Cross-check with PID file: if status is 'ok' but no daemon PID alive,
    // this is a throwaway engine from pipe mode — report 'down' (AC8)
    if (status === 'ok' && pidPath) {
      const pidData = readPidFile(pidPath);
      if (!pidData || !isProcessAlive(pidData.pid)) {
        status = 'down';
      }
    }

    return {
      status,
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

  const input = streams?.stdin ?? process.stdin;
  const output = streams?.stdout ?? process.stdout;
  const rl = createInterface({ input });

  rl.on('line', async (line: string) => {
    const msg = decodeLine(line);

    // If decode produced an error, write it out
    if (isError(msg)) {
      output.write(encodeLine(msg));
      return;
    }

    // Only handle requests (have id + method)
    if (isRequest(msg)) {
      const request = msg as JsonRpcRequest;
      const handler = handlers.get(request.method);

      if (handler) {
        try {
          const result = await handler(request.params);
          const response = successResponse(request.id, result);
          output.write(encodeLine(response));
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : 'Internal error';
          const response = errorResponse(request.id, JSONRPC_ERROR_CODES.INTERNAL_ERROR, errMsg);
          output.write(encodeLine(response));
        }
      } else {
        const response = errorResponse(
          request.id,
          JSONRPC_ERROR_CODES.METHOD_NOT_FOUND,
          `Method not found: ${request.method}`,
        );
        output.write(encodeLine(response));
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
