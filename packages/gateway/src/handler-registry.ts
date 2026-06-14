// @zaivim/gateway — Shared JSON-RPC handler registry
// Extracted from stdio transport (Story 4.3) so HTTP/WS/stdio all dispatch
// through one set of handlers — methods registered once, served over N transports.

import type { EngineAPI } from '@zaivim/core';
import { JSONRPC_ERROR_CODES } from '@zaivim/core';
import type { JsonRpcRequest } from '@zaivim/core';
import { ZaiError } from '@zaivim/core';
import { readPidFile, isProcessAlive } from '@zaivim/engine';
import { requireAuth, type MethodACL } from './method-acl.js';
import type { TransportContext } from './stdio/transport-context.js';

/** Method handler — sync or async, returns JSON-serialisable result or throws. */
export type MethodHandler = (params: unknown) => unknown | Promise<unknown>;

/** Dispatch outcome — successful response or JSON-RPC error envelope. */
export interface DispatchResult {
  readonly ok: boolean;
  readonly result?: unknown;
  readonly errorCode?: number;
  readonly errorMessage?: string;
  /** Extra error payload — for ZaiError, the result of toJSON() (code/message/stack). */
  readonly errorData?: unknown;
}

/**
 * HandlerRegistry owns every JSON-RPC method handler. Transports (stdio,
 * HTTP, WS) call `dispatch()` for each incoming request; they never touch
 * the handler map directly.
 */
export class HandlerRegistry {
  readonly #handlers = new Map<string, MethodHandler>();
  readonly #engine: EngineAPI;
  readonly #pidPath?: string;
  readonly #transportContext?: TransportContext;
  readonly #standaloneAcl?: MethodACL;

  constructor(
    engine: EngineAPI,
    pidPath?: string,
    transportContext?: TransportContext,
    standaloneAcl?: MethodACL,
  ) {
    this.#engine = engine;
    this.#pidPath = pidPath;
    this.#transportContext = transportContext;
    this.#standaloneAcl = standaloneAcl;
    this.#registerBuiltins();
  }

  /** Register (or override) a method handler. */
  register(method: string, handler: MethodHandler): void {
    this.#handlers.set(method, handler);
  }

  /** True when a handler is registered for `method`. */
  has(method: string): boolean {
    return this.#handlers.has(method);
  }

  /** All registered method names. */
  methods(): string[] {
    return Array.from(this.#handlers.keys());
  }

  /** ACL in use (if any) — transports need this for the /health methods map. */
  get acl(): MethodACL | undefined {
    return this.#transportContext?.acl ?? this.#standaloneAcl;
  }

  /**
   * Apply ACL + dispatch a request. Returns a `DispatchResult` so the
   * transport can format the wire envelope (line-delimited JSON, HTTP body,
   * or WS frame) without re-implementing the ACL rules.
   */
  async dispatch(request: JsonRpcRequest): Promise<DispatchResult> {
    const method = request.method;
    const acl = this.acl;

    if (acl) {
      const auth = requireAuth(method, request.params, acl);
      if (!auth.allowed) {
        return {
          ok: false,
          errorCode: auth.code ?? JSONRPC_ERROR_CODES.INTERNAL_ERROR,
          errorMessage: auth.message ?? 'Unauthorized',
        };
      }
    }

    const handler = this.#handlers.get(method);
    if (!handler) {
      return {
        ok: false,
        errorCode: JSONRPC_ERROR_CODES.METHOD_NOT_FOUND,
        errorMessage: `Method not found: ${method}`,
      };
    }

    try {
      const result = await handler(request.params);
      return { ok: true, result };
    } catch (err) {
      // ADR-10 — ZaiError carries domain code, statusCode, and detail that
      // must propagate to the client. Plain Error collapses to internal_error.
      if (err instanceof ZaiError) {
        return {
          ok: false,
          errorCode: err.statusCode || JSONRPC_ERROR_CODES.INTERNAL_ERROR,
          errorMessage: err.message,
          errorData: err.toJSON(),
        };
      }
      const errorMessage = err instanceof Error ? err.message : 'Internal error';
      return {
        ok: false,
        errorCode: JSONRPC_ERROR_CODES.INTERNAL_ERROR,
        errorMessage,
      };
    }
  }

  /**
   * Register the default built-in handlers. Mirrors what stdio/transport.ts
   * previously registered inline — keeps backward-compatible semantics.
   */
  #registerBuiltins(): void {
    const engine = this.#engine;
    const pidPath = this.#pidPath;
    const ctx = this.#transportContext;

    this.register('health', (params?: unknown) => {
      const health = engine.getHealth();
      let status = health.status;

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
        ...(this.acl ? { methods: this.acl.listMethods() } : {}),
      };
    });

