// @zaivim/gateway — ACL & token validation tests (Tasks A5 / C7 / H3)
// Verifies that the vim-rpc-server's actual production ACL enforces:
//   - public methods callable without a token
//   - session-scoped methods require a non-empty token (requireAuth)
//   - session-scoped methods additionally require the token to match the
//     session it claims to act on (validateSessionToken — H3)
//   - admin methods require the global admin token
//   - unknown methods return -32601
//
// Previously the tests called MethodACL.createDefault() which registers a
// DIFFERENT method set than server.ts (e.g. engine.stop, audit.query,
// session.pushMessage) — tests passed on a fictional ACL.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { requireAuth } from '../../method-acl.js';
import { createVimRpcACL, validateSessionToken, sessionTokenCache } from '../server.js';
import { generateAdminToken } from '../../admin-token.js';
import * as adminTokenModule from '../../admin-token.js';

describe('vim-rpc-server ACL — production method set (C7)', () => {
  const acl = createVimRpcACL();

  it('registers exactly the methods server.ts dispatches', () => {
    const methods = acl.listMethods();
    expect(Object.keys(methods).sort()).toEqual(
      [
        'agent.cancel',
        'agent.create',
        'chat.cancel',
        'chat.send',
        'config.reload',
        'health',
        'ping',
        'session.close',
        'session.create',
        'session.get',
        'session.list',
      ].sort(),
    );
  });

  it('does NOT register fictional methods from createDefault()', () => {
    expect(acl.has('engine.stop')).toBe(false);
    expect(acl.has('audit.query')).toBe(false);
    expect(acl.has('config.set')).toBe(false);
    expect(acl.has('session.pushMessage')).toBe(false);
    expect(acl.has('metrics')).toBe(false);
  });
});

describe('vim-rpc-server ACL — access-level enforcement (requireAuth)', () => {
  const acl = createVimRpcACL();

  it('allows public methods (health, ping, session.create) without token', () => {
    expect(requireAuth('health', {}, acl).allowed).toBe(true);
    expect(requireAuth('ping', {}, acl).allowed).toBe(true);
    expect(requireAuth('session.create', {}, acl).allowed).toBe(true);
  });

  it('rejects session-scoped method without token with -32001', () => {
    const r = requireAuth('session.get', {}, acl);
    expect(r.allowed).toBe(false);
    expect(r.code).toBe(-32001);
  });

  it('rejects session-scoped method with empty token with -32001', () => {
    const r = requireAuth('chat.send', { token: '' }, acl);
    expect(r.allowed).toBe(false);
    expect(r.code).toBe(-32001);
  });

  it('rejects admin method (config.reload) without token with -32001', () => {
    const r = requireAuth('config.reload', {}, acl);
    expect(r.allowed).toBe(false);
    expect(r.code).toBe(-32001);
  });

  it('returns -32601 for unknown method (not in production ACL)', () => {
    const r = requireAuth('engine.stop', {}, acl);
    expect(r.allowed).toBe(false);
    expect(r.code).toBe(-32601);
  });
});

describe('vim-rpc-server session token validation (H3)', () => {
  beforeEach(() => {
    sessionTokenCache.clear();
  });
  afterEach(() => {
    sessionTokenCache.clear();
  });

  it('rejects when sessionId is missing', () => {
    const r = validateSessionToken({ token: 'abc' });
    expect(r?.allowed).toBe(false);
    expect(r?.code).toBe(-32001);
  });

  it('rejects when token is missing', () => {
    const r = validateSessionToken({ sessionId: 's1' });
    expect(r?.allowed).toBe(false);
    expect(r?.code).toBe(-32001);
  });

  it('rejects when session was never created (token unknown)', () => {
    const r = validateSessionToken({ sessionId: 'unknown', token: 'any-string' });
    expect(r?.allowed).toBe(false);
    expect(r?.message).toContain('unknown');
  });

  it('rejects when token does not match the cached session token', () => {
    sessionTokenCache.set('s1', 'real-token');
    const r = validateSessionToken({ sessionId: 's1', token: 'wrong-token' });
    expect(r?.allowed).toBe(false);
    expect(r?.message).toContain('s1');
  });

  it('accepts when token matches the cached session token', () => {
    sessionTokenCache.set('s1', 'real-token');
    const r = validateSessionToken({ sessionId: 's1', token: 'real-token' });
    expect(r).toBeNull();
  });

  it('uses an explicit cache when passed (does not pollute module state)', () => {
    const local = new Map([['s2', 'tok-2']]);
    const ok = validateSessionToken({ sessionId: 's2', token: 'tok-2' }, local);
    const bad = validateSessionToken({ sessionId: 's2', token: 'tok-2' });
    expect(ok).toBeNull();
    expect(bad?.allowed).toBe(false);
  });
});

describe('vim-rpc-server admin token enforcement', () => {
  const acl = createVimRpcACL();

  beforeEach(() => {
    vi.spyOn(adminTokenModule, 'readAdminToken').mockReturnValue('admin-secret');
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects admin method with wrong token', () => {
    const r = requireAuth('config.reload', { token: 'wrong' }, acl);
    expect(r.allowed).toBe(false);
    expect(r.code).toBe(-32001);
  });

  it('accepts admin method with correct admin token', () => {
    const r = requireAuth('config.reload', { token: 'admin-secret' }, acl);
    expect(r.allowed).toBe(true);
  });

  it('generated admin token has expected length', () => {
    expect(generateAdminToken().length).toBeGreaterThan(30);
  });
});
