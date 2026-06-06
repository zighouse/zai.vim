// @zaivim/core — Session type runtime tests
// Verifies error classes, type exports, and ISessionStore contract.

import { describe, it, expect } from 'vitest';
import {
  ZaiSessionNotFoundError,
  ZaiSessionExpiredError,
  ZaiSessionMaxMessagesError,
  ZaiError,
  ErrorCodes,
} from '../index.js';
import type { ISessionStore, SessionMeta, Session, Message } from '../index.js';

describe('Session error classes', () => {
  it('ZaiSessionNotFoundError has correct properties', () => {
    const err = new ZaiSessionNotFoundError('session-abc');
    expect(err).toBeInstanceOf(ZaiError);
    expect(err).toBeInstanceOf(ZaiSessionNotFoundError);
    expect(err.code).toBe('ENGINE_SESSION_NOT_FOUND');
    expect(err.statusCode).toBe(404);
    expect(err.sessionId).toBe('session-abc');
    expect(err.message).toContain('session-abc');
  });

  it('ZaiSessionExpiredError has correct properties', () => {
    const err = new ZaiSessionExpiredError('session-xyz');
    expect(err).toBeInstanceOf(ZaiError);
    expect(err).toBeInstanceOf(ZaiSessionExpiredError);
    expect(err.code).toBe('ENGINE_SESSION_EXPIRED');
    expect(err.statusCode).toBe(410);
    expect(err.sessionId).toBe('session-xyz');
  });

  it('ZaiSessionMaxMessagesError has correct properties', () => {
    const err = new ZaiSessionMaxMessagesError('session-123', 1050, 1000);
    expect(err).toBeInstanceOf(ZaiError);
    expect(err).toBeInstanceOf(ZaiSessionMaxMessagesError);
    expect(err.code).toBe('ENGINE_SESSION_MAX_MESSAGES');
    expect(err.statusCode).toBe(422);
    expect(err.sessionId).toBe('session-123');
    expect(err.current).toBe(1050);
    expect(err.max).toBe(1000);
  });
});

describe('Error codes', () => {
  it('has session error codes', () => {
    expect(ErrorCodes.ENGINE_SESSION_NOT_FOUND).toBe('ENGINE_SESSION_NOT_FOUND');
    expect(ErrorCodes.ENGINE_SESSION_EXPIRED).toBe('ENGINE_SESSION_EXPIRED');
    expect(ErrorCodes.ENGINE_SESSION_MAX_MESSAGES).toBe('ENGINE_SESSION_MAX_MESSAGES');
  });
});

describe('Session interface backward compatibility', () => {
  it('Session works without new fields', () => {
    const session: Session = {
      id: 'test-id',
      messages: [],
      createdAt: Date.now(),
      config: {} as Session['config'],
      status: 'active',
    };
    expect(session.id).toBe('test-id');
    expect(session.status).toBe('active');
  });

  it('Session works with all new fields', () => {
    const session: Session = {
      id: 'test-id',
      messages: [],
      createdAt: Date.now(),
      config: {} as Session['config'],
      status: 'active',
      projectDir: '/home/user/project',
      version: '0.1.0',
      seqCounter: 42,
      reconnecting: false,
      disconnectedAt: undefined,
    };
    expect(session.projectDir).toBe('/home/user/project');
    expect(session.seqCounter).toBe(42);
  });

  it('Message works with optional seq field', () => {
    const msg: Message = { id: 'm1', role: 'user', content: 'hello', seq: 1 };
    expect(msg.seq).toBe(1);
  });

  it('Message works without seq field', () => {
    const msg: Message = { id: 'm1', role: 'user', content: 'hello' };
    expect(msg.seq).toBeUndefined();
  });
});

describe('SessionMeta type', () => {
  it('creates valid SessionMeta', () => {
    const meta: SessionMeta = {
      format_version: 1,
      engine_version: '0.1.0',
      created_at: '2026-06-06T10:00:00Z',
      project_dir: '/tmp/project',
    };
    expect(meta.format_version).toBe(1);
  });

  it('SessionMeta works without optional project_dir', () => {
    const meta: SessionMeta = {
      format_version: 1,
      engine_version: '0.1.0',
      created_at: '2026-06-06T10:00:00Z',
    };
    expect(meta.project_dir).toBeUndefined();
  });
});

describe('ISessionStore interface substitutability', () => {
  it('mock InMemoryStore satisfies ISessionStore', () => {
    const mockStore: ISessionStore = {
      create: (config?, projectDir?) => ({
        id: 'test',
        messages: [],
        createdAt: Date.now(),
        config: config ?? ({} as Session['config']),
        status: 'active',
        projectDir,
      }),
      get: () => undefined,
      close: async () => {},
      list: () => [],
      pushMessage: () => {},
      queryByProject: () => [],
      persistAll: async () => {},
      recoverFromDisk: async () => [],
      get activeCount() { return 0; },
    };

    const session = mockStore.create(undefined, '/tmp/project');
    expect(session.projectDir).toBe('/tmp/project');
    expect(mockStore.activeCount).toBe(0);
  });
});
