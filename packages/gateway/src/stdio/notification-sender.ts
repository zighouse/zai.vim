// @zaivim/gateway — $/notification JSON-RPC 2.0 notification encoding
// Encodes engine events as JSON-RPC 2.0 notifications (no id field)

import { encodeLine } from './jsonrpc-codec.js';
import type { JsonRpcNotification } from '@zaivim/core';

/**
 * Encode an engine event as a $/notification JSON-RPC message.
 * The notification follows the format:
 * {"jsonrpc":"2.0","method":"$/notification","params":{"type":"<event-type>","data":{...},"seq":N}}
 *
 * `seq` is a per-transport monotonic counter that lets clients detect gaps
 * and reorder late-arriving frames (AC5). When omitted, no seq is emitted.
 */
export function encodeNotification(type: string, data: unknown, seq?: number): string {
  const params: Record<string, unknown> = { type, data };
  if (seq !== undefined) params.seq = seq;

  const notification: JsonRpcNotification = {
    jsonrpc: '2.0',
    method: '$/notification',
    params,
  };
  return encodeLine(notification);
}

/**
 * Encode a chat chunk notification for streaming responses.
 */
export function encodeChatChunk(chunk: Record<string, unknown>): string {
  const notification: JsonRpcNotification = {
    jsonrpc: '2.0',
    method: '$/chat/chunk',
    params: chunk,
  };
  return encodeLine(notification);
}
