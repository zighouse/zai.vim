// @zaivim/engine — Pipeline: the central message processing loop.
// Orchestrates AgentHandle, ToolExecutor, Provider, and Session.
// The critical hot path: AI response → Pipeline → ToolExecutor → sandbox → fs + JSONL → AsyncIterable

import type {
  EngineAPI,
  EngineHealth,
  Session,
  SessionSummary,
  ZaiConfig,
  AgentHandle,
  PersonaConfig,
  ForkOptions,
  ToolDefinition,
  Message,
  ResponseChunk,
} from '@zaivim/core';
import { EventEmitter } from 'node:events';
import { type ISecurityProvider, type ISessionStore, ZaiSessionNotFoundError } from '@zaivim/core';
import { loadConfig } from '../config/index.js';
import { InMemorySessionStoreFull, getLastActivityAt } from '../session/index.js';
import { SessionLifecycleManager } from '../session/lifecycle-manager.js';
import { SandboxManager, SecurityProvider, Auditor } from '../security/index.js';
import { createProviderRegistry } from '../provider/index.js';
import { AsyncGeneratorAgent } from '../agent/index.js';
import type { AgentDeps } from '../agent/index.js';
import { chat as pipelineChat } from './chat.js';
import type { ChatDeps } from './chat.js';

export { chat } from './chat.js';
export { assembleContext, estimateTokens, trimContext, PIPELINE_DEFAULTS } from './context-assembler.js';
export { executeToolCall, executeToolCalls, validateToolCalls } from './tool-executor.js';
export { classifyProviderError } from './error-classifier.js';
export { NullSecurityProvider } from './null-security.js';
export { resolveAttachments, formatAttachments } from './file-attachment.js';

export class Engine implements EngineAPI {
  readonly version = '0.0.1';
  readonly #startedAt = Date.now();
  /** Event emitter for ADR-13 notifications (perf.*, chat.*, session.*, tool.*). */
  readonly events = new EventEmitter();

