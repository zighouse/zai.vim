// @zaivim/gateway — stdio transport layer
// Reads lines from stdin → parse → ACL check → dispatch → write to stdout
// Supports event forwarding from EventBus → client stdout via $/notification

import { createInterface } from 'node:readline';
import { decodeLine, isRequest, isError, successResponse, errorResponse, encodeLine } from './jsonrpc-codec.js';
import { JSONRPC_ERROR_CODES } from '@zaivim/core';
import type { JsonRpcRequest, JsonRpcMessage } from '@zaivim/core';
import type { EngineAPI } from '@zaivim/core';
import { readPidFile, isProcessAlive } from '@zaivim/engine';
import { requireAuth, type MethodACL } from '../method-acl.js';
import { encodeNotification } from './notification-sender.js';
import type { EventBus, ClientManager } from '@zaivim/engine';
import type { TransportContext } from './transport-context.js';

type MethodHandler = (params: unknown) => unknown;

/**
 * Context for ACL and event system integration.
 */
export interface TransportOptions {
  acl?: MethodACL;
  eventBus?: EventBus;
  clientManager?: ClientManager;
  transportContext?: TransportContext;
}

/**
 * Create a stdio transport that reads JSON-RPC from stdin and writes to stdout.
 * @param engine - Engine API instance
 * @param pidPath - Optional PID file path for daemon cross-check
 * @param streams - Optional stream overrides for testing
 * @param opts - Optional ACL + event system integration
 */
