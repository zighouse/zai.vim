// @zaivim/gateway — vim-rpc-server: JSON-RPC over stdio for Vim integration
// Spawned by Vim via job_start()/jobstart(). Reads JSON-RPC from stdin,
// dispatches to engine, writes responses/notifications/chunks to stdout.
// All output is sanitized for Vim buffer safety.

import { createInterface } from 'node:readline';
import { randomUUID, randomBytes } from 'node:crypto';
import { sanitizeForVim } from '@zaivim/engine';
import { createEngine, loadConfig, EventBus } from '@zaivim/engine';
import type { EngineAPI, ResponseChunk, Message, AgentHandle, Session } from '@zaivim/core';
import { ZaiConfigError } from '@zaivim/core';
import { decodeLine, isRequest, isError, encodeLine, successResponse, errorResponse } from '../stdio/jsonrpc-codec.js';
import { JSONRPC_ERROR_CODES } from '@zaivim/core';
import type { JsonRpcRequest } from '@zaivim/core';
import { encodeNotification, encodeChatChunk } from '../stdio/notification-sender.js';
import { requireAuth, MethodACL } from '../method-acl.js';

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

/** Per-agent state for Vim agent sessions. */
interface VimAgent {
  readonly agentId: string;
  readonly handle: AgentHandle;
}

/** In-memory token cache: sessionId → token. Module-scoped so tests can inspect. */
export const sessionTokenCache = new Map<string, string>();

/** Known chunk types dispatched as $/chat/chunk (AC10). */
const KNOWN_CHUNK_TYPES = new Set(['text', 'tool_call', 'tool_result', 'error', 'done']);

/** Valid phase enum values (AC11). */
const VALID_PHASES = new Set(['request', 'thinking', 'tool', 'response', 'done', 'error']);

/** Generate a 64-char hex session token. */
function generateSessionToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Build the MethodACL used by vim-rpc-server. Exported so tests verify the
 * real production ACL rather than a fictional createDefault() instance (C7).
 */
export function createVimRpcACL(): MethodACL {
  const acl = new MethodACL();
  acl.register('health', { access: 'public', description: 'Engine health check' });
  acl.register('ping', { access: 'public', description: 'Engine ping' });
  acl.register('session.create', { access: 'public', description: 'Create a new chat session' });
  acl.register('session.get', { access: 'session-scoped', description: 'Get session by ID' });
  acl.register('session.list', { access: 'session-scoped', description: 'List active sessions' });
  acl.register('session.close', { access: 'session-scoped', description: 'Close a chat session' });
  acl.register('chat.send', { access: 'session-scoped', description: 'Send a chat message to a session' });
  acl.register('chat.cancel', { access: 'session-scoped', description: 'Cancel active chat stream' });
  acl.register('agent.create', { access: 'session-scoped', description: 'Create a new agent' });
  acl.register('agent.cancel', { access: 'session-scoped', description: 'Cancel an agent' });
  acl.register('config.reload', { access: 'admin', description: 'Reload configuration' });
  return acl;
}

/**
 * Validate that a session-scoped request carries a token matching the
 * session it claims to act on (H3). requireAuth() only checks the token is a
 * non-empty string — it cannot see sessionTokenCache. Call this after
 * requireAuth() for any method whose access level is session-scoped.
 *
 * Returns null when OK, or an AuthResult-shaped rejection when invalid.
 */
export function validateSessionToken(
  params: Record<string, unknown>,
  cache: Map<string, string> = sessionTokenCache,
): { allowed: false; code: number; message: string } | null {
  const sessionId = params.sessionId;
  const token = params.token;
  if (typeof sessionId !== 'string' || typeof token !== 'string') {
    return { allowed: false, code: -32001, message: 'Unauthorized: sessionId and token required' };
  }
  const expected = cache.get(sessionId);
  if (!expected || expected !== token) {
    return { allowed: false, code: -32001, message: `Unauthorized: token does not match session ${sessionId}` };
  }
  return null;
}

const VERSION = '0.1.0';

/**
 * Stream engine chat response to stdout with forward-compat dispatcher (AC10/AC11).
 *
 * - Known chunk types → encoded as $/chat/chunk notification, sanitized, written to streamOut
 * - `phase` chunk → extracted into a `phase` $/notification (AC11)
 * - Unknown chunk types → `forward:unknown_chunk` notification + stderr debug log (AC10)
 *
 * Extracted to module scope so tests can invoke it with a mock engine + spy stream.
 */
