// =============================================================================
// @zaivim/core — JSON-RPC 2.0 protocol
// encode / decode + discriminated union types
// =============================================================================

import type { ZaiError } from '../errors/index.js';

// ---- JSON-RPC 2.0 message types --------------------------------------------

/** JSON-RPC 2.0 protocol version constant: '2.0'. */
export const JSONRPC_VERSION = '2.0' as const;

/** A JSON-RPC 2.0 request — method call with id. */
export interface JsonRpcRequest {
  readonly jsonrpc: typeof JSONRPC_VERSION;
  readonly id: string | number;
  readonly method: string;
  readonly params?: unknown;
}

/** A JSON-RPC 2.0 response — successful result with matching id. */
export interface JsonRpcResponse {
  readonly jsonrpc: typeof JSONRPC_VERSION;
  readonly id: string | number;
  readonly result: unknown;
}

/** A JSON-RPC 2.0 notification — method call without id (no response). */
export interface JsonRpcNotification {
  readonly jsonrpc: typeof JSONRPC_VERSION;
  readonly method: string;
  readonly params?: unknown;
}

/** A JSON-RPC 2.0 error response — error object with matching id. */
export interface JsonRpcError {
  readonly jsonrpc: typeof JSONRPC_VERSION;
  readonly id: string | number | null;
  readonly error: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
}

/** Discriminated union of all JSON-RPC 2.0 message types. */
export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcResponse
  | JsonRpcNotification
  | JsonRpcError;

// ---- Standard JSON-RPC error codes -----------------------------------------

/** Standard JSON-RPC 2.0 error code constants. */
export const JSONRPC_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

// ---- encode ----------------------------------------------------------------

/** Serialize a JsonRpcMessage to a JSON string. */
export function encode(message: JsonRpcMessage): string {
  return JSON.stringify(message);
}

/** Serialize a JsonRpcMessage to a JSON string with trailing newline. */
export function encodeLine(message: JsonRpcMessage): string {
  return encode(message) + '\n';
}

// ---- decode ----------------------------------------------------------------
// Non-throwing JSON parse — all external input goes through here.

/**
 * Parse a JSON string into a JsonRpcMessage.
 * Returns a JsonRpcError with PARSE_ERROR or INVALID_REQUEST on failure
 * (never throws).
 */
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

/** Type guard: true if the message is a JsonRpcRequest (has method + id). */
export function isRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return 'method' in msg && 'id' in msg;
}

/** Type guard: true if the message is a JsonRpcResponse (has result + id). */
export function isResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return 'result' in msg && 'id' in msg;
}

/** Type guard: true if the message is a JsonRpcNotification (has method, no id). */
export function isNotification(msg: JsonRpcMessage): msg is JsonRpcNotification {
  return 'method' in msg && !('id' in msg);
}

/** Type guard: true if the message is a JsonRpcError (has error field). */
export function isError(msg: JsonRpcMessage): msg is JsonRpcError {
  return 'error' in msg;
}

/** Create a JsonRpcError response with given id, code, message, and optional data. */
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

/** Create a JsonRpcResponse with given id and result. */
export function successResponse(
  id: string | number,
  result: unknown,
): JsonRpcResponse {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

/** Create a JsonRpcNotification with given method and optional params. */
export function notification(
  method: string,
  params?: unknown,
): JsonRpcNotification {
  return { jsonrpc: JSONRPC_VERSION, method, params };
}

// ---- Streaming notification (LSP-inspired) ---------------------------------
// $/notification — sent by engine to client without request id

/** Create a streaming chunk notification ($/chunk). */
export function streamChunk(
  chunk: Record<string, unknown>,
): JsonRpcNotification {
  return { jsonrpc: JSONRPC_VERSION, method: '$/chunk', params: chunk };
}

/** Create a streaming error notification ($/error). */
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

/** Create a streaming done notification ($/done). */
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

/** Convert a ZaiError to a JsonRpcError with matching id. */
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