export function createStdioTransport(
  engine: EngineAPI,
  pidPath?: string,
  streams?: { stdin: NodeJS.ReadStream; stdout: NodeJS.WriteStream },
  opts?: TransportOptions,
): void {
  const handlers = new Map<string, MethodHandler>();
  const acl = opts?.transportContext?.acl ?? opts?.acl;

  // Register built-in methods
  handlers.set('health', (params?: unknown) => {
    const health = engine.getHealth();
    let status = health.status;

    // Cross-check with PID file: if status is 'ok' but no daemon PID alive,
    // this is a throwaway engine from pipe mode — report 'down' (AC8)
    if (status === 'ok' && pidPath) {
      const pidData = readPidFile(pidPath);
      if (!pidData || !isProcessAlive(pidData.pid)) {
        status = 'down';
      }
    }

    return {
      status,
      version: engine.version,
      sandboxAvailable: health.sandboxAvailable,
      activeSessions: health.activeSessions,
      ...(acl ? { methods: acl.listMethods() } : {}),
    };
  });

  handlers.set('ping', () => ({
    status: 'ok',
    version: engine.version,
  }));

  handlers.set('metrics', () => {
    const eventBus = opts?.transportContext?.eventBus;
    return {
      version: engine.version,
      uptime: engine.uptime,
      activeSessions: engine.getHealth().activeSessions,
      eventListeners: {
        active: eventBus?.totalActiveListeners ?? 0,
      },
    };
  });

  handlers.set('stop', async (params?: unknown) => {
    // Admin token required — checked by ACL middleware
    await engine.destroy({ force: false, reason: 'jsonrpc_stop' });
    return { status: 'stopping' };
  });

  // ---- Project context (Story 1b.4) ----

  handlers.set('project-context', async (params?: unknown) => {
    const p = params as Record<string, unknown> | undefined;
    const dir = p?.dir as string | undefined;
    return engine.detectProjectContext(dir);
  });

  // ---- Session methods (Story 1a.3) ----

  handlers.set('session.create', async (params?: unknown) => {
    const p = params as Record<string, unknown> | undefined;
    const projectDir = p?.projectDir as string | undefined;
    const session = await engine.createSession(p?.config as any, projectDir);
    return { sessionId: session.id, status: session.status, createdAt: session.createdAt };
  });

  handlers.set('session.get', (params?: unknown) => {
    const p = params as Record<string, unknown>;
    const id = p.sessionId as string;
    const session = engine.getSession(id);
    if (!session) {
      throw new Error(`Session not found: ${id}`);
    }
    return {
      sessionId: session.id,
      status: session.status,
      createdAt: session.createdAt,
      projectDir: session.projectDir,
      messageCount: session.messages.length,
      messages: session.messages,
    };
  });

  handlers.set('session.list', (params?: unknown) => {
    const p = params as Record<string, unknown> | undefined;
    const filter = p?.status ? { status: p.status as 'active' | 'paused' | 'closed' } : undefined;
    const sessions = engine.listSessions(filter);
    return {
      activeSessions: sessions.filter(s => s.status === 'active' || s.status === 'paused').length,
      sessions: sessions.map(s => ({
        sessionId: s.id,
        status: s.status,
        createdAt: s.createdAt,
        projectDir: s.projectDir,
        messageCount: s.messageCount,
      })),
    };
  });

  handlers.set('session.close', async (params?: unknown) => {
    const p = params as Record<string, unknown>;
    const id = p.sessionId as string;
    await engine.closeSession(id);
    return { sessionId: id, status: 'closed' };
  });

  handlers.set('session.pushMessage', (params?: unknown) => {
    const p = params as Record<string, unknown>;
    const sessionId = p.sessionId as string;
    const msg = p.message as Record<string, unknown>;
    engine.pushSessionMessage(sessionId, {
      id: msg.id as string,
      role: msg.role as 'user' | 'assistant' | 'tool' | 'system',
      content: msg.content as string,
    });
    const session = engine.getSession(sessionId);
    return { sessionId, messageCount: session?.messages.length ?? 0 };
  });

  // ---- Approval / Override (Story 2.2, Subtask 2.1.1) ------------------------

  handlers.set('approval.override', async (params?: unknown) => {
    const p = params as Record<string, unknown>;
    const operationId = p.operationId as string;
    const acknowledgment = p.acknowledgment as string;
    const sessionId = p.sessionId as string;

    if (!operationId || !acknowledgment || !sessionId) {
      throw new Error('Missing required parameters: operationId, acknowledgment, sessionId');
    }

    await engine.requestOverride(operationId, acknowledgment, sessionId);
    return { status: 'overridden', operationId };
  });

  // ---- Story 3.5: Async diff review approval RPC handlers -------------------

  handlers.set('approval.accept', async (params?: unknown) => {
    const p = params as Record<string, unknown>;
    const changeId = p.changeId as string;
    if (!changeId) throw new Error('Missing required parameter: changeId');
    await engine.approvalAccept(changeId);
    return { status: 'accepted', changeId };
  });

  handlers.set('approval.reject', async (params?: unknown) => {
    const p = params as Record<string, unknown>;
    const changeId = p.changeId as string;
    if (!changeId) throw new Error('Missing required parameter: changeId');
    await engine.approvalReject(changeId);
    return { status: 'rejected', changeId };
  });

  handlers.set('approval.partial', async (params?: unknown) => {
    const p = params as Record<string, unknown>;
    const changeId = p.changeId as string;
    const acceptFiles = p.acceptFiles as string[] | undefined;
    const rejectFiles = p.rejectFiles as string[] | undefined;
    if (!changeId) throw new Error('Missing required parameter: changeId');
    await engine.approvalPartial(changeId, acceptFiles ?? [], rejectFiles ?? []);
    return { status: 'partial', changeId, acceptedFiles: acceptFiles, rejectedFiles: rejectFiles };
  });

  handlers.set('approval.batchAccept', async (params?: unknown) => {
    const p = params as Record<string, unknown>;
    const changeIds = p.changeIds as string[] | undefined;
    if (!changeIds || !Array.isArray(changeIds)) throw new Error('Missing required parameter: changeIds');
    await engine.approvalBatchAccept(changeIds);
    return { status: 'accepted', changeIds };
  });

  handlers.set('approval.batchReject', async (params?: unknown) => {
    const p = params as Record<string, unknown>;
    const changeIds = p.changeIds as string[] | undefined;
    if (!changeIds || !Array.isArray(changeIds)) throw new Error('Missing required parameter: changeIds');
    await engine.approvalBatchReject(changeIds);
    return { status: 'rejected', changeIds };
  });

  handlers.set('approval.listPending', async (params?: unknown) => {
    const p = params as Record<string, unknown> | undefined;
    const sessionId = p?.sessionId as string | undefined;
    return engine.approvalListPending(sessionId);
  });

  const input = streams?.stdin ?? process.stdin;
  const output = streams?.stdout ?? process.stdout;
  const rl = createInterface({ input });

  // ---- Event forwarding: EventBus → stdout via $/notification ---------------
  const ctx = opts?.transportContext;
  let eventDisposers: Array<() => void> = [];

  if (ctx) {
    const clientId = ctx.clientManager.generateId();

    const eventTypes: Array<{ type: string; handler: (data: unknown) => void }> = [
      { type: 'session.created', handler: (data) => output.write(encodeNotification('session.created', data)) },
      { type: 'session.closed', handler: (data) => output.write(encodeNotification('session.closed', data)) },
      { type: 'session.approaching_limit', handler: (data) => output.write(encodeNotification('session.approaching_limit', data)) },
      { type: 'session.auto_trimmed', handler: (data) => output.write(encodeNotification('session.auto_trimmed', data)) },
      { type: 'session.persistence.dropped', handler: (data) => output.write(encodeNotification('session.persistence.dropped', data)) },
      { type: 'session.recovered', handler: (data) => output.write(encodeNotification('session.recovered', data)) },
      { type: 'session.project_context_updated', handler: (data) => output.write(encodeNotification('session.project_context_updated', data)) },
      { type: 'security.degraded', handler: (data) => output.write(encodeNotification('security.degraded', data)) },
      { type: 'security.secure', handler: (data) => output.write(encodeNotification('security.secure', data)) },
      { type: 'engine.warning', handler: (data) => output.write(encodeNotification('engine.warning', data)) },
      { type: 'engine.shutdown', handler: (data) => output.write(encodeNotification('engine.shutdown', data)) },
      { type: 'provider.retry', handler: (data) => output.write(encodeNotification('provider.retry', data)) },
      { type: 'provider.recovered', handler: (data) => output.write(encodeNotification('provider.recovered', data)) },
      { type: 'provider.auth_failed', handler: (data) => output.write(encodeNotification('provider.auth_failed', data)) },
      { type: 'provider.model_not_found', handler: (data) => output.write(encodeNotification('provider.model_not_found', data)) },
      { type: 'provider.rate_limited', handler: (data) => output.write(encodeNotification('provider.rate_limited', data)) },
      { type: 'provider.fallback', handler: (data) => output.write(encodeNotification('provider.fallback', data)) },
      { type: 'provider.status', handler: (data) => output.write(encodeNotification('provider.status', data)) },
      { type: 'context.auto_trimmed', handler: (data) => output.write(encodeNotification('context.auto_trimmed', data)) },

      // Story 3.5: Approval event forwarding
      { type: 'approval.request', handler: (data) => output.write(encodeNotification('approval.request', data)) },
      { type: 'approval.resolved', handler: (data) => output.write(encodeNotification('approval.resolved', data)) },
      { type: 'approval.timeout', handler: (data) => output.write(encodeNotification('approval.timeout', data)) },
      { type: 'approval.queued', handler: (data) => output.write(encodeNotification('approval.queued', data)) },
      { type: 'approval.stale', handler: (data) => output.write(encodeNotification('approval.stale', data)) },
      { type: 'approval.loop_detected', handler: (data) => output.write(encodeNotification('approval.loop_detected', data)) },
    ];

    for (const { type, handler } of eventTypes) {
      const dispose = ctx.eventBus.on(type as any, handler as any);
      eventDisposers.push(dispose);
      ctx.clientManager.trackDisposer(clientId, dispose);
    }
  }

  // ---- Main dispatch loop ---------------------------------------------------

  rl.on('line', async (line: string) => {
    const msg = decodeLine(line);

    // If decode produced an error, write it out
    if (isError(msg)) {
      output.write(encodeLine(msg));
      return;
    }

    // Only handle requests (have id + method)
    if (isRequest(msg)) {
      const request = msg as JsonRpcRequest;
      const method = request.method;

      // ACL check (if ACL is configured)
      if (acl) {
        const auth = requireAuth(method, request.params, acl);
        if (!auth.allowed) {
          const response = errorResponse(request.id, auth.code ?? -32603, auth.message ?? 'Unauthorized');
          output.write(encodeLine(response));
          return;
        }
      }

      const handler = handlers.get(method);

      if (handler) {
        try {
          const result = await handler(request.params);
          const response = successResponse(request.id, result);
          output.write(encodeLine(response));
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : 'Internal error';
          const response = errorResponse(request.id, JSONRPC_ERROR_CODES.INTERNAL_ERROR, errMsg);
          output.write(encodeLine(response));
        }
      } else {
        const response = errorResponse(
          request.id,
          JSONRPC_ERROR_CODES.METHOD_NOT_FOUND,
          `Method not found: ${method}`,
        );
        output.write(encodeLine(response));
      }
    }
    // Notifications (no id) are silently handled or ignored in MVP
  });

  rl.on('close', () => {
    // Cleanup event listeners
    for (const dispose of eventDisposers) {
      dispose();
    }
    eventDisposers = [];

    // stdin closed — exit cleanly (pipe mode: echo '...' | zaivim)
    process.exit(0);
  });
}

/**
 * Register a custom method handler.
 */
export function registerMethod(
  handlers: Map<string, MethodHandler>,
  method: string,
  handler: MethodHandler,
): void {
  handlers.set(method, handler);
}
