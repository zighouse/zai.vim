// @zaivim/gateway — ACL & token injection tests (Task A5)
// Verifies that session-scoped and admin-scoped methods require authentication
// and return proper error codes.

import { describe, it, expect } from 'vitest';
import { MethodACL, requireAuth, generateAdminToken } from '../../method-acl.js';
import { readAdminToken } from '../../admin-token.js';

describe('vim-rpc-server ACL token handling', () => {
  const acl = MethodACL.createDefault();

  // A5.4: Token missing → -32001 error

  it('returns -32001 for session-scoped method without token', () => {
    const result = requireAuth('session.get', {}, acl);
    expect(result.allowed).toBe(false);
    expect(result.code).toBe(-32001);
    expect(result.message).toContain('Unauthorized');
  });

  it('returns -32001 for session-scoped method with empty token', () => {
    const result = requireAuth('session.get', { token: '' }, acl);
    expect(result.allowed).toBe(false);
    expect(result.code).toBe(-32001);
  });

  it('allows session-scoped method with valid non-empty token', () => {
    const result = requireAuth('session.get', { token: 'valid-session-token' }, acl);
    expect(result.allowed).toBe(true);
  });

  it('returns -32001 for admin method without token', () => {
    const result = requireAuth('engine.stop', {}, acl);
    expect(result.allowed).toBe(false);
    expect(result.code).toBe(-32001);
  });

  it('allows public methods without token', () => {
    const result = requireAuth('health', {}, acl);
    expect(result.allowed).toBe(true);
  });

  it('returns -32601 for unknown methods', () => {
    const result = requireAuth('unknown.method', {}, acl);
    expect(result.allowed).toBe(false);
    expect(result.code).toBe(-32601);
  });
});
