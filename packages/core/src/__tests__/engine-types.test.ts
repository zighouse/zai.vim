// =============================================================================
// @zaivim/core — ZaiError serialization and JSON-RPC type constraint tests
// =============================================================================

import { describe, it, expect } from 'vitest';
import {
  ZaiError,
  ZaiNetworkError,
  ZaiToolError,
  SkillLoadError,
  SkillRuntimeError,
  ZaiConfigError,
  ZaiSecurityError,
  ZaiGatewayError,
  ErrorCodes,
} from '../errors/index.js';

import {
  encode,
  decode,
  JSONRPC_VERSION,
  JSONRPC_ERROR_CODES,
  isRequest,
  isResponse,
  isNotification,
  isError,
  successResponse,
  errorResponse,
} from '../protocol/index.js';

describe('ZaiError serialization', () => {
  it('ZaiError.toJSON() includes code and message', () => {
    const err = new ZaiError('test', 'CORE_PARSE_ERROR', 400);
    const json = err.toJSON();
    expect(json.code).toBe('CORE_PARSE_ERROR');
    expect(json.message).toBe('test');
  });

  it('ZaiConfigError preserves detail', () => {
    const detail = { field: 'sandbox.type', line: 5 };
    const err = new ZaiConfigError('invalid type', detail);
    expect(err.detail).toEqual(detail);
    expect(err.code).toBe('ENGINE_CONFIG_INVALID');
    expect(err.statusCode).toBe(400);
  });

  it('ZaiSecurityError has operation', () => {
    const err = new ZaiSecurityError('denied', 'shell_exec');
    expect(err.operation).toBe('shell_exec');
    expect(err.statusCode).toBe(403);
  });

  it('ZaiToolError includes toolName in toJSON', () => {
    const err = new ZaiToolError('not found', 'TOOLS_FILE_NOT_FOUND', 404, 'file_read');
    const json = err.toJSON();
    expect(json).toHaveProperty('toolName', 'file_read');
  });

  it('SkillLoadError has skillName and skillPath', () => {
    const err = new SkillLoadError('my-skill', 'import failed', '/path/to/skill');
    expect(err.skillName).toBe('my-skill');
    expect(err.skillPath).toBe('/path/to/skill');
  });

  it('all ErrorCodes are unique', () => {
    const codes = Object.values(ErrorCodes);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('ZaiError instanceof chain works', () => {
    const err = new ZaiConfigError('test');
    expect(err).toBeInstanceOf(ZaiError);
    expect(err).toBeInstanceOf(ZaiConfigError);
    expect(err).toBeInstanceOf(Error);
  });
});

describe('JSON-RPC type constraints', () => {
  it('decode handles valid request', () => {
    const msg = decode(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'health' }));
    expect(isRequest(msg)).toBe(true);
    if (isRequest(msg)) {
      expect(msg.method).toBe('health');
      expect(msg.id).toBe(1);
    }
  });

  it('decode returns parse error for non-JSON', () => {
    const msg = decode('not json at all');
    expect(isError(msg)).toBe(true);
    if (isError(msg)) {
      expect(msg.error.code).toBe(JSONRPC_ERROR_CODES.PARSE_ERROR);
    }
  });

  it('decode returns invalid request for missing jsonrpc field', () => {
    const msg = decode(JSON.stringify({ id: 1, method: 'test' }));
    expect(isError(msg)).toBe(true);
    if (isError(msg)) {
      expect(msg.error.code).toBe(JSONRPC_ERROR_CODES.INVALID_REQUEST);
    }
  });

  it('decode returns invalid request for wrong version', () => {
    const msg = decode(JSON.stringify({ jsonrpc: '1.0', id: 1, method: 'test' }));
    expect(isError(msg)).toBe(true);
    if (isError(msg)) {
      expect(msg.error.code).toBe(JSONRPC_ERROR_CODES.INVALID_REQUEST);
    }
  });

  it('decode returns invalid request for non-object JSON', () => {
    const msg = decode('"just a string"');
    expect(isError(msg)).toBe(true);
  });

  it('encode/decode roundtrip for request', () => {
    const original = { jsonrpc: JSONRPC_VERSION, id: 42, method: 'chat', params: { msg: 'hello' } };
    const encoded = encode(original);
    const decoded = decode(encoded);
    expect(isRequest(decoded)).toBe(true);
    if (isRequest(decoded)) {
      expect(decoded.method).toBe('chat');
      expect(decoded.id).toBe(42);
    }
  });

  it('successResponse creates valid response', () => {
    const resp = successResponse(1, { status: 'ok' });
    expect(resp.jsonrpc).toBe(JSONRPC_VERSION);
    expect(resp.id).toBe(1);
    expect(resp.result).toEqual({ status: 'ok' });
  });

  it('errorResponse creates valid error', () => {
    const err = errorResponse(2, -32600, 'Invalid Request');
    expect(err.jsonrpc).toBe(JSONRPC_VERSION);
    expect(err.id).toBe(2);
    expect(err.error.code).toBe(-32600);
  });

  it('isNotification detects notifications', () => {
    const msg = decode(JSON.stringify({ jsonrpc: '2.0', method: '$/chunk', params: {} }));
    expect(isNotification(msg)).toBe(true);
  });

  it('isResponse detects responses', () => {
    const msg = decode(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }));
    expect(isResponse(msg)).toBe(true);
  });
});
