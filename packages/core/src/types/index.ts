// =============================================================================
// @zaivim/core — Shared type definitions
// All types used across multiple @zaivim/* packages live here.
// Zero external dependencies.
// =============================================================================

import type { ShutdownOptions } from './engine.js';
import type { SessionSummary, ListFilter } from './session.js';

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
  ListFilter,
  SessionMeta,
  SessionSummary,
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
  ToolsConfig,
  ZaiConfig,
} from './config.js';

// ---- Message types ---------------------------------------------------------

/**
 * Roles in a chat conversation.
 * - `user`: Human input
 * - `assistant`: AI model response
 * - `tool`: Result from a tool execution
 * - `system`: System-level instruction message
 */
export type MessageRole = 'user' | 'assistant' | 'tool' | 'system';

/** A function/tool call made by the AI during a response. */
export interface ToolCall {
  /** Unique identifier for this tool call instance. */
  readonly id: string;
  /** Name of the tool being invoked. */
  readonly name: string;
  /** Arguments passed to the tool, as a parsed JSON object. */
  readonly arguments: Record<string, unknown>;
}

/** A file attached to a message (project context, user upload, etc.). */
export interface FileAttachment {
  /** Absolute path to the file on disk. */
  readonly path: string;
  /** Full or truncated file content. */
  readonly content: string;
  /** Whether the content was truncated due to size limits. */
  readonly truncated: boolean;
  /** Detected or declared programming language (for syntax highlighting). */
  readonly language?: string;
}

/**
 * A single message in a chat conversation.
 * @property id - Unique message identifier.
 * @property role - Sender role (user/assistant/tool/system).
 * @property content - Text content of the message.
 * @property toolCalls - Tool invocations made by the assistant.
 * @property createdAt - Unix timestamp (ms) when the message was created.
 * @property seq - Optional sequence number for ordered delivery.
 * @property attachments - Files attached to this message.
 * @property pinned - Whether the message is pinned (preserved across context trimming).
 */
export interface Message {
  readonly id: string;
  readonly role: MessageRole;
  readonly content: string;
  readonly toolCalls?: ToolCall[];
  /** Matching tool_call id for role==='tool' messages (required by OpenAI-compatible APIs). */
  readonly toolCallId?: string;
  readonly createdAt?: number;
  readonly seq?: number;
  readonly attachments?: FileAttachment[];
  readonly pinned?: boolean;
}

// ---- Response stream -------------------------------------------------------

/** Thinking phase literal — start/delta/end for streaming reasoning content. */
export type ThinkingPhase = 'start' | 'delta' | 'end';

/** Phase state machine literal — 6-state lifecycle for client statusbar. */
export type SessionPhase = 'request' | 'thinking' | 'tool' | 'response' | 'done' | 'error';

/**
 * Discriminated union of all chunk types in the streaming response protocol.
 * `type` is the discriminator — switch exhaustiveness is enforced at compile time.
 * @property type - Literal discriminator for pattern matching.
 */
export type ResponseChunk =
  /** @property content - Text fragment of the AI response. */
  | { type: 'text'; content: string }
  /** @property id - Unique tool call ID. @property name - Tool name. @property arguments - Parsed JSON args. */
  | { type: 'tool_call'; id: string; name: string; arguments: Record<string, unknown> }
  /** @property toolCallId - Matching tool_call id. @property content - Tool execution result text. */
  | { type: 'tool_result'; toolCallId: string; content: string }
  /** @property code - Machine-readable error code. @property message - Human-readable error message. */
  | { type: 'error'; code: string; message: string }
  /** @property finishReason - Why the stream ended (stop, length, tool_calls, etc.). */
  | { type: 'done'; finishReason: string }
  /** @property content - Reasoning text fragment. @property phase - Stream lifecycle phase (start/delta/end). */
  | { type: 'thinking'; content: string; phase: ThinkingPhase }
  /** @property tokensIn - Input tokens consumed. @property tokensOut - Output tokens generated. @property elapsedMs - Wall-clock duration in milliseconds. @property speed - Generation speed in tokens-per-second. */
  | { type: 'stats'; tokensIn: number; tokensOut: number; elapsedMs: number; speed: number }
  /** @property phase - Client-visible state machine phase. */
  | { type: 'phase'; phase: SessionPhase };