    this.register('ping', () => ({
      status: 'ok',
      version: engine.version,
    }));

    this.register('metrics', () => {
      const eventBus = ctx?.eventBus;
      return {
        version: engine.version,
        uptime: engine.uptime,
        activeSessions: engine.getHealth().activeSessions,
        eventListeners: {
          active: eventBus?.totalActiveListeners ?? 0,
        },
      };
    });

    this.register('stop', async () => {
      await engine.destroy({ force: false, reason: 'jsonrpc_stop' });
      return { status: 'stopping' };
    });

    this.register('project-context', async (params?: unknown) => {
      const p = params as Record<string, unknown> | undefined;
      const dir = p?.dir as string | undefined;
      return engine.detectProjectContext(dir);
    });

    this.register('session.create', async (params?: unknown) => {
      const p = params as Record<string, unknown> | undefined;
      const projectDir = p?.projectDir as string | undefined;
      const session = await engine.createSession(p?.config as any, projectDir);
      return {
        sessionId: session.id,
        status: session.status,
        createdAt: session.createdAt,
      };
    });

    this.register('session.get', (params?: unknown) => {
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

    this.register('session.list', (params?: unknown) => {
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

    this.register('session.close', async (params?: unknown) => {
      const p = params as Record<string, unknown>;
      const id = p.sessionId as string;
      await engine.closeSession(id);
      return { sessionId: id, status: 'closed' };
    });

    this.register('session.pushMessage', (params?: unknown) => {
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

    this.register('approval.override', async (params?: unknown) => {
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

    this.register('approval.accept', async (params?: unknown) => {
      const p = params as Record<string, unknown>;
      const changeId = p.changeId as string;
      if (!changeId) throw new Error('Missing required parameter: changeId');
      await engine.approvalAccept(changeId);
      return { status: 'accepted', changeId };
    });

    this.register('approval.reject', async (params?: unknown) => {
      const p = params as Record<string, unknown>;
      const changeId = p.changeId as string;
      if (!changeId) throw new Error('Missing required parameter: changeId');
      await engine.approvalReject(changeId);
      return { status: 'rejected', changeId };
    });

    this.register('approval.partial', async (params?: unknown) => {
      const p = params as Record<string, unknown>;
      const changeId = p.changeId as string;
      const acceptFiles = p.acceptFiles as string[] | undefined;
      const rejectFiles = p.rejectFiles as string[] | undefined;
      if (!changeId) throw new Error('Missing required parameter: changeId');
      await engine.approvalPartial(changeId, acceptFiles ?? [], rejectFiles ?? []);
      return { status: 'partial', changeId, acceptedFiles: acceptFiles, rejectedFiles: rejectFiles };
    });

    this.register('approval.batch_accept', async (params?: unknown) => {
      const p = params as Record<string, unknown>;
      const changeIds = p.changeIds as string[] | undefined;
      if (!changeIds || !Array.isArray(changeIds)) throw new Error('Missing required parameter: changeIds');
      await engine.approvalBatchAccept(changeIds);
      return { status: 'accepted', changeIds };
    });

    this.register('approval.batch_reject', async (params?: unknown) => {
      const p = params as Record<string, unknown>;
      const changeIds = p.changeIds as string[] | undefined;
      if (!changeIds || !Array.isArray(changeIds)) throw new Error('Missing required parameter: changeIds');
      await engine.approvalBatchReject(changeIds);
      return { status: 'rejected', changeIds };
    });

    this.register('approval.listPending', async (params?: unknown) => {
      const p = params as Record<string, unknown> | undefined;
      const sessionId = p?.sessionId as string | undefined;
      return engine.approvalListPending(sessionId);
    });
  }
}
