// @zaivim/gateway — vim-rpc-server: JSON-RPC over stdio for Vim integration
// Spawned by Vim via job_start()/jobstart(). Reads JSON-RPC from stdin,
// dispatches to engine, writes responses/notifications/chunks to stdout.
// All output is sanitized for Vim buffer safety.

import { createInterface } from 'node:readline';
import { randomUUID, randomBytes } from 'node:crypto';
import { sanitizeForVim } from '@zaivim/engine';
import { createEngine, loadConfig, EventBus, ClientManager, getEngineInstance } from '@zaivim/engine';
import type { EngineAPI, ResponseChunk, Message, AgentHandle, Session } from '@zaivim/core';
import { ZaiConfigError } from '@zaivim/core';
import { decodeLine, isRequest, isError, encodeLine, successResponse, errorResponse } from '../stdio/jsonrpc-codec.js';
import { JSONRPC_ERROR_CODES } from '@zaivim/core';
import type { JsonRpcRequest } from '@zaivim/core';
import { encodeNotification, encodeChatChunk } from '../stdio/notification-sender.js';
import { generateAdminToken, readAdminToken } from '../admin-token.js';
import { requireAuth, MethodACL } from '../method-acl.js';
import type { TransportContext } from '../stdio/transport-context.js';

/** Per-session state for Vim chat sessions. */
interface VimSession {
  readonly sessionId: string;
  /** AbortController for active chat stream */
  abortController: AbortController | null;
  /** Whether a stream is in progress */
  isStreaming: boolean;
  /** Session auth token (from session.create) */
  token?: string;
  /** Session role/name */
  name?: string;
}

/** In-memory token cache: sessionId → token */
const sessionTokenCache = new Map<string, string>();

/** Generate a 64-char hex session token. */
function generateSessionToken(): string {
  return randomBytes(32).toString('hex');
}

const VERSION = '0.1.0';

/**
 * Create and run the vim-rpc-server.
 * Reads JSON-RPC from stdin, routes to engine, writes to stdout.
 * All output is wrapped with sanitizeForVim() for Vim display safety.
 */
