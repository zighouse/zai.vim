// @zaivim/gateway — HandlerRegistry unit tests (Story 4.3 Task 5)

import { describe, it, expect, vi } from 'vitest';
import { HandlerRegistry } from '../handler-registry.js';
import { MethodACL } from '../method-acl.js';
import { TransportContext } from '../stdio/transport-context.js';
import { EventBus, ClientManager } from '@zaivim/engine';
import type { EngineAPI } from '@zaivim/core';
import { ZaiError } from '@zaivim/core';

function createMockEngine(): EngineAPI {
  return {
    version: '0.1.0',
    getHealth: vi.fn().mockReturnValue({
      status: 'ok',
      sandboxAvailable: false,
      activeSessions: 0,
    }),
    uptime: 1000,
    createSession: vi.fn().mockResolvedValue({ id: 'sess-1', status: 'active', createdAt: 1 }),
    listSessions: vi.fn().mockReturnValue([]),
    getSession: vi.fn().mockReturnValue(undefined),
    closeSession: vi.fn().mockResolvedValue(undefined),
    pushSessionMessage: vi.fn(),
    createAgent: vi.fn(),
    destroy: vi.fn().mockResolvedValue(undefined),
  } as unknown as EngineAPI;
}

describe('HandlerRegistry', () => {
  it('registers built-in handlers on construction', () => {
    const engine = createMockEngine();
    const registry = new HandlerRegistry(engine);
    expect(registry.has('health')).toBe(true);
    expect(registry.has('ping')).toBe(true);
    expect(registry.has('session.create')).toBe(true);
    expect(registry.has('approval.accept')).toBe(true);
    expect(registry.methods()).toContain('metrics');
  });

  it('dispatches health and returns engine status', async () => {
    const engine = createMockEngine();
    const registry = new HandlerRegistry(engine);

    const result = await registry.dispatch({ jsonrpc: '2.0', id: 1, method: 'health' });
    expect(result.ok).toBe(true);
    expect(result.result).toMatchObject({ status: 'ok', version: '0.1.0' });
  });

  it('H2: /health snapshot is cached for the TTL window (ADR-24)', async () => {
    const engine = createMockEngine();
    // TTL of 60ms so the test resolves fast — the production default is 60_000ms.
    const registry = new HandlerRegistry(engine, undefined, undefined, undefined, 60);

    registry.getHealthSnapshot();
    registry.getHealthSnapshot();
    registry.getHealthSnapshot();
    expect(engine.getHealth).toHaveBeenCalledTimes(1);

    // After the TTL expires, the next call re-computes.
    await new Promise((r) => setTimeout(r, 80));
    registry.getHealthSnapshot();
    expect(engine.getHealth).toHaveBeenCalledTimes(2);
  });

  it('H2: invalidateHealthCache forces re-computation on next read', () => {
    const engine = createMockEngine();
    const registry = new HandlerRegistry(engine);

    registry.getHealthSnapshot();
    registry.getHealthSnapshot();
    expect(engine.getHealth).toHaveBeenCalledTimes(1);

    registry.invalidateHealthCache();
    registry.getHealthSnapshot();
    expect(engine.getHealth).toHaveBeenCalledTimes(2);
  });

  it('returns method_not_found for unregistered methods', async () => {
    const engine = createMockEngine();
    const registry = new HandlerRegistry(engine);

    const result = await registry.dispatch({ jsonrpc: '2.0', id: 1, method: 'unknown.method' });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe(-32601);
    expect(result.errorMessage).toContain('Method not found');
  });

  it('serializes handler errors as internal_error', async () => {
    const engine = createMockEngine();
    const registry = new HandlerRegistry(engine);
    registry.register('boom', () => {
      throw new Error('handler crashed');
    });

    const result = await registry.dispatch({ jsonrpc: '2.0', id: 1, method: 'boom' });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe(-32603);
    expect(result.errorMessage).toBe('handler crashed');
  });

  it('preserves ZaiError code, statusCode, and detail via toJSON (AC8 / ADR-10)', async () => {
    const engine = createMockEngine();
    const registry = new HandlerRegistry(engine);
    registry.register('zai-boom', () => {
      throw new ZaiError('session gone', 'ENGINE_SESSION_NOT_FOUND', 404, { sessionId: 'sX' });
    });

    const result = await registry.dispatch({ jsonrpc: '2.0', id: 1, method: 'zai-boom' });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe(404);
    expect(result.errorMessage).toBe('session gone');
    expect(result.errorData).toMatchObject({
      code: 'ENGINE_SESSION_NOT_FOUND',
      message: 'session gone',
    });
  });

  it('awaits async handlers', async () => {
    const engine = createMockEngine();
    const registry = new HandlerRegistry(engine);
    registry.register('async', async () => ({ value: 42 }));

    const result = await registry.dispatch({ jsonrpc: '2.0', id: 1, method: 'async' });
    expect(result.ok).toBe(true);
    expect(result.result).toEqual({ value: 42 });
  });

  it('shares handlers across multiple transports', async () => {
    const engine = createMockEngine();
    const registry = new HandlerRegistry(engine);

    // The same registry instance is what HTTP and WS would use.
    const result1 = await registry.dispatch({ jsonrpc: '2.0', id: 1, method: 'ping' });
    const result2 = await registry.dispatch({ jsonrpc: '2.0', id: 2, method: 'ping' });
    expect(result1.ok).toBe(true);
    expect(result2.ok).toBe(true);
  });

  it('returns ACL for the health methods map when transportContext is supplied', () => {
    const engine = createMockEngine();
    const eventBus = new EventBus();
    const clientManager = new ClientManager(eventBus);
    const transportContext = new TransportContext({ eventBus, clientManager });
    const registry = new HandlerRegistry(engine, undefined, transportContext);

    expect(registry.acl).toBeDefined();
    expect(registry.acl?.getAccess('health')).toBe('public');
  });

  it('accepts a standalone ACL when no transportContext is supplied (backward-compat)', () => {
    const engine = createMockEngine();
    const acl = MethodACL.createDefault();
    const registry = new HandlerRegistry(engine, undefined, undefined, acl);

    expect(registry.acl).toBe(acl);
  });

  it('blocks admin methods through ACL', async () => {
    const engine = createMockEngine();
    const acl = MethodACL.createDefault();
    const registry = new HandlerRegistry(engine, undefined, undefined, acl);

    const result = await registry.dispatch({ jsonrpc: '2.0', id: 1, method: 'audit.query' });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe(-32001);
  });

  it('returns down when engine is ok but PID file is missing', async () => {
    const engine = createMockEngine();
    const registry = new HandlerRegistry(engine, '/nonexistent/engine.pid');

    const result = await registry.dispatch({ jsonrpc: '2.0', id: 1, method: 'health' });
    expect(result.ok).toBe(true);
    expect((result.result as { status: string }).status).toBe('down');
  });

  it('ping returns version+status', async () => {
    const engine = createMockEngine();
    const registry = new HandlerRegistry(engine);
    const r = await registry.dispatch({ jsonrpc: '2.0', id: 1, method: 'ping' });
    expect((r.result as { status: string }).status).toBe('ok');
    expect((r.result as { version: string }).version).toBe('0.1.0');
  });

  it('metrics reports uptime and event-listener count', async () => {
    const eventBus = new EventBus();
    const clientManager = new ClientManager(eventBus);
    const ctx = new TransportContext({ eventBus, clientManager });
    const engine = createMockEngine();
    const registry = new HandlerRegistry(engine, undefined, ctx);

    const r = await registry.dispatch({ jsonrpc: '2.0', id: 1, method: 'metrics' });
    expect((r.result as { version: string }).version).toBe('0.1.0');
    expect((r.result as { eventListeners: { active: number } }).eventListeners.active).toBe(0);
  });

  it('stop destroys the engine', async () => {
    const engine = createMockEngine();
    const registry = new HandlerRegistry(engine);
    const r = await registry.dispatch({ jsonrpc: '2.0', id: 1, method: 'stop' });
    expect(engine.destroy).toHaveBeenCalled();
    expect((r.result as { status: string }).status).toBe('stopping');
  });

  it('session.create forwards config and projectDir', async () => {
    const engine = createMockEngine();
    const registry = new HandlerRegistry(engine);
    const r = await registry.dispatch({
      jsonrpc: '2.0',
      id: 1,
      method: 'session.create',
      params: { projectDir: '/p', config: { foo: 'bar' } },
    });
    expect(engine.createSession).toHaveBeenCalledWith({ foo: 'bar' }, '/p');
    expect((r.result as { sessionId: string }).sessionId).toBe('sess-1');
  });

  it('session.get returns 404-style error when not found', async () => {
    const engine = createMockEngine();
    const registry = new HandlerRegistry(engine);
    const r = await registry.dispatch({
      jsonrpc: '2.0',
      id: 1,
      method: 'session.get',
      params: { sessionId: 'nope' },
    });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toContain('Session not found');
  });

  it('session.get returns session details when present', async () => {
    const engine = createMockEngine();
    (engine.getSession as ReturnType<typeof vi.fn>).mockReturnValue({
      id: 's1', status: 'active', createdAt: 1, projectDir: '/p', messages: [{ id: 'm1' }],
    });
    const registry = new HandlerRegistry(engine);
    const r = await registry.dispatch({
      jsonrpc: '2.0',
      id: 1,
      method: 'session.get',
      params: { sessionId: 's1' },
    });
    expect((r.result as { sessionId: string }).sessionId).toBe('s1');
    expect((r.result as { messageCount: number }).messageCount).toBe(1);
  });

  it('session.list filters by status when provided', async () => {
    const engine = createMockEngine();
    (engine.listSessions as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: 's1', status: 'active', createdAt: 1, projectDir: '/p', messageCount: 1 },
      { id: 's2', status: 'closed', createdAt: 2, projectDir: '/q', messageCount: 2 },
    ]);
    const registry = new HandlerRegistry(engine);
    const r = await registry.dispatch({
      jsonrpc: '2.0',
      id: 1,
      method: 'session.list',
      params: { status: 'active' },
    });
    expect(engine.listSessions).toHaveBeenCalledWith({ status: 'active' });
    expect((r.result as { activeSessions: number }).activeSessions).toBe(1);
  });

  it('session.close delegates to engine.closeSession', async () => {
    const engine = createMockEngine();
    const registry = new HandlerRegistry(engine);
    await registry.dispatch({
      jsonrpc: '2.0',
      id: 1,
      method: 'session.close',
      params: { sessionId: 'sx' },
    });
    expect(engine.closeSession).toHaveBeenCalledWith('sx');
  });

  it('session.pushMessage forwards the message to the engine', async () => {
    const engine = createMockEngine();
    (engine.getSession as ReturnType<typeof vi.fn>).mockReturnValue({ messages: [{ id: 'm2' }] });
    const registry = new HandlerRegistry(engine);
    const r = await registry.dispatch({
      jsonrpc: '2.0',
      id: 1,
      method: 'session.pushMessage',
      params: {
        sessionId: 'sx',
        message: { id: 'm1', role: 'user', content: 'hi' },
      },
    });
    expect(engine.pushSessionMessage).toHaveBeenCalled();
    expect((r.result as { sessionId: string }).sessionId).toBe('sx');
  });

  it('approval.accept calls engine.approvalAccept', async () => {
    const engine = { ...createMockEngine(), approvalAccept: vi.fn().mockResolvedValue(undefined) } as unknown as EngineAPI;
    const registry = new HandlerRegistry(engine);
    const r = await registry.dispatch({
      jsonrpc: '2.0',
      id: 1,
      method: 'approval.accept',
      params: { changeId: 'c1' },
    });
    expect((engine as any).approvalAccept).toHaveBeenCalledWith('c1');
    expect((r.result as { status: string }).status).toBe('accepted');
  });

  it('approval.partial passes accept/reject file lists', async () => {
    const engine = {
      ...createMockEngine(),
      approvalPartial: vi.fn().mockResolvedValue(undefined),
    } as unknown as EngineAPI;
    const registry = new HandlerRegistry(engine);
    const r = await registry.dispatch({
      jsonrpc: '2.0',
      id: 1,
      method: 'approval.partial',
      params: { changeId: 'c1', acceptFiles: ['a.ts'], rejectFiles: ['b.ts'] },
    });
    expect((engine as any).approvalPartial).toHaveBeenCalledWith('c1', ['a.ts'], ['b.ts']);
    expect((r.result as { status: string }).status).toBe('partial');
  });

  it('approval.batch_accept validates changeIds is an array', async () => {
    const engine = {
      ...createMockEngine(),
      approvalBatchAccept: vi.fn().mockResolvedValue(undefined),
    } as unknown as EngineAPI;
    const registry = new HandlerRegistry(engine);
    const r = await registry.dispatch({
      jsonrpc: '2.0',
      id: 1,
      method: 'approval.batch_accept',
      params: { changeIds: 'not-an-array' },
    });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toContain('changeIds');
  });

  it('approval.batch_reject validates changeIds is an array', async () => {
    const engine = {
      ...createMockEngine(),
      approvalBatchReject: vi.fn().mockResolvedValue(undefined),
    } as unknown as EngineAPI;
    const registry = new HandlerRegistry(engine);
    const r = await registry.dispatch({
      jsonrpc: '2.0',
      id: 1,
      method: 'approval.batch_reject',
      params: {},
    });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toContain('changeIds');
  });

  it('approval.reject requires changeId', async () => {
    const engine = {
      ...createMockEngine(),
      approvalReject: vi.fn().mockResolvedValue(undefined),
    } as unknown as EngineAPI;
    const registry = new HandlerRegistry(engine);
    const r = await registry.dispatch({
      jsonrpc: '2.0',
      id: 1,
      method: 'approval.reject',
      params: {},
    });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toContain('changeId');
  });

  it('approval.partial requires changeId', async () => {
    const engine = {
      ...createMockEngine(),
      approvalPartial: vi.fn().mockResolvedValue(undefined),
    } as unknown as EngineAPI;
    const registry = new HandlerRegistry(engine);
    const r = await registry.dispatch({
      jsonrpc: '2.0',
      id: 1,
      method: 'approval.partial',
      params: {},
    });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toContain('changeId');
  });

  it('approval.override succeeds when all params are present', async () => {
    const engine = {
      ...createMockEngine(),
      requestOverride: vi.fn().mockResolvedValue(undefined),
    } as unknown as EngineAPI;
    const registry = new HandlerRegistry(engine);
    const r = await registry.dispatch({
      jsonrpc: '2.0',
      id: 1,
      method: 'approval.override',
      params: { operationId: 'op', acknowledgment: 'ack', sessionId: 'sx' },
    });
    expect((engine as any).requestOverride).toHaveBeenCalledWith('op', 'ack', 'sx');
    expect((r.result as { status: string }).status).toBe('overridden');
  });

  it('approval.batch_accept succeeds with array param', async () => {
    const engine = {
      ...createMockEngine(),
      approvalBatchAccept: vi.fn().mockResolvedValue(undefined),
    } as unknown as EngineAPI;
    const registry = new HandlerRegistry(engine);
    const r = await registry.dispatch({
      jsonrpc: '2.0',
      id: 1,
      method: 'approval.batch_accept',
      params: { changeIds: ['c1', 'c2'] },
    });
    expect((engine as any).approvalBatchAccept).toHaveBeenCalledWith(['c1', 'c2']);
    expect((r.result as { status: string }).status).toBe('accepted');
  });

  it('approval.batch_reject succeeds with array param', async () => {
    const engine = {
      ...createMockEngine(),
      approvalBatchReject: vi.fn().mockResolvedValue(undefined),
    } as unknown as EngineAPI;
    const registry = new HandlerRegistry(engine);
    const r = await registry.dispatch({
      jsonrpc: '2.0',
      id: 1,
      method: 'approval.batch_reject',
      params: { changeIds: ['c1'] },
    });
    expect((engine as any).approvalBatchReject).toHaveBeenCalledWith(['c1']);
    expect((r.result as { status: string }).status).toBe('rejected');
  });

  it('approval.accept requires changeId', async () => {
    const engine = {
      ...createMockEngine(),
      approvalAccept: vi.fn().mockResolvedValue(undefined),
    } as unknown as EngineAPI;
    const registry = new HandlerRegistry(engine);
    const r = await registry.dispatch({
      jsonrpc: '2.0',
      id: 1,
      method: 'approval.accept',
      params: {},
    });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toContain('changeId');
  });

  it('approval.listPending works with no sessionId', async () => {
    const engine = {
      ...createMockEngine(),
      approvalListPending: vi.fn().mockResolvedValue([]),
    } as unknown as EngineAPI;
    const registry = new HandlerRegistry(engine);
    const r = await registry.dispatch({
      jsonrpc: '2.0',
      id: 1,
      method: 'approval.listPending',
      params: undefined,
    });
    expect((engine as any).approvalListPending).toHaveBeenCalledWith(undefined);
    expect(r.ok).toBe(true);
  });

  it('approval.listPending forwards optional sessionId', async () => {
    const engine = {
      ...createMockEngine(),
      approvalListPending: vi.fn().mockResolvedValue([{ id: 'c1' }]),
    } as unknown as EngineAPI;
    const registry = new HandlerRegistry(engine);
    const r = await registry.dispatch({
      jsonrpc: '2.0',
      id: 1,
      method: 'approval.listPending',
      params: { sessionId: 'sx' },
    });
    expect((engine as any).approvalListPending).toHaveBeenCalledWith('sx');
    expect(r.result).toEqual([{ id: 'c1' }]);
  });

  it('approval.override requires all three params', async () => {
    const engine = {
      ...createMockEngine(),
      requestOverride: vi.fn().mockResolvedValue(undefined),
    } as unknown as EngineAPI;
    const registry = new HandlerRegistry(engine);
    const r = await registry.dispatch({
      jsonrpc: '2.0',
      id: 1,
      method: 'approval.override',
      params: { operationId: 'op', acknowledgment: 'ack' },
    });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toContain('Missing required parameters');
  });

  it('project-context forwards the optional dir', async () => {
    const engine = {
      ...createMockEngine(),
      detectProjectContext: vi.fn().mockResolvedValue({ root: '/r' }),
    } as unknown as EngineAPI;
    const registry = new HandlerRegistry(engine);
    const r = await registry.dispatch({
      jsonrpc: '2.0',
      id: 1,
      method: 'project-context',
      params: { dir: '/some/dir' },
    });
    expect((engine as any).detectProjectContext).toHaveBeenCalledWith('/some/dir');
    expect(r.result).toEqual({ root: '/r' });
  });
});