export async function streamChatResponse(
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

      if (KNOWN_CHUNK_TYPES.has(type)) {
        const encoded = encodeChatChunk(raw);
        streamOut.write(sanitizeForVim(encoded) + '\n');
      } else {
        process.stderr.write(`[vim-rpc-server] unknown chunk type: ${type}\n`);
        if (type === 'phase') {
          const phase = raw.phase as string;
          if (phase && VALID_PHASES.has(phase)) {
            const notification = encodeNotification('phase', {
              phase,
              elapsed: raw.elapsed ?? 0,
              tokens: raw.tokens ?? 0,
              toolName: raw.toolName ?? '',
            });
            streamOut.write(sanitizeForVim(notification) + '\n');
          } else {
            process.stderr.write(`[vim-rpc-server] illegal phase value: ${phase}\n`);
          }
        } else {
          const encoded = encodeNotification('forward:unknown_chunk', {
            type,
            data: JSON.stringify(raw),
          });
          streamOut.write(sanitizeForVim(encoded) + '\n');
        }
      }
    }
    const doneChunk = encodeChatChunk({ type: 'done', finishReason: 'stop' });
    streamOut.write(sanitizeForVim(doneChunk) + '\n');
  } catch (err) {
    if ((err as Error).name === 'AbortError') return;
    const errorChunk = encodeChatChunk({ type: 'error', code: 'STREAM_ERROR', message: (err as Error).message });
    streamOut.write(sanitizeForVim(errorChunk) + '\n');
  }
}

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
  const agents = new Map<string, VimAgent>();
  const pendingCallbacks = new Map<number, { resolve: (result: unknown) => void; reject: (err: Error) => void }>();
  let idCounter = 0;

  const acl = createVimRpcACL();

  const input = streams?.stdin ?? process.stdin;
  const output = streams?.stdout ?? process.stdout;

  // ---- Signal handlers ----
  function onSignal(signal: string): void {
    cleanup();
    process.exit(128 + (signal === 'SIGINT' ? 2 : 15));
  }
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  process.on('SIGHUP', onSignal);

  // ---- Shared cleanup ----
  let cleanedUp = false;
  function cleanup(): void {
    if (cleanedUp) return;
    cleanedUp = true;
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
    process.off('SIGHUP', onSignal);
    for (const dispose of eventDisposers) {
      dispose();
    }
    eventDisposers = [];
    for (const [, vs] of sessions) {
      activeEngine.closeSession(vs.sessionId).catch(() => {});
    }
    sessions.clear();
  }

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
    if (!id) return { status: 'missing_id' };

    const vs = sessions.get(id);
    if (vs?.abortController && vs.isStreaming) {
      vs.abortController.abort();
      return { status: 'cancelled' };
    }
    return { status: 'no_active_stream' };
  }

  async function handleAgentCreate(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const persona = params.persona as Record<string, unknown> | undefined;
    const handle = activeEngine.createAgent(
      { name: (persona?.name as string) ?? 'assistant', systemPrompt: (persona?.systemPrompt as string) ?? '' },
      undefined,
    );
    agents.set(handle.id, { agentId: handle.id, handle });
    return { agentId: handle.id, status: handle.status() };
  }

  async function handleAgentCancel(params: Record<string, unknown>): Promise<{ status: string }> {
    const agentId = params.agentId as string;
    if (!agentId) throw new Error('Missing parameter: agentId');

    const va = agents.get(agentId);
    if (va) {
      va.handle.cancel('user_cancelled');
      agents.delete(agentId);
      return { status: 'cancelled' };
    }
    return { status: 'not_found' };
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

      // Session-scoped methods must additionally prove the token matches the
      // session it claims to act on (H3 — requireAuth only checks the token
      // is a non-empty string).
      if (acl.getAccess(method) === 'session-scoped') {
        const tokenCheck = validateSessionToken(params);
        if (tokenCheck) {
          const response = errorResponse(request.id, tokenCheck.code, tokenCheck.message);
          writeLine(encodeLine(response));
          return;
        }
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

          case 'agent.cancel':
            result = await handleAgentCancel(params);
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
    cleanup();
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