// ---- Session ---------------------------------------------------------------

/** Lifecycle state of a chat session. */
export type SessionStatus = 'active' | 'paused' | 'closed';

/**
 * A chat conversation session with message history and configuration.
 * @property id - Unique session identifier.
 * @property messages - Ordered list of conversation messages.
 * @property createdAt - Unix timestamp (ms) when the session was created.
 * @property config - Session-level configuration (sandbox, model defaults, etc.).
 * @property status - Current lifecycle state.
 * @property projectDir - Detected project root directory for context.
 * @property version - Engine version that created this session.
 */
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

/** Execution model for an agent: async generator (streaming), thread (blocking), or sandboxed (isolated). */
export type AgentExecutionKind = 'async_generator' | 'thread' | 'sandboxed';

/** Current state of an agent in its lifecycle. */
export type AgentStatus = 'idle' | 'running' | 'waiting_tool' | 'done' | 'error' | 'cancelled';

/**
 * Configuration for an AI agent persona.
 * @property name - Display name for the agent.
 * @property systemPrompt - System-level instruction that defines agent behavior.
 * @property model - Optional model override (e.g., 'deepseek-chat').
 * @property temperature - Sampling temperature (0-2). Default: provider-specific.
 * @property maxTokens - Maximum output tokens. Default: provider-specific.
 */
export interface PersonaConfig {
  readonly name: string;
  readonly systemPrompt: string;
  readonly model?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
}

/**
 * Options for forking an agent into a sub-task.
 * @property sandbox - Isolation backend for execution.
 * @property timeout - Maximum execution time in ms.
 * @property tools - Subset of tools available to the agent.
 * @property skills - Subset of skills available to the agent.
 */
export interface ForkOptions {
  readonly sandbox?: 'none' | 'bwrap';
  readonly timeout?: number;
  readonly tools?: string[];
  readonly skills?: string[];
}

/**
 * Handle to a running agent, providing control and stream access.
 * @property id - Unique agent identifier.
 * @property persona - The persona configuration this agent was created with.
 * @property status - Current agent status (polling-based).
 */
export interface AgentHandle {
  readonly id: string;
  readonly persona: PersonaConfig;
  /** Returns the current agent status synchronously. */
  readonly status: () => AgentStatus;
  /**
   * Send a message to the agent and receive a streaming response.
   * @param message - The message to send.
   * @param signal - Optional abort signal to cancel the stream.
   * @returns AsyncIterable of ResponseChunks (text, tool_calls, thinking, etc.).
   * @throws {AbortError} When the signal is aborted.
   * @throws {ZaiNetworkError} On provider/network failure.
   * @example
   * ```typescript
   * for await (const chunk of agent.send({ id: '1', role: 'user', content: 'Hello' })) {
   *   if (chunk.type === 'text') process.stdout.write(chunk.content);
   * }
   * ```
   */
  send(message: Message, signal?: AbortSignal): AsyncIterable<ResponseChunk>;
  /**
   * Cancel the agent's current execution.
   * @param reason - Optional cancellation reason passed to error handlers.
   */
  cancel(reason?: string): void;
}

/**
 * Result from a completed agent execution.
 * @property handleId - The agent handle that produced this result.
 * @property status - Final status of the agent.
 * @property lastMessage - The last message in the agent's conversation.
 * @property toolCalls - Number of tool calls made during execution.
 * @property error - Error message if the agent failed.
 */
export interface AgentResult {
  readonly handleId: string;
  readonly status: AgentStatus;
  readonly lastMessage?: Message;
  readonly toolCalls?: number;
  readonly error?: string;
}

