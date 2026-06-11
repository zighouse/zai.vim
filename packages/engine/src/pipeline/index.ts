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
  ProjectContext,
} from '@zaivim/core';
import { EventEmitter } from 'node:events';
import { type ISecurityProvider, type ISessionStore, ZaiSessionNotFoundError } from '@zaivim/core';
import { loadConfig } from '../config/index.js';
import { InMemorySessionStoreFull, getLastActivityAt } from '../session/index.js';
import { SessionLifecycleManager } from '../session/lifecycle-manager.js';
import { SandboxManager, SecurityProvider, Auditor, OverrideManager, SecurityMonitor } from '../security/index.js';
import type { SecurityLevel } from '../security/security-monitor.js';
import { createProviderRegistry } from '../provider/index.js';
import { AsyncGeneratorAgent } from '../agent/index.js';
import type { AgentDeps } from '../agent/index.js';
import { chat as pipelineChat } from './chat.js';
import type { ChatDeps } from './chat.js';
import { findProjectRoot, scanProjectMeta, type ProjectRootResult } from './project-detector.js';
import { SecurityEnricher } from './security-enricher.js';
import { join } from 'node:path';
import { stat } from 'node:fs/promises';

export { chat } from './chat.js';
export { assembleContext, estimateTokens, trimContext, PIPELINE_DEFAULTS } from './context-assembler.js';
export { executeToolCall, executeToolCalls, validateToolCalls } from './tool-executor.js';
export { classifyProviderError } from './error-classifier.js';
export { NullSecurityProvider } from './null-security.js';
export { SecurityEnricher } from './security-enricher.js';
export { resolveAttachments, formatAttachments } from './file-attachment.js';
export { findProjectRoot, scanProjectMeta, formatProjectContext, truncateProjectContext, MAX_PROJECT_CONTEXT_CHARS } from './project-detector.js';
export type { ProjectRootResult } from './project-detector.js';

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
  #overrideManager: OverrideManager;
  #securityMonitor: SecurityMonitor;
  #securityEnricher: SecurityEnricher;
  /** Project context cache — keyed by session ID (Story 1b.4) */
  readonly #projectContextCache = new Map<string, ProjectContext>();
  /** Timestamp of last mtime check per session */
  readonly #projectMtimeCache = new Map<string, number>();

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

    this.#overrideManager = new OverrideManager({}, undefined, undefined);

    // Wire rejection callback: SecurityProvider → OverrideManager (Story 2.2)
    this.#securityProvider.onRejection = (operation, harmLevel, command, reason) => {
      return this.#overrideManager.recordRejection('', harmLevel, `${operation}: ${command}`, { harmLevel, reason });
    };

    // Validate SecurityEnricher pipeline position (Story 2.2, Task 3.3.1)
    // Current architecture: security enrichment happens inline in chat()
    // after provider chunks arrive and before tool execution.
    const middlewareOrder = ['ToolExecutor', 'SecurityEnricher'] as const;
    const positionValidation = SecurityEnricher.validatePipelinePosition(middlewareOrder);
    if (!positionValidation.valid) {
      throw new Error(`SecurityEnricher pipeline validation failed: ${positionValidation.error}`);
    }

    this.#securityEnricher = new SecurityEnricher();

    this.#securityMonitor = new SecurityMonitor(
      async () => {
        const auditHealthy = true; // Growth: real audit health check
        const classifierHealthy = true; // Growth: real classifier health check
        const isAvailable = this.#sandbox.isAvailable();
        const level: SecurityLevel = !isAvailable
          ? 'degraded'
          : (!auditHealthy || !classifierHealthy)
            ? 'at-risk'
            : 'secure';
        return {
          level,
          sandboxAvailable: isAvailable,
          auditHealthy,
          classifierHealthy,
          auditBacklog: 0,
          lastChecked: Date.now(),
        };
      },
      undefined,
      process.env.ZAIVIM_TEST_MODE === '1',
    );

    // Forward security status changes to engine events (Task 5.2)
    this.#securityMonitor.onChange((change) => {
      const eventType = change.to === 'secure' ? 'security.secure' : 'security.degraded';
      this.events.emit(eventType, {
        type: eventType,
        reason: change.reason,
        implications: change.implications,
        from: change.from,
        to: change.to,
      });
      this.#auditor.log('', `security.${change.to}`, {
        from: change.from,
        to: change.to,
        reason: change.reason,
      });
    });

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
    const resolvedProjectDir = projectDir ?? findProjectRoot().root;
    return this.#sessionStore.create(config, resolvedProjectDir);
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

    // Project context: async detect on first chat() call, cache per session (AC4)
    let projectContext = this.#projectContextCache.get(sessionId);
    if (!projectContext) {
      // Fire-and-forget async detection (non-blocking — session.projectDir is already set)
      const projectDir = session.projectDir;
      if (projectDir) {
        const { root, detected } = findProjectRoot(projectDir);
        scanProjectMeta(root, detected).then(ctx => {
          this.#setProjectContextCache(sessionId, ctx);
          // Also record scan time for mtime-based update detection
          this.#projectMtimeCache.set(sessionId, Date.now());
        }).catch(() => {
          // Silent — detection failure should not block chat
        });
      }
      // Use a minimal context until async scan completes
      projectContext = {
        projectRoot: projectDir ?? process.cwd(),
        detected: false,
        detectedAt: Date.now(),
      };
      this.#setProjectContextCache(sessionId, projectContext);
    } else {
      // Subsequent calls: async check mtime for project context updates (AC5)
      this.#checkProjectContextUpdate(sessionId, projectContext, emit).catch(() => {});
    }

    const deps: ChatDeps = {
      sessionStore: this.#sessionStore,
      provider,
      tools: this.#tools,
      security: this.#securityProvider,
      emit,
      onMessagePushed: (sid: string) => this.#lifecycleManager.checkMessageLimit(sid),
      projectContext,
      providerRegistry: this.#agentDeps.providerRegistry,
      sessionId,
    };

    yield* pipelineChat(session, message, deps, signal);
  }

  // ---- Agent management ----

  createAgent(persona: PersonaConfig, options?: ForkOptions): AgentHandle {
    this.#ensureNotDestroyed();
    return new AsyncGeneratorAgent(persona, this.#agentDeps, options);
  }

  // ---- Health (Story 2.2, Task 6) ----

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
      securityLevel: this.#securityMonitor.currentLevel,
      activeSessions: this.#sessionStore.activeCount,
      activeAgents: 0, // Growth: track active agent handles
      reason: sandboxAvailable ? undefined : 'sandbox unavailable',
    };
  }

  // ---- User Override (Story 2.2, FR66) ----

  /** Request user override of a blocked security operation */
  requestOverride(operationId: string, acknowledgment: string, sessionId: string): Promise<boolean> {
    try {
      const result = this.#overrideManager.requestOverride(operationId, acknowledgment, sessionId);
      return Promise.resolve(result);
    } catch (err) {
      return Promise.reject(err);
    }
  }

  /** Get pending operation info (for Gateway forwarding) */
  getPendingOperation(operationId: string) {
    return this.#overrideManager.getPendingOperation(operationId);
  }

  // ---- Project context detection (Story 1b.4) -------------------------------

  async detectProjectContext(dir?: string): Promise<ProjectContext> {
    const { root, detected } = findProjectRoot(dir);
    return scanProjectMeta(root, detected);
  }

  /** Invalidate project context cache for a session (internal). */
  #setProjectContextCache(sessionId: string, ctx: ProjectContext): void {
    this.#projectContextCache.set(sessionId, ctx);
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

  /** Check if project context needs updating via mtime comparison (AC5). */
  async #checkProjectContextUpdate(
    sessionId: string,
    currentCtx: ProjectContext,
    emit: (event: string, data: Record<string, unknown>) => void,
  ): Promise<void> {
    // Skip mtime check when no project metadata was detected
    if (!currentCtx.detected) return;

    const markers = ['package.json', 'pnpm-workspace.yaml'];
    let latestMtime = this.#projectMtimeCache.get(sessionId) ?? 0;
    let changed = false;

    for (const marker of markers) {
      try {
        const st = await stat(join(currentCtx.projectRoot, marker));
        const mtimeMs = st.mtimeMs;
        if (mtimeMs > latestMtime) {
          latestMtime = mtimeMs;
          changed = true;
        }
      } catch {
        // File not found — not a marker for this project
      }
    }

    if (!changed) return;

    // Background rescan — non-blocking, does not await
    this.#rescanAndUpdate(sessionId, currentCtx.projectRoot, emit).catch(() => {});
  }

  /** Background re-scan and cache update on mtime change. */
  async #rescanAndUpdate(
    sessionId: string,
    projectRoot: string,
    emit: (event: string, data: Record<string, unknown>) => void,
  ): Promise<void> {
    const newCtx = await scanProjectMeta(projectRoot, true);
    this.#setProjectContextCache(sessionId, newCtx);
    this.#projectMtimeCache.set(sessionId, Date.now());
    emit('session.project_context_updated', {
      sessionId,
      context: newCtx,
    });
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
