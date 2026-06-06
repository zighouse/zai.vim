// @zaivim/engine — Pipeline: the central message processing loop.
// Orchestrates AgentHandle, ToolExecutor, Provider, and Session.
// The critical hot path: AI response → Pipeline → ToolExecutor → sandbox → fs + JSONL → AsyncIterable

import type {
  EngineAPI,
  EngineHealth,
  Session,
  ZaiConfig,
  AgentHandle,
  PersonaConfig,
  ForkOptions,
  ToolDefinition,
} from '@zaivim/core';
import { type ISecurityProvider } from '@zaivim/core';
import { loadConfig } from '../config/index.js';
import { InMemorySessionStore } from '../session/index.js';
import { SandboxManager, SecurityProvider, Auditor } from '../security/index.js';
import { createProviderRegistry } from '../provider/index.js';
import { AsyncGeneratorAgent } from '../agent/index.js';
import type { AgentDeps } from '../agent/index.js';

export class Engine implements EngineAPI {
  readonly version = '0.0.1';
  readonly #startedAt = Date.now();

  get uptime(): number { return Date.now() - this.#startedAt; }

  #config: ZaiConfig;
  #sessionStore: InMemorySessionStore;
  #securityProvider: ISecurityProvider;
  #sandbox: SandboxManager;
  #auditor: Auditor;
  #tools: ToolDefinition[];
  #agentDeps: AgentDeps;
  #destroyed = false;

  constructor(tools?: ToolDefinition[], configOverrides?: Partial<ZaiConfig>) {
    this.#config = loadConfig(configOverrides);

    this.#sessionStore = new InMemorySessionStore();
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

  async closeSession(id: string): Promise<void> {
    this.#sessionStore.close(id);
  }

  pushSessionMessage(sessionId: string, msg: import('@zaivim/core').Message): void {
    this.#sessionStore.appendMessage(sessionId, msg);
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
): EngineAPI {
  if (instance) {
    return instance as EngineAPI;
  }
  instance = new Engine(tools, configOverrides);
  return instance as EngineAPI;
}