  get uptime(): number { return Date.now() - this.#startedAt; }

  #config: ZaiConfig;
  #sessionStore: ISessionStore;
  #lifecycleManager: SessionLifecycleManager;
  #securityProvider: ISecurityProvider;
  #sandbox: SandboxManager;
  #auditor: Auditor;
  #tools: ToolDefinition[];
  #agentDeps: AgentDeps;
  #destroyed = false;

  constructor(tools?: ToolDefinition[], configOverrides?: Partial<ZaiConfig>, sessionStore?: ISessionStore) {
    this.#config = loadConfig(configOverrides);

    this.#sessionStore = sessionStore ?? new InMemorySessionStoreFull();
    this.#lifecycleManager = new SessionLifecycleManager(this.#sessionStore);

    // Forward lifecycle notifications as engine events
    this.#lifecycleManager.on('lifecycle.notification', (n: { type: string; sessionId: string; [k: string]: unknown }) => {
      this.#auditor.log(n.sessionId, n.type, n);
      this.events.emit(n.type, n);
    });
    this.#auditor = new Auditor();
    this.#sandbox = new SandboxManager(
      this.#config.sandbox.enabled,
      this.#config.sandbox.type,
      this.#config.sandbox.workDir,
    );

    this.#securityProvider = new SecurityProvider(
      this.#sandbox,
      this.#auditor,
      process.cwd(),
    );

    this.#tools = tools ?? [];

    const providerConfigs: Record<string, import('../provider/index.js').ProviderConfig> = {};
    for (const [name, cfg] of Object.entries(this.#config.providers)) {
      providerConfigs[name] = {
        name,
        type: cfg.type,
        apiKey: cfg.apiKey,
        baseURL: cfg.baseURL,
        models: cfg.models,
        defaultModel: cfg.defaultModel,
        allowHttp: cfg.allowHttp,
      };
    }

    const providerRegistry = createProviderRegistry(
      providerConfigs,
      this.#config.defaults.provider,
    );

    this.#agentDeps = {
      providerRegistry,
      sessionStore: this.#sessionStore,
      securityProvider: this.#securityProvider,
      tools: this.#tools,
    };
  }

  // ---- Session management ----

  async createSession(configOverrides?: Partial<ZaiConfig>, projectDir?: string): Promise<Session> {
    this.#ensureNotDestroyed();
    const config = configOverrides
      ? loadConfig(configOverrides)
      : this.#config;
    return this.#sessionStore.create(config);
  }

  getSession(id: string): Session | undefined {
    return this.#sessionStore.get(id);
  }

  listSessions(filter?: { status?: import('@zaivim/core').SessionStatus; limit?: number; offset?: number; sortBy?: 'createdAt' | 'lastActivityAt'; sortOrder?: 'asc' | 'desc' }): SessionSummary[] {
    const sessions = this.#sessionStore.list(filter);
    return sessions.map(s => ({
      id: s.id,
      createdAt: s.createdAt,
      status: s.status,
      messageCount: s.messages.length,
      projectDir: s.projectDir,
      lastActivityAt: getLastActivityAt(s),
    }));
  }

  async closeSession(id: string): Promise<void> {
    await this.#sessionStore.close(id);
  }

  async recoverSession(id: string): Promise<Session> {
    this.#ensureNotDestroyed();
    const sessions = await this.#sessionStore.recoverFromDisk();
    const session = sessions.find(s => s.id === id);
    if (!session) throw new ZaiSessionNotFoundError(id);
    this.#auditor.log(id, 'session.recovered', { recoveredCount: session.messages.length });
    this.events.emit('session.recovered', { type: 'session.recovered', sessionId: id, recoveredCount: session.messages.length, skippedLines: 0 });
    return session;
  }

  pushSessionMessage(sessionId: string, msg: import('@zaivim/core').Message): void {
    this.#sessionStore.pushMessage(sessionId, msg);
  }

  // ---- Chat (Pipeline) ----

  async *chat(sessionId: string, message: Message, signal?: AbortSignal): AsyncIterable<ResponseChunk> {
    this.#ensureNotDestroyed();

    const session = this.#sessionStore.get(sessionId);
    if (!session) {
      yield { type: 'error', code: 'ENGINE_SESSION_NOT_FOUND', message: `Session not found: ${sessionId}` };
      return;
    }

    let provider: import('@zaivim/core').IProvider;
    try {
      provider = this.#agentDeps.providerRegistry.defaultProvider;
    } catch {
      yield { type: 'error', code: 'ENGINE_PROVIDER_ERROR', message: 'No provider configured' };
      return;
    }

    const emit = (event: string, data: Record<string, unknown>) => {
      this.#auditor.log(sessionId, event, data);
      this.events.emit(event, data);
    };

    const deps: ChatDeps = {
      sessionStore: this.#sessionStore,
      provider,
      tools: this.#tools,
      security: this.#securityProvider,
      emit,
      onMessagePushed: (sid: string) => this.#lifecycleManager.checkMessageLimit(sid),
    };

    yield* pipelineChat(session, message, deps, signal);
  }

  // ---- Agent management ----

  createAgent(persona: PersonaConfig, options?: ForkOptions): AgentHandle {
    this.#ensureNotDestroyed();
    return new AsyncGeneratorAgent(persona, this.#agentDeps, options);
  }

  // ---- Health ----

  getHealth(): EngineHealth {
    const sandboxAvailable = this.#sandbox.isAvailable();
    const status = this.#destroyed
      ? 'down'
      : sandboxAvailable
        ? 'ok'
        : 'degraded';

    return {
      status,
      sandboxAvailable,
      activeSessions: this.#sessionStore.activeCount,
      activeAgents: 0, // Growth: track active agent handles
      reason: sandboxAvailable ? undefined : 'sandbox unavailable',
    };
  }

  // ---- Destroy ----

  async destroy(options?: Partial<import('@zaivim/core').ShutdownOptions>): Promise<void> {
    this.#destroyed = true;
    // Close all active sessions
    for (const session of this.#sessionStore.list()) {
      if (session.status === 'active') {
        this.#sessionStore.close(session.id);
      }
    }
  }

  #ensureNotDestroyed(): void {
    if (this.#destroyed) {
      throw new Error('Engine has been destroyed');
    }
  }
}

// ---- Factory function (singleton) ----------------------------------------

let instance: Engine | undefined;

/**
 * Create or return the existing engine instance.
 * MVP: Global singleton — second call returns existing instance (no PID conflict).
 * Growth: Per-session instances with optional pool management.
 */
export function createPipelineEngine(
  tools?: ToolDefinition[],
  configOverrides?: Partial<ZaiConfig>,
  sessionStore?: ISessionStore,
): EngineAPI {
  if (instance) {
    return instance as EngineAPI;
  }
  instance = new Engine(tools, configOverrides, sessionStore);
  return instance as EngineAPI;
}
