// =============================================================================
// @zaivim/core — Shared type definitions
// All types used across multiple @zaivim/* packages live here.
// Zero external dependencies.
// =============================================================================

import type { ShutdownOptions } from './engine.js';

// ---- Engine types (Task 1.1) ------------------------------------------------
export type {
  EngineState,
  EngineConfig,
  EngineStatus,
  HealthResponse,
  ShutdownStage,
  ShutdownOptions,
  ShutdownEvent,
} from './engine.js';

// ---- Event types (Story 1a.2) -----------------------------------------------
export type {
  EngineEventMap,
  EngineEventType,
  EngineEventData,
  SessionCreatedEvent,
  SessionClosedEvent,
  SecurityDegradedEvent,
  EngineWarningEvent,
  EngineShutdownEvent,
} from './events.js';

// ---- Session store types (Story 1a.3) ---------------------------------------
export type {
  ISessionStore,
  SessionMeta,
  SessionApproachingLimitEvent,
  SessionAutoTrimmedEvent,
  SessionPersistenceDroppedEvent,
  SessionRecoveredEvent,
} from './session.js';

// ---- Config types (Task 1.2) ------------------------------------------------
export type {
  SandboxConfig,
  ProviderConfig,
  ProviderStatus,
  DefaultConfig,
  AuditConstants,
  ApprovalConstants,
  ToolCallConstants,
  EngineConstants,
  ZaiConfig,
} from './config.js';

// ---- Message types ---------------------------------------------------------

export type MessageRole = 'user' | 'assistant' | 'tool' | 'system';

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface Message {
  readonly id: string;
  readonly role: MessageRole;
  readonly content: string;
  readonly toolCalls?: ToolCall[];
  readonly createdAt?: number;
  readonly seq?: number;
}

// ---- Response stream -------------------------------------------------------

export type ResponseChunk =
  | { type: 'text'; content: string }
  | { type: 'tool_call'; name: string; arguments: Record<string, unknown> }
  | { type: 'tool_result'; toolCallId: string; content: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'done'; finishReason: string };

// ---- Session ---------------------------------------------------------------

export type SessionStatus = 'active' | 'paused' | 'closed';

export interface Session {
  readonly id: string;
  readonly messages: Message[];
  readonly createdAt: number;
  readonly config: import('./config.js').ZaiConfig;
  readonly status: SessionStatus;
  readonly projectDir?: string;
  readonly version?: string;
  /** Internal — mutable via type assertion in store implementations */
  seqCounter?: number;
  reconnecting?: boolean;
  disconnectedAt?: number;
}

// ---- Agent types -----------------------------------------------------------

export type AgentExecutionKind = 'async_generator' | 'thread' | 'sandboxed';

export type AgentStatus = 'idle' | 'running' | 'waiting_tool' | 'done' | 'error' | 'cancelled';

export interface PersonaConfig {
  readonly name: string;
  readonly systemPrompt: string;
  readonly model?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
}

export interface ForkOptions {
  readonly sandbox?: 'none' | 'bwrap';
  readonly timeout?: number;
  readonly tools?: string[];
  readonly skills?: string[];
}

export interface AgentHandle {
  readonly id: string;
  readonly persona: PersonaConfig;
  readonly status: () => AgentStatus;
  send(message: Message, signal?: AbortSignal): AsyncIterable<ResponseChunk>;
  cancel(reason?: string): void;
}

export interface AgentResult {
  readonly handleId: string;
  readonly status: AgentStatus;
  readonly lastMessage?: Message;
  readonly toolCalls?: number;
  readonly error?: string;
}

export interface AgentPool {
  fork(persona: PersonaConfig, task: string, options?: ForkOptions): AgentHandle;
  gather(handles: AgentHandle[], timeout?: number): Promise<AgentResult[]>;
  fanOut(personas: PersonaConfig[], task: string): Promise<AgentResult[]>;
}

// ---- Tool types ------------------------------------------------------------

export interface ToolDefinition<TParams = unknown, TResult = unknown> {
  readonly name: string;
  readonly description: string;
  readonly parameters: {
    readonly type: 'object';
    readonly properties: Record<string, {
      readonly type: string;
      readonly description?: string;
      readonly default?: unknown;
      readonly enum?: readonly string[];
    }>;
    readonly required?: readonly string[];
  };
  readonly harmLevel?: 'S' | 'A' | 'B' | 'C';
  readonly requiresApproval?: boolean;
  execute(params: TParams, ctx: ToolContext): Promise<TResult>;
}

export interface ToolContext {
  readonly sessionId: string;
  readonly sandbox: string;
  readonly signal: AbortSignal;
  readonly security: ISecurityProvider;
  readonly audit: (action: string, detail: Record<string, unknown>) => void;
}

// ---- Security types --------------------------------------------------------

export interface FileChangeProposal {
  readonly path: string;
  readonly operation: 'create' | 'modify' | 'delete';
  readonly diff?: string;
  readonly reason: string;
}

export interface ISecurityProvider {
  readonly sandboxType: 'none' | 'bwrap';
  validatePath(path: string, operation: string): boolean;
  proposeChange(proposal: FileChangeProposal): Promise<boolean>;
  isSandboxAvailable(): boolean;
}

// ---- Provider types --------------------------------------------------------

export interface ProviderChatRequest {
  readonly messages: Message[];
  readonly sessionId: string;
  readonly model?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
}

export interface IProvider {
  readonly name: string;
  readonly models: readonly string[];
  readonly capabilities: ProviderCapabilities;
  chat(request: ProviderChatRequest, signal?: AbortSignal): AsyncIterable<ResponseChunk>;
}

export interface ProviderCapabilities {
  readonly streaming: boolean;
  readonly toolUse: boolean;
  readonly caching: boolean;
  readonly thinking: boolean;
  readonly vision: boolean;
  readonly maxContextTokens: number;
  readonly protocol?: 'openai-compatible' | 'anthropic-native';
}

// ---- Skill types -----------------------------------------------------------

export interface SkillInput {
  readonly args: Record<string, unknown>;
  readonly context: SkillContext;
}

export interface SkillContext {
  readonly sessionId: string;
  readonly signal: AbortSignal;
}

export interface SkillOutput {
  readonly content: string;
  readonly metadata?: Record<string, unknown>;
}

export interface SkillAdapter {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  execute(input: SkillInput): Promise<SkillOutput>;
  cleanup?(): Promise<void>;
}

// ---- Engine API types ------------------------------------------------------

export interface EngineAPI {
  readonly version: string;
  readonly uptime: number;
  createSession(config?: Partial<import('./config.js').ZaiConfig>, projectDir?: string): Promise<Session>;
  getSession(id: string): Session | undefined;
  listSessions(filter?: { status?: SessionStatus }): Session[];
  closeSession(id: string): Promise<void>;
  pushSessionMessage(sessionId: string, msg: Message): void;
  createAgent(persona: PersonaConfig, options?: ForkOptions): AgentHandle;
  getHealth(): EngineHealth;
  destroy(options?: Partial<ShutdownOptions>): Promise<void>;
}

export interface EngineHealth {
  readonly status: 'ok' | 'degraded' | 'down';
  readonly sandboxAvailable: boolean;
  readonly activeSessions: number;
  readonly activeAgents: number;
  readonly reason?: string;
}

// ---- Approval types --------------------------------------------------------

export interface ApprovalHandler {
  requestApproval(proposal: FileChangeProposal): Promise<boolean>;
  onApprovalRequired(handler: (proposal: FileChangeProposal) => Promise<boolean>): void;
}
