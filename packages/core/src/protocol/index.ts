// =============================================================================
// @zaivim/core — JSON-RPC 2.0 protocol
// encode / decode + discriminated union types
// =============================================================================

import type { ZaiError } from '../errors/index.js';

// ---- JSON-RPC 2.0 message types --------------------------------------------

export const JSONRPC_VERSION = '2.0' as const;

export interface JsonRpcRequest {
  readonly jsonrpc: typeof JSONRPC_VERSION;
  readonly id: string | number;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcResponse {
  readonly jsonrpc: typeof JSONRPC_VERSION;
  readonly id: string | number;
  readonly result: unknown;
}

export interface JsonRpcNotification {
  readonly jsonrpc: typeof JSONRPC_VERSION;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcError {
  readonly jsonrpc: typeof JSONRPC_VERSION;
  readonly id: string | number | null;
  readonly error: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
}

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcResponse
  | JsonRpcNotification
  | JsonRpcError;

// ---- Standard JSON-RPC error codes -----------------------------------------

export const JSONRPC_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

// ---- encode ----------------------------------------------------------------

export function encode(message: JsonRpcMessage): string {
  return JSON.stringify(message);
}

export function encodeLine(message: JsonRpcMessage): string {
  return encode(message) + '\n';
}

// ---- decode ----------------------------------------------------------------
// Non-throwing JSON parse — all external input goes through here.

export function decode(input: string): JsonRpcError | JsonRpcMessage {
  let raw: Record<string, unknown>;

  try {
    raw = JSON.parse(input) as Record<string, unknown>;
  } catch {
    return {
      jsonrpc: JSONRPC_VERSION,
      id: null,
      error: {
        code: JSONRPC_ERROR_CODES.PARSE_ERROR,
        message: 'Parse error',
      },
    };
  }

  if (!raw || typeof raw !== 'object') {
    return {
      jsonrpc: JSONRPC_VERSION,
      id: null,
      error: {
        code: JSONRPC_ERROR_CODES.INVALID_REQUEST,
        message: 'Invalid Request',
      },
    };
  }

  if (raw.jsonrpc !== JSONRPC_VERSION) {
    return {
      jsonrpc: JSONRPC_VERSION,
      id: (typeof raw.id === 'string' || typeof raw.id === 'number') ? raw.id : null,
      error: {
        code: JSONRPC_ERROR_CODES.INVALID_REQUEST,
        message: 'Invalid Request',
      },
    };
  }

  return raw as unknown as JsonRpcMessage;
}

// ---- helpers ---------------------------------------------------------------

export function isRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return 'method' in msg && 'id' in msg;
}

export function isResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return 'result' in msg && 'id' in msg;
}

export function isNotification(msg: JsonRpcMessage): msg is JsonRpcNotification {
  return 'method' in msg && !('id' in msg);
}

export function isError(msg: JsonRpcMessage): msg is JsonRpcError {
  return 'error' in msg;
}

export function errorResponse(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcError {
  return {
    jsonrpc: JSONRPC_VERSION,
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  };
}

export function successResponse(
  id: string | number,
  result: unknown,
): JsonRpcResponse {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

export function notification(
  method: string,
  params?: unknown,
): JsonRpcNotification {
  return { jsonrpc: JSONRPC_VERSION, method, params };
}

// ---- Streaming notification (LSP-inspired) ---------------------------------
// $/notification — sent by engine to client without request id

export function streamChunk(
  chunk: Record<string, unknown>,
): JsonRpcNotification {
  return { jsonrpc: JSONRPC_VERSION, method: '$/chunk', params: chunk };
}

export function streamError(
  message: string,
  code?: string,
): JsonRpcNotification {
  return {
    jsonrpc: JSONRPC_VERSION,
    method: '$/error',
    params: { message, code },
  };
}

export function streamDone(
  finishReason: string,
): JsonRpcNotification {
  return {
    jsonrpc: JSONRPC_VERSION,
    method: '$/done',
    params: { finishReason },
  };
}

// ---- ZaiError ↔ JsonRpcError conversion ------------------------------------

export function toJsonRpcError(
  id: string | number | null,
  err: ZaiError,
): JsonRpcError {
  return {
    jsonrpc: JSONRPC_VERSION,
    id,
    error: {
      code: err.statusCode ?? JSONRPC_ERROR_CODES.INTERNAL_ERROR,
      message: err.message,
      data: { zaiCode: err.code },
    },
  };
}
