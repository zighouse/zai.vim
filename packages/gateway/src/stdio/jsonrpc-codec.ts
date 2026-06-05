// @zaivim/gateway — JSON-RPC 2.0 codec for stdio transport
// Re-uses @zaivim/core protocol types and adds line-based framing

import {
  JSONRPC_VERSION,
  JSONRPC_ERROR_CODES,
  decode,
  encodeLine,
  isRequest,
  isError,
  successResponse,
  errorResponse,
} from '@zaivim/core';
import type {
  JsonRpcMessage,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcError,
} from '@zaivim/core';

export {
  JSONRPC_VERSION,
  JSONRPC_ERROR_CODES,
  decode,
  encode,
  encodeLine,
  isRequest,
  isResponse,
  isNotification,
  isError,
  successResponse,
  errorResponse,
  notification,
} from '@zaivim/core';

export type {
  JsonRpcMessage,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
  JsonRpcError,
} from '@zaivim/core';

/**
 * Parse a single line of JSON-RPC input.
 * Returns a decoded message or a JSON-RPC error for malformed input.
 */
export function decodeLine(line: string): JsonRpcMessage {
  const trimmed = line.trim();
  if (!trimmed) {
    return errorResponse(null, JSONRPC_ERROR_CODES.PARSE_ERROR, 'Empty line');
  }
  return decode(trimmed);
}