/**
 * Pool managing multiple agents with fork/gather/fanOut semantics.
 */
export interface AgentPool {
  /** Create a new agent to work on a specific task. */
  fork(persona: PersonaConfig, task: string, options?: ForkOptions): AgentHandle;
  /** Wait for all handles to complete and return their results. */
  gather(handles: AgentHandle[], timeout?: number): Promise<AgentResult[]>;
  /** Create agents for each persona on the same task and gather all results. */
  fanOut(personas: PersonaConfig[], task: string): Promise<AgentResult[]>;
}

// ---- Security types (Story 2.1) -------------------------------------------

import type { HarmLevel, SecurityDecision, SecurityStatus, AuditEntry, ISecurityProvider, SecurityContext, FileChangeProposal, FileOperationType, FileClassification, HarmLevelBadge, RiskCard, RiskCardSeverity, OverrideRequest, OverrideRecord, SecurityDegradedNotification, SecuritySecureNotification, SecurityNotification, ToolSecurityNotification, SafeFileHandle, WriteApproval, FileOperation } from './security.js';
export type { HarmLevel, SecurityDecision, SecurityStatus, AuditEntry, ISecurityProvider, SecurityContext, FileChangeProposal, FileOperationType, FileClassification, HarmLevelBadge, RiskCard, RiskCardSeverity, OverrideRequest, OverrideRecord, SecurityDegradedNotification, SecuritySecureNotification, SecurityNotification, ToolSecurityNotification, SafeFileHandle, WriteApproval, FileOperation };

// ---- Approval types (Story 3.5) -----------------------------------------------

import type { ApprovalStatus, PendingApproval, ApprovalLoopDetection, ApprovalEvent, RequestApprovalFn } from './approval.js';
export type { ApprovalStatus, PendingApproval, ApprovalLoopDetection, ApprovalEvent, RequestApprovalFn };

// ---- Audit types (Story 2.3) -----------------------------------------------

import type { SafetyLevel, AuditEventType, AuditEvent, AuditQueryFilter, AuditSummary, IAuditor } from './audit.js';
export type { SafetyLevel, AuditEventType, AuditEvent, AuditQueryFilter, AuditSummary, IAuditor };

// ---- Tool types ------------------------------------------------------------

/**
 * Definition of a tool that can be invoked by the AI.
 * @property name - Unique tool name used by the model.
 * @property description - Natural language description of what the tool does.
 * @property parameters - JSON Schema-like parameter specification.
 * @property harmLevel - Pre-assigned harm classification (S/A/B/C).
 * @property requiresApproval - Whether file changes need user approval.
 * @property requireSandbox - Whether execution requires sandbox isolation.
 * @property highRisk - Routes through isolated sub-sandbox with stricter constraints.
 * @property tier - Tool tier: first (default) or second-class exposure.
 * @property source - Origin: builtin (default) or skill.
 * @property skillName - Required when source === 'skill'.
 */
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
  readonly requireSandbox?: boolean;
  /**
   * Story 3.4 (AC1): when true, the engine routes execution through an
   * isolated sub-sandbox with stricter filesystem, network, and capability
   * constraints than the primary BwrapSecurityProvider sandbox. Defaults to
   * undefined (non-high-risk) so existing tools are unaffected.
   */
  readonly highRisk?: boolean;
  /** Story 3.3 (AC6): tool tier — first (default) or second-class exposure. */
  readonly tier?: 'first' | 'second';
  /** Story 3.3 (AC7): origin of the tool — builtin (default) or skill. */
  readonly source?: 'builtin' | 'skill';
  /** Story 3.3 (AC7): required when source === 'skill'. */
  readonly skillName?: string;
  execute(params: TParams, ctx: ToolContext): Promise<TResult>;
}

// ---- Sub-sandbox config (Story 3.4) ----------------------------------------

