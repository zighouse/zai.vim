// @zaivim/gateway — MethodACL unit tests
// Tests: public methods pass, protected methods require token, admin token validation

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MethodACL, requireAuth } from '../method-acl.js';
import { ADMIN_TOKEN_PATH, ADMIN_TOKEN_DIR } from '../admin-token.js';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';

describe('MethodACL', () => {
  let acl: MethodACL;

  beforeEach(() => {
    acl = new MethodACL();
    acl.register('health', { access: 'public', description: 'Health check' });
    acl.register('ping', { access: 'public', description: 'Ping' });
    acl.register('session.create', { access: 'session-scoped', description: 'Create session' });
    acl.register('engine.stop', { access: 'admin', description: 'Stop engine' });
  });

  it('returns public access for public methods', () => {
    expect(acl.getAccess('health')).toBe('public');
    expect(acl.getAccess('ping')).toBe('public');
  });

  it('returns session-scoped access for session methods', () => {
    expect(acl.getAccess('session.create')).toBe('session-scoped');
  });

  it('returns admin access for admin methods', () => {
    expect(acl.getAccess('engine.stop')).toBe('admin');
  });

  it('returns undefined for unknown methods', () => {
    expect(acl.getAccess('nonexistent')).toBeUndefined();
  });

  it('has returns true only for registered methods', () => {
    expect(acl.has('health')).toBe(true);
    expect(acl.has('nonexistent')).toBe(false);
  });

  it('listMethods returns all methods with access levels', () => {
    const methods = acl.listMethods();
    expect(methods).toEqual({
      health: 'public',
      ping: 'public',
      'session.create': 'session-scoped',
      'engine.stop': 'admin',
    });
  });

  it('createDefault registers all standard methods', () => {
    const defaultAcl = MethodACL.createDefault();
    expect(defaultAcl.has('health')).toBe(true);
    expect(defaultAcl.has('ping')).toBe(true);
    expect(defaultAcl.has('metrics')).toBe(true);
    expect(defaultAcl.has('session.create')).toBe(true);
    expect(defaultAcl.has('session.get')).toBe(true);
    expect(defaultAcl.has('session.list')).toBe(true);
    expect(defaultAcl.has('session.close')).toBe(true);
    expect(defaultAcl.has('session.pushMessage')).toBe(true);
    expect(defaultAcl.has('engine.stop')).toBe(true);
    expect(defaultAcl.has('audit.query')).toBe(true);
    expect(defaultAcl.has('config.set')).toBe(true);
  });
});

describe('requireAuth', () => {
  let acl: MethodACL;

  beforeEach(() => {
    acl = new MethodACL();
    acl.register('health', { access: 'public', description: 'Health check' });
    acl.register('session.create', { access: 'session-scoped', description: 'Create session' });
    acl.register('engine.stop', { access: 'admin', description: 'Stop engine' });
  });

  describe('public methods', () => {
    it('allows public methods without token', () => {
      const result = requireAuth('health', undefined, acl);
      expect(result.allowed).toBe(true);
    });

    it('allows public methods with null params', () => {
      const result = requireAuth('health', null, acl);
      expect(result.allowed).toBe(true);
    });

    it('allows public methods with empty params', () => {
      // Register a temporary test method to verify
      const testAcl = new MethodACL();
      testAcl.register('test.public', { access: 'public', description: 'Test' });
      const result = requireAuth('test.public', {}, testAcl);
      expect(result.allowed).toBe(true);
    });
  });

  describe('session-scoped methods', () => {
    it('allows session-scoped with valid token', () => {
      const result = requireAuth('session.create', { token: 'sess-token-123' }, acl);
      expect(result.allowed).toBe(true);
    });

    it('rejects session-scoped without token', () => {
      const result = requireAuth('session.create', {}, acl);
      expect(result.allowed).toBe(false);
      expect(result.code).toBe(-32001);
    });

    it('rejects session-scoped with null params', () => {
      const result = requireAuth('session.create', null, acl);
      expect(result.allowed).toBe(false);
    });

    it('rejects session-scoped with undefined params', () => {
      const result = requireAuth('session.create', undefined, acl);
      expect(result.allowed).toBe(false);
    });

    it('rejects session-scoped with non-string token', () => {
      const result = requireAuth('session.create', { token: 12345 }, acl);
      expect(result.allowed).toBe(false);
    });
  });

  describe('admin methods', () => {
    let testTokenDir: string;

    beforeEach(() => {
      // Use a temp directory for admin token
      testTokenDir = resolve(tmpdir(), `zaivim-test-admin-token-${Date.now()}`);
      mkdirSync(testTokenDir, { recursive: true });
    });

    afterEach(() => {
      try { rmSync(testTokenDir, { recursive: true }); } catch { /* ok */ }
    });

    it('rejects admin method without token', () => {
      const result = requireAuth('engine.stop', {}, acl);
      expect(result.allowed).toBe(false);
      expect(result.code).toBe(-32001);
    });

    it('rejects admin method when admin token file does not exist', () => {
      const result = requireAuth('engine.stop', { token: 'some-token' }, acl);
      expect(result.allowed).toBe(false);
      expect(result.code).toBe(-32001);
    });

    it('rejects admin method with non-matching token', () => {
      const result = requireAuth('engine.stop', { token: 'wrong-token' }, acl);
      expect(result.allowed).toBe(false);
    });

    it('rejects admin method with empty token', () => {
      const result = requireAuth('engine.stop', { token: '' }, acl);
      expect(result.allowed).toBe(false);
    });
  });

  describe('unknown methods', () => {
    it('rejects unknown methods with method_not_found', () => {
      const result = requireAuth('nonexistent', {}, acl);
      expect(result.allowed).toBe(false);
      expect(result.code).toBe(-32601);
      expect(result.message).toContain('Method not found');
    });
  });
});

describe('MethodACL default instance', () => {
  it('includes all required methods with correct access levels', () => {
    const acl = MethodACL.createDefault();
    const methods = acl.listMethods();

    expect(methods.health).toBe('public');
    expect(methods.ping).toBe('public');
    expect(methods.metrics).toBe('public');
    expect(methods['session.create']).toBe('public');
    expect(methods['session.get']).toBe('session-scoped');
    expect(methods['session.list']).toBe('session-scoped');
    expect(methods['session.close']).toBe('session-scoped');
    expect(methods['session.pushMessage']).toBe('session-scoped');
    expect(methods['engine.stop']).toBe('admin');
    expect(methods['audit.query']).toBe('admin');
    expect(methods['config.set']).toBe('admin');
  });
});