export async function runVimRpcServer(
  engine: EngineAPI | undefined = undefined,
  streams?: { stdin: NodeJS.ReadableStream; stdout: NodeJS.WriteStream },
): Promise<void> {
  // ---- Resolve engine instance ----
  const activeEngine = engine ?? createInProcessEngine();

  // ---- State ----
  const sessions = new Map<string, VimSession>();
  const pendingCallbacks = new Map<number, { resolve: (result: unknown) => void; reject: (err: Error) => void }>();
  let idCounter = 0;

  // ---- Admin token for ACL ----
  const adminToken = generateAdminToken();
  const acl = MethodACL.createDefault();
  acl.register('chat.send', { access: 'session-scoped', description: 'Send a chat message to a session' });
  acl.register('chat.cancel', { access: 'session-scoped', description: 'Cancel active chat stream' });
  acl.register('agent.create', { access: 'session-scoped', description: 'Create a new agent' });
  acl.register('agent.cancel', { access: 'session-scoped', description: 'Cancel an agent' });
  acl.register('config.reload', { access: 'admin', description: 'Reload configuration' });

  const input = streams?.stdin ?? process.stdin;
  const output = streams?.stdout ?? process.stdout;

  // ---- Sanitize-aware write helper ----
  function writeLine(raw: string): void {
    output.write(sanitizeForVim(raw) + '\n');
  }

  // ---- Session management helpers ----
  function getOrCreateSession(sessionId?: string): Promise<VimSession> {
    if (sessionId && sessions.has(sessionId)) {
      return Promise.resolve(sessions.get(sessionId)!);
    }
    return activeEngine.createSession().then((s: Session) => {
      // A5.2: Generate session token and cache it
      const token = generateSessionToken();
      sessionTokenCache.set(s.id, token);
      const vs: VimSession = {
        sessionId: s.id,
        abortController: null,
        isStreaming: false,
        token,
      };
      sessions.set(s.id, vs);
      return vs;
    });
  }

  function getSession(sessionId: string): VimSession | undefined {
    return sessions.get(sessionId);
  }

  // ---- Request handlers ----

  async function handleChatSend(params: Record<string, unknown>): Promise<{ streamId: string }> {
    const sessionId = params.sessionId as string;
    const text = params.text as string;
    if (!sessionId || !text) {
      throw new Error('Missing required parameters: sessionId, text');
    }

    const vs = getOrCreateSession(sessionId);
    const vimSession = await vs;
    const abortController = new AbortController();
    vimSession.abortController = abortController;
    vimSession.isStreaming = true;

    const message: Message = {
      id: randomUUID(),
      role: 'user',
      content: text,
      createdAt: Date.now(),
    };

    // Start streaming in background — don't await here
    streamChatResponse(activeEngine, vimSession.sessionId, message, abortController.signal, output)
      .finally(() => {
        vimSession.isStreaming = false;
        vimSession.abortController = null;
      });

    return { streamId: vimSession.sessionId };
  }

  async function handleChatCancel(params: Record<string, unknown>): Promise<{ status: string }> {
    const id = params.id as string;
    if (!id) throw new Error('Missing parameter: id');

    // Find session by matching abort controller
    for (const [, vs] of sessions) {
      if (vs.abortController && vs.isStreaming) {
        vs.abortController.abort();
        return { status: 'cancelled' };
      }
    }
    return { status: 'no_active_stream' };
  }

  async function handleAgentCreate(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const persona = params.persona as Record<string, unknown> | undefined;
    const agent = activeEngine.createAgent(
      { name: (persona?.name as string) ?? 'assistant', systemPrompt: (persona?.systemPrompt as string) ?? '' },
      undefined,
    );
    return { agentId: agent.id, status: agent.status() };
  }

  // ---- Streaming chat response with forward-compat dispatcher (AC10/AC11) ----

  // Known chunk types for the dispatcher
  const KNOWN_CHUNK_TYPES = new Set(['text', 'tool_call', 'tool_result', 'error', 'done']);

  async function streamChatResponse(
    engine: EngineAPI,
    sessionId: string,
    message: Message,
    signal: AbortSignal,
    streamOut: NodeJS.WriteStream,
  ): Promise<void> {
    try {
      const stream = engine.chat(sessionId, message, signal);
      for await (const chunk of stream) {
        const raw = chunk as unknown as Record<string, unknown>;
        const type = raw.type as string;

        // A6.1: Open-ended switch — known types dispatch, unknown types passthrough
        if (KNOWN_CHUNK_TYPES.has(type)) {
          const encoded = encodeChatChunk(raw);
          streamOut.write(sanitizeForVim(encoded) + '\n');
        } else {
          // A6.2: Unknown chunk — sanitize + stderr debug log
          process.stderr.write(`[vim-rpc-server] unknown chunk type: ${type}\n`);
          // A7.1/A7.2: Phase chunk — extract and forward as notification
          if (type === 'phase') {
            const phase = raw.phase as string;
            if (phase && ['request', 'thinking', 'tool', 'response', 'done', 'error'].includes(phase)) {
              const notification = encodeNotification('phase', {
                phase,
                elapsed: raw.elapsed ?? 0,
                tokens: raw.tokens ?? 0,
                toolName: raw.toolName ?? '',
              });
              streamOut.write(sanitizeForVim(notification) + '\n');
            } else {
              // A7.3: Illegal phase value — stderr warning only
              process.stderr.write(`[vim-rpc-server] illegal phase value: ${phase}\n`);
            }
          } else {
            // A6.3: Unknown type — sanitize and forward as notification for verbose buffer
            const encoded = encodeNotification('forward:unknown_chunk', {
              type,
              data: sanitizeForVim(JSON.stringify(raw)),
            });
            streamOut.write(encoded + '\n');
          }
        }
      }
      // Stream complete — send done chunk
      const doneChunk = encodeChatChunk({ type: 'done', finishReason: 'stop' });
      streamOut.write(sanitizeForVim(doneChunk) + '\n');
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      const errorChunk = encodeChatChunk({ type: 'error', code: 'STREAM_ERROR', message: (err as Error).message });
      streamOut.write(sanitizeForVim(errorChunk) + '\n');
    }
  }

  // ---- EventBus → notification forwarding ----

  const eventBus = (activeEngine as any).eventBus as EventBus | undefined;
  let eventDisposers: Array<() => void> = [];

  if (eventBus) {
    const eventTypes = [
      'session.created', 'session.closed', 'session.approaching_limit',
      'session.auto_trimmed', 'session.persistence.dropped', 'session.recovered',
      'session.project_context_updated', 'security.degraded',
      'engine.warning', 'engine.shutdown', 'provider.retry', 'provider.recovered',
      'provider.auth_failed', 'provider.model_not_found', 'provider.rate_limited',
      'provider.fallback', 'provider.status', 'context.auto_trimmed',
      // Approval events (Story 3.5)
      'approval.request', 'approval.resolved', 'approval.timeout',
      'approval.queued', 'approval.stale', 'approval.loop_detected',
      // Agent events (forward-compat — EventBus emits even if handlers are sparse)
      'agent.progress', 'agent.error', 'agent.tool_budget_exhausted',
      // Session lifecycle
      'security.alert',
    ];

    for (const type of eventTypes) {
      const dispose = eventBus.on(type as any, (data: unknown) => {
        const notification = encodeNotification(type, data);
        output.write(sanitizeForVim(notification) + '\n');
      });
      eventDisposers.push(dispose);
    }
  }

  // ---- Main dispatch loop ----

  const rl = createInterface({ input });

  rl.on('line', async (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    const msg = decodeLine(trimmed);
    if (isError(msg)) {
      writeLine(encodeLine(msg));
      return;
    }

    if (isRequest(msg)) {
      const request = msg as JsonRpcRequest;
      const method = request.method;
      const params = (request.params ?? {}) as Record<string, unknown>;

      // ACL check
      const auth = requireAuth(method, params, acl);
      if (!auth.allowed) {
        const response = errorResponse(request.id, auth.code ?? -32603, auth.message ?? 'Unauthorized');
        writeLine(encodeLine(response));
        return;
      }

      try {
        let result: unknown;

        switch (method) {
          // ---- Core methods ----
          case 'health':
            result = activeEngine.getHealth();
            break;

          case 'ping':
            result = { status: 'ok', version: VERSION };
            break;

          // ---- Session methods ----
          case 'session.create': {
            const vimSession = await getOrCreateSession();
            // A5.2: Return token for subsequent session-scoped requests
            result = { sessionId: vimSession.sessionId, status: 'active', _token: vimSession.token };
            break;
          }

          case 'session.get': {
            const id = params.sessionId as string;
            const s = activeEngine.getSession(id);
            if (!s) throw new Error(`Session not found: ${id}`);
            const vs = getSession(id);
            result = {
              sessionId: s.id,
              status: s.status,
              createdAt: s.createdAt,
              messageCount: s.messages.length,
              name: vs?.name,
            };
            break;
          }

          case 'session.list': {
            const allSessions = activeEngine.listSessions();
            result = {
              activeSessions: allSessions.filter(s => s.status === 'active' || s.status === 'paused').length,
              sessions: allSessions.map(s => ({
                sessionId: s.id,
                status: s.status,
                createdAt: s.createdAt,
              })),
            };
            break;
          }

          case 'session.close': {
            const closeId = params.sessionId as string;
            if (closeId) {
              await activeEngine.closeSession(closeId);
              sessions.delete(closeId);
            }
            result = { status: 'closed' };
            break;
          }

          // ---- Chat methods ----
          case 'chat.send':
            result = await handleChatSend(params);
            break;

          case 'chat.cancel':
            result = await handleChatCancel(params);
            break;

          // ---- Agent methods ----
          case 'agent.create':
            result = await handleAgentCreate(params);
            break;

          case 'agent.status': {
            const allSessions = activeEngine.listSessions();
            const activeAgents = allSessions.filter(s => s.status === 'active').length;
            result = { activeAgents, sessions: allSessions.length };
            break;
          }

          // ---- Config methods ----
          case 'config.reload':
            try {
              loadConfig();
              result = { status: 'reloaded' };
            } catch (err) {
              throw new Error(`Config reload failed: ${(err as Error).message}`);
            }
            break;

          default:
            throw new Error(`Method not found: ${method}`);
        }

        const response = successResponse(request.id, result);
        writeLine(encodeLine(response));
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : 'Internal error';
        const response = errorResponse(request.id, JSONRPC_ERROR_CODES.INTERNAL_ERROR, errMsg);
        writeLine(encodeLine(response));
      }
    }
    // Notifications (no id) are silently handled in MVP
  });

  // ---- Cleanup on stdin EOF ----

  rl.on('close', () => {
    // Cleanup event listeners
    for (const dispose of eventDisposers) {
      dispose();
    }
    eventDisposers = [];

    // Close all sessions
    for (const [, vs] of sessions) {
      activeEngine.closeSession(vs.sessionId).catch(() => {});
    }
    sessions.clear();

    process.exit(0);
  });
}

/**
 * Create an in-process engine instance for the vim-rpc-server.
 * This engine is independent of any daemon process.
 */
function createInProcessEngine(): EngineAPI {
  try {
    loadConfig();
    const config = { pidFile: '', version: VERSION, startupTimeout: 3000, healthCheckInterval: 30000 };
    const engine = createEngine(config);
    return engine as EngineAPI;
  } catch (err) {
    if (err instanceof ZaiConfigError) {
      console.error(`Configuration error: ${err.message}`);
    } else {
      console.error(`Failed to start engine: ${(err as Error).message}`);
    }
    process.exit(1);
  }
}