/**
 * Story 3.4: Configuration for isolated sub-sandbox execution.
 *
 * These are internal engine parameters, not user-writable configuration.
 * They live in types/index.ts (not config.ts) because they describe how
 * the engine manages isolation, not what a user can change in YAML.
 */
export interface SubSandboxConfig {
  /** Default per-execution timeout (ms). Default: 30_000. */
  readonly defaultTimeoutMs: number;
  /** Maximum allowed per-execution timeout (ms). Default: 300_000. */
  readonly maxTimeoutMs: number;
  /** Whether to check host memory before executing. Default: true. */
  readonly memoryCheckEnabled: boolean;
  /** Minimum free host memory (MB) required to start execution. Default: 100. */
  readonly minFreeMemoryMB: number;
  /** Max concurrent active sub-sandboxes (AC5). Default: 5. */
  readonly maxConcurrency: number;
}

// ---- Shell tool types (Story 3.2a) -----------------------------------------

/** AI-facing input parameters for shell_execute tool. */
export interface ShellParams {
  /** Shell command string to execute. */
  readonly command: string;
  /** Working directory (default: sandbox root). */
  readonly cwd?: string;
  /** Environment variables to set. */
  readonly env?: Record<string, string>;
  /** Stdin input for the command. */
  readonly stdin?: string;
  /** Execution timeout in ms (default: 30000). */
  readonly timeout?: number;
}

/** AI-facing result from shell_execute tool. */
export interface ShellResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly killed: boolean;
  readonly truncated: { readonly stdout: boolean; readonly stderr: boolean };
  /** Whether the command was rejected by security policy. */
  readonly rejected?: boolean;
  /** Reason for rejection. */
  readonly rejectionReason?: string;
}

/** Processed parameters passed to ctx.exec (engine closure). */
export interface ShellExecParams {
  readonly command: string;
  readonly cwd: string;
  readonly env?: Record<string, string>;
  readonly stdin?: string;
  readonly timeout: number;
  /** Whether network access is allowed. */
  readonly network?: boolean;
}

/** Result returned by ctx.exec (engine closure). */
export interface ShellExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly killed: boolean;
  readonly signal?: string;
  readonly truncated: { readonly stdout: boolean; readonly stderr: boolean };
  /** Execution wall-clock time in ms. */
  readonly elapsed: number;
  readonly progressNotified: boolean;
}

/**
 * Context provided to every tool execution.
 * @property sessionId - The session that triggered this tool call.
 * @property sandbox - Sandbox type identifier.
 * @property signal - AbortSignal for cancellation.
 * @property security - Security provider for path/operation validation.
 * @property lastCwd - Last working directory (persisted across tool calls).
 * @property audit - Log an audit event.
 * @property exec - Sandboxed shell execution (undefined when unavailable).
 * @property spawn - Controlled child process spawn for cascade termination.
 * @property requestApproval - Async approval callback for file modifications.
 */
export interface ToolContext {
  readonly sessionId: string;
  readonly sandbox: string;
  readonly signal: AbortSignal;
  readonly security: ISecurityProvider;
  readonly lastCwd?: string;
  readonly audit: (action: string, detail: Record<string, unknown>) => void;
  /**
   * Sandboxed shell execution. Undefined when sandbox is unavailable
   * or capabilities don't meet minimum requirements (ADR-SHELL-1).
   * Engine injects a closure wrapping SandboxManager + output truncation +
   * progress notification + audit logging.
   */
  readonly exec?: (params: ShellExecParams, signal?: AbortSignal) => Promise<ShellExecResult>;
  /**
   * Controlled spawn — all child processes MUST go through this method.
   * Enables agent to track PIDs for cascade termination on cancel.
   */
  spawn(
    command: string,
    args?: readonly string[],
    options?: {
      readonly cwd?: string;
      readonly env?: Record<string, string>;
      readonly timeout?: number;
      readonly detached?: boolean;
      readonly signal?: AbortSignal;
      readonly stdio?: import('child_process').StdioOptions;
    },
  ): import('child_process').ChildProcess;
  /**
   * Story 3.5: Async approval callback for file modifications.
   *
   * When present, file_write tools submit changes for user approval instead of
   * applying them immediately. The tool returns a PendingApproval with changeId
   * and the engine pauses the agent until the user accepts/rejects/times out.
   *
   * When absent (test environments, CLI batch mode), file_write applies changes
   * immediately — fully backward compatible.
   *
   * Only file_write checks this callback; other tools ignore it.
   */
  readonly requestApproval?: import('./approval.js').RequestApprovalFn;
}

