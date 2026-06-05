// =============================================================================
// @zaivim/gateway — JSON-RPC codec and CLI tests
// =============================================================================

import { describe, it, expect } from 'vitest';
import {
  decodeLine,
  decode,
  JSONRPC_ERROR_CODES,
  isRequest,
  isError,
} from '../stdio/jsonrpc-codec.js';

// ---- JSON-RPC codec tests ----

describe('JSON-RPC codec', () => {
  describe('normal request/response/error', () => {
    it('decodes valid JSON-RPC request', () => {
      const msg = decodeLine('{"jsonrpc":"2.0","id":1,"method":"health"}');
      expect(isRequest(msg)).toBe(true);
      if (isRequest(msg)) {
        expect(msg.method).toBe('health');
        expect(msg.id).toBe(1);
      }
    });

    it('decodes request with params', () => {
      const msg = decodeLine('{"jsonrpc":"2.0","id":2,"method":"chat","params":{"message":"hello"}}');
      expect(isRequest(msg)).toBe(true);
      if (isRequest(msg)) {
        expect(msg.method).toBe('chat');
        expect(msg.params).toEqual({ message: 'hello' });
      }
    });

    it('decodes notification (no id)', () => {
      const msg = decodeLine('{"jsonrpc":"2.0","method":"$/chunk","params":{}}');
      expect(isRequest(msg)).toBe(false);
      expect(isError(msg)).toBe(false);
    });
  });

  describe('parse error (-32700)', () => {
    it('non-JSON input returns parse error', () => {
      const msg = decodeLine('this is not json');
      expect(isError(msg)).toBe(true);
      if (isError(msg)) {
        expect(msg.error.code).toBe(JSONRPC_ERROR_CODES.PARSE_ERROR);
      }
    });

    it('empty line returns parse error', () => {
      const msg = decodeLine('');
      expect(isError(msg)).toBe(true);
      if (isError(msg)) {
        expect(msg.error.code).toBe(JSONRPC_ERROR_CODES.PARSE_ERROR);
      }
    });

    it('whitespace-only line returns parse error', () => {
      const msg = decodeLine('   ');
      expect(isError(msg)).toBe(true);
    });
  });

  describe('invalid request (-32600)', () => {
    it('missing jsonrpc field returns invalid request', () => {
      const msg = decodeLine('{"id":1,"method":"test"}');
      expect(isError(msg)).toBe(true);
      if (isError(msg)) {
        expect(msg.error.code).toBe(JSONRPC_ERROR_CODES.INVALID_REQUEST);
      }
    });

    it('wrong jsonrpc version returns invalid request', () => {
      const msg = decodeLine('{"jsonrpc":"1.0","id":1,"method":"test"}');
      expect(isError(msg)).toBe(true);
      if (isError(msg)) {
        expect(msg.error.code).toBe(JSONRPC_ERROR_CODES.INVALID_REQUEST);
      }
    });

    it('non-object JSON returns invalid request', () => {
      const msg = decodeLine('42');
      expect(isError(msg)).toBe(true);
      if (isError(msg)) {
        expect(msg.error.code).toBe(JSONRPC_ERROR_CODES.INVALID_REQUEST);
      }
    });

    it('null returns invalid request', () => {
      const msg = decodeLine('null');
      expect(isError(msg)).toBe(true);
    });
  });
});

// ---- CLI parseArgs tests ----
// CLI uses util.parseArgs() which is tested by Node itself.
// We test the decode behavior that the CLI relies on.

describe('CLI input handling', () => {
  it('health request decodes correctly', () => {
    const input = '{"jsonrpc":"2.0","id":1,"method":"health"}';
    const msg = decode(input);
    expect(isRequest(msg)).toBe(true);
    if (isRequest(msg)) {
      expect(msg.method).toBe('health');
    }
  });

  it('malformed input for interactive mode returns parse error', () => {
    const msg = decode('{bad json');
    expect(isError(msg)).toBe(true);
    if (isError(msg)) {
      expect(msg.error.code).toBe(JSONRPC_ERROR_CODES.PARSE_ERROR);
      expect(msg.id).toBeNull();
    }
  });
});