// ---- Web tool types (Story 3.2b) -----------------------------------------

/** AI-facing input parameters for web_fetch tool */
export interface WebFetchParams {
  readonly url: string;
  readonly timeout?: number;
  readonly maxOutputBytes?: number;
  readonly raw?: boolean;
}

/** AI-facing result from web_fetch tool */
export interface WebFetchResult {
  readonly url: string;
  readonly content: string;
  readonly contentType: string;
  readonly statusCode: number;
  readonly truncated: boolean;
  readonly size: number;
  readonly elapsed: number;
  readonly errorCode?: string;
}

/** Single search result item */
export interface SearchResultItem {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

/** AI-facing input parameters for web_search tool */
export interface WebSearchParams {
  readonly query: string;
  readonly maxResults?: number;
  readonly timeout?: number;
}

/** AI-facing result from web_search tool */
export interface WebSearchResult {
  readonly query: string;
  readonly results: SearchResultItem[];
  readonly totalResults: number;
  readonly elapsed: number;
  readonly truncated: boolean;
  readonly errorCode?: string;
}

// ---- Provider types --------------------------------------------------------

/**
 * Request parameters for IProvider.chat().
 * @property messages - Conversation history including the new message.
 * @property sessionId - Session context for audit/logging.
 * @property model - Optional model override (e.g., 'deepseek-chat').
 * @property temperature - Sampling temperature override.
 * @property maxTokens - Max output tokens override.
 */
export interface ProviderChatRequest {
  readonly messages: Message[];
  readonly sessionId: string;
  readonly model?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  /** OpenAI-compatible tool definitions (from ToolRegistry.toOpenAITools()). */
  readonly tools?: unknown[];
}

/**
 * AI provider interface — wraps an LLM API (OpenAI-compatible or Anthropic-native).
 * @property name - Provider identifier (e.g., 'deepseek', 'openai').
 * @property models - List of available model names.
 * @property capabilities - Declared feature support flags.
 */
export interface IProvider {
  readonly name: string;
  readonly models: readonly string[];
  readonly capabilities: ProviderCapabilities;
  /**
   * Send a chat request and stream the response.
   * @param request - Messages and parameters for the chat completion.
   * @param signal - Optional abort signal to cancel the stream.
   * @returns AsyncIterable of ResponseChunks (text, thinking, tool_call, stats, etc.).
   * @throws {ZaiNetworkError} On provider connection or API errors.
   */
  chat(request: ProviderChatRequest, signal?: AbortSignal): AsyncIterable<ResponseChunk>;
}

/**
 * Declared feature capabilities of an AI provider.
 * @property streaming - Supports SSE streaming.
 * @property toolUse - Supports function/tool calling.
 * @property caching - Supports prompt caching.
 * @property thinking - Supports reasoning_content (thinking chunks).
 * @property vision - Supports image inputs.
 * @property maxContextTokens - Maximum context window size.
 * @property protocol - API protocol variant.
 */
export interface ProviderCapabilities {
  readonly streaming: boolean;
  readonly toolUse: boolean;
  readonly caching: boolean;
  readonly thinking: boolean;
  readonly vision: boolean;
  readonly maxContextTokens: number;
  readonly protocol?: 'openai-compatible' | 'anthropic-native';
}

// ---- Pipeline types ---------------------------------------------------------

/** Internal request params passed to the pipeline's chat() function. */
export interface PipelineChatRequest {
  readonly sessionId: string;
  readonly message: Message;
  readonly signal?: AbortSignal;
}

/** Configuration for the chat pipeline's retry and tool call behavior. */
export interface PipelineConfig {
  /** Max tool call rounds before yielding error (default: 10). */
  readonly maxToolCallRounds?: number;
  /** Max context window tokens before trimming. */
  readonly maxContextTokens?: number;
  /** Per-tool-call timeout in ms (default: 30000). */
  readonly toolCallTimeout?: number;
  /** Max retry attempts on provider failure (default: 3). */
  readonly maxRetries?: number;
  /** Initial retry backoff delay in ms (default: 1000). */
  readonly baseDelayMs?: number;
  /** Maximum retry backoff delay in ms (default: 30000). */
  readonly maxDelayMs?: number;
  /** Exponential backoff multiplier (default: 2). */
  readonly backoffFactor?: number;
}

/** Summary result returned by the pipeline after a chat round completes. */
export interface ChatResult {
  readonly chunks: number;
  readonly finishReason: string;
  readonly firstTokenLatencyMs: number;
}

// ---- Skill types -----------------------------------------------------------

/** Input to a skill adapter's execute() method. */
export interface SkillInput {
  /** Arguments passed to the skill from the caller. */
  readonly args: Record<string, unknown>;
  /** Execution context (session, abort signal). */
  readonly context: SkillContext;
}

/** Context available to a skill during execution. */
export interface SkillContext {
  readonly sessionId: string;
  readonly signal: AbortSignal;
}

/** Output from a skill adapter's execute() method. */
export interface SkillOutput {
  /** Text content produced by the skill. */
  readonly content: string;
  /** Optional structured metadata. */
  readonly metadata?: Record<string, unknown>;
}

/**
 * Adapter interface for loading and executing skills (plugin modules).
 * @property name - Unique skill name.
 * @property version - Semantic version string.
 * @property description - Human-readable description of what the skill does.
 * @property execute - Execute the skill with given input and return output.
 * @property cleanup - Optional cleanup hook called when the skill is unloaded.
 */
export interface SkillAdapter {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  execute(input: SkillInput): Promise<SkillOutput>;
  cleanup?(): Promise<void>;
}

// ---- Project context types (Story 1b.4) -------------------------------------

/** Detected package manager for the project. */
export type PackageManager = 'pnpm' | 'yarn' | 'npm' | 'unknown';

/**
 * Auto-detected project context (language, framework, monorepo structure).
 * @property projectRoot - Absolute path to the detected project root.
 * @property detected - Whether context was successfully detected.
 * @property name - Project name from package.json.
 * @property language - Primary programming language.
 * @property packageManager - Detected package manager.
 * @property framework - Detected framework (react, vue, etc.).
 * @property moduleSystem - ESM or CJS.
 * @property nodeVersion - Node.js version requirement.
 * @property monorepo - Whether the project is a monorepo.
 * @property packages - Monorepo workspace package list.
 * @property configFiles - Detected configuration file paths.
 * @property detectedAt - Unix timestamp when context was detected.
 */
export interface ProjectContext {
  readonly projectRoot: string;
  readonly detected: boolean;
  readonly name?: string;
  readonly language?: string;
  readonly packageManager?: PackageManager;
  readonly framework?: string;
  readonly moduleSystem?: 'esm' | 'cjs';
  readonly nodeVersion?: string;
  readonly monorepo?: boolean;
  readonly packages?: readonly string[];
  readonly configFiles?: readonly string[];
  readonly detectedAt?: number;
}

/** Event emitted when project context is updated for a session. */
export interface ProjectContextUpdatedEvent {
  readonly sessionId: string;
  readonly context: ProjectContext;
}

// ---- Engine API types ------------------------------------------------------

/**
 * Full engine API — the primary interface for consumers.
 * Provides session management, agent lifecycle, chat streaming, and approvals.
 * @property version - Engine version string.
 * @property uptime - Engine uptime in seconds.
 */
export interface EngineAPI {
  readonly version: string;
  readonly uptime: number;
  /**
   * Create a new chat session.
   * @param config - Optional config overrides.
   * @param projectDir - Optional project directory for context detection.
   * @returns The created Session.
   */
  createSession(config?: Partial<import('./config.js').ZaiConfig>, projectDir?: string): Promise<Session>;
  /**
   * Detect project context (language, framework, monorepo structure).
   * @param dir - Directory to scan (defaults to current working dir).
   */
  detectProjectContext(dir?: string): Promise<ProjectContext>;
  /** Get a session by ID (undefined if not found). */
  getSession(id: string): Session | undefined;
  /** List sessions with optional filtering/pagination. */
  listSessions(filter?: { status?: SessionStatus; limit?: number; offset?: number; sortBy?: 'createdAt' | 'lastActivityAt'; sortOrder?: 'asc' | 'desc' }): SessionSummary[];
  /** Close and persist a session. */
  closeSession(id: string): Promise<void>;
  /** Push a message to a session's history. */
  pushSessionMessage(sessionId: string, msg: Message): void;
  /** Recover a session from persisted storage. */
  recoverSession(id: string): Promise<Session>;
  /** Create an AI agent with a given persona. */
  createAgent(persona: PersonaConfig, options?: ForkOptions): AgentHandle;
  /**
   * Send a message to a session and stream the AI response.
   * @param sessionId - Target session.
   * @param message - The message to send.
   * @param signal - Optional abort signal.
   * @returns AsyncIterable of ResponseChunks.
   */
  chat(sessionId: string, message: Message, signal?: AbortSignal): AsyncIterable<ResponseChunk>;
  /** Get current engine health status. */
  getHealth(): EngineHealth;
  /** Request user override of a blocked security operation. */
  requestOverride(operationId: string, acknowledgment: string, sessionId: string): Promise<boolean>;
  /** Accept a pending file change approval. */
  approvalAccept(changeId: string): Promise<void>;
  /** Reject a pending file change approval. */
  approvalReject(changeId: string): Promise<void>;
  /** Partially accept a multi-file change approval. */
  approvalPartial(changeId: string, acceptFiles: string[], rejectFiles: string[]): Promise<void>;
  /** Batch accept multiple approvals. */
  approvalBatchAccept(changeIds: string[]): Promise<void>;
  /** Batch reject multiple approvals. */
  approvalBatchReject(changeIds: string[]): Promise<void>;
  /** List pending approvals, optionally filtered by session. */
  approvalListPending(sessionId?: string): import('./approval.js').PendingApproval[];
  /** Shut down the engine gracefully. */
  destroy(options?: Partial<ShutdownOptions>): Promise<void>;
}

/**
 * Engine health check response.
 * @property status - Overall health status.
 * @property sandboxAvailable - Whether bwrap sandbox is functional.
 * @property securityLevel - Current security level indicator.
 * @property activeSessions - Number of active sessions.
 * @property activeAgents - Number of running agents.
 * @property reason - Status reason when degraded/down.
 */
export interface EngineHealth {
  readonly status: 'ok' | 'degraded' | 'down';
  readonly sandboxAvailable: boolean;
  readonly securityLevel?: 'secure' | 'degraded' | 'at-risk';
  readonly activeSessions: number;
  readonly activeAgents: number;
  readonly reason?: string;
}

// ---- Approval types --------------------------------------------------------

/**
 * Handler for async file change approval (Story 3.5).
 */
export interface ApprovalHandler {
  /** Submit a file change proposal for user approval. Returns true if approved. */
  requestApproval(proposal: FileChangeProposal): Promise<boolean>;
  /** Register a callback that determines approval decisions. */
  onApprovalRequired(handler: (proposal: FileChangeProposal) => Promise<boolean>): void;
}
