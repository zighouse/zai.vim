// =============================================================================
// @zaivim/core — Interface harness
// Compile-time verification that all public types are cross-compatible.
// If this file compiles without errors, W1 interface freeze is structurally OK.
// =============================================================================

import type {
  Message,
  Session,
  AgentHandle,
  AgentStatus,
  AgentResult,
  AgentPool,
  ToolDefinition,
  ToolContext,
  IProvider,
  ISecurityProvider,
  ResponseChunk,
  SkillAdapter,
  SkillInput,
  SkillOutput,
  SkillContext,
  EngineAPI,
  EngineHealth,
  ApprovalHandler,
  FileChangeProposal,
  PendingApproval,
  ApprovalEvent,
  ProviderChatRequest,
  ProviderCapabilities,
  PersonaConfig,
  ForkOptions,
  IAuditor,
  AuditEvent,
} from '../index.js';

import type {
  EngineState,
  EngineConfig,
  EngineStatus,
  HealthResponse,
} from '../index.js';

import type {
  ZaiConfig,
  SandboxConfig,
  ProviderConfig,
  DefaultConfig,
  EngineConstants,
  AuditConstants,
  ApprovalConstants,
  ToolCallConstants,
} from '../index.js';

import type {
  JsonRpcMessage,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
  JsonRpcError,
} from '../index.js';

import type {
  ErrorCode,
} from '../index.js';

import {
  ZaiError,
  ZaiNetworkError,
  ZaiToolError,
  SkillLoadError,
  SkillRuntimeError,
  ZaiConfigError,
  ZaiSecurityError,
  ZaiGatewayError,
  ErrorCodes,
} from '../index.js';

// This function is never called — it exists only to force TypeScript
// to verify type compatibility across all public interfaces.
function harness(): void {
  // ---- AgentHandle + AbortSignal + AsyncIterable ----
  const signal = new AbortController().signal;
  void async function (h: AgentHandle) {
    for await (const c of h.send({ id: '1', role: 'user', content: 'hi' }, signal)) {
      void c; // ResponseChunk
    }
  };

  // ---- ToolDefinition + ToolContext + ISecurityProvider ----
  void async function (t: ToolDefinition<unknown, unknown>, ctx: ToolContext) {
    if (ctx.signal) ctx.signal.throwIfAborted();
    await t.execute({}, ctx);
  };

  // ---- IProvider + AbortSignal + AsyncIterable ----
  void async function (p: IProvider) {
    const req: ProviderChatRequest = { messages: [], sessionId: 'test' };
    for await (const c of p.chat(req, signal)) {
      void c;
    }
  };

  // ---- Message — all roles ----
  const mUser: Message = { id: '', role: 'user', content: '' };
  const mAssistant: Message = { id: '', role: 'assistant', content: '', toolCalls: [] };
  const mTool: Message = { id: '', role: 'tool', content: '' };
  const mSystem: Message = { id: '', role: 'system', content: '' };
  void mUser; void mAssistant; void mTool; void mSystem;

  // ---- Session — complete state ----
  const s: Session = {
    id: '',
    messages: [],
    createdAt: Date.now(),
    config: {} as ZaiConfig,
    status: 'active',
  };
  void s;

  // ---- EngineConfig ----
  const ec: EngineConfig = {
    pidFile: '~/.zaivim/engine.pid',
    version: '0.1.0',
    startupTimeout: 3000,
    healthCheckInterval: 30000,
  };
  void ec;

  // ---- EngineState ----
  const states: EngineState[] = ['starting', 'running', 'degraded', 'draining', 'shutting_down', 'terminated'];
  void states;

  // ---- EngineStatus ----
  const es: EngineStatus = { status: 'ok', pid: 12345, uptime: 3600, version: '0.1.0' };
  void es;

  // ---- HealthResponse ----
  const hr: HealthResponse = {
    status: 'ok',
    version: '0.1.0',
    uptime: 3600,
    sandboxAvailable: true,
    activeSessions: 0,
    nextMilestone: 'v0.2.0 - AI chat',
  };
  void hr;

  // ---- ZaiConfig with engine.constants ----
  const fullConfig: ZaiConfig = {
    language: 'en',
    sandbox: { enabled: false, type: 'none', workDir: '/tmp', timeout: 30000 },
    providers: {},
    defaults: { provider: '', model: '', temperature: 0.7, maxTokens: 4096 },
    engine: {
      constants: {
        audit: { maxLogSize: 10_000_000, logRotationCount: 5, sanitizePatterns: [] },
        approval: { autoApproveTimeout: 30000, maxPendingApprovals: 100 },
        toolCall: { maxParallelCalls: 4, defaultTimeout: 30000, maxRetries: 3 },
      },
    },
  };
  void fullConfig;

  // ---- JsonRpcMessage — discriminated union ----
  const req: JsonRpcMessage = { jsonrpc: '2.0', id: 1, method: 'chat' } as JsonRpcRequest;
  const res: JsonRpcMessage = { jsonrpc: '2.0', id: 1, result: {} } as JsonRpcResponse;
  const noti: JsonRpcMessage = { jsonrpc: '2.0', method: '$/chunk' } as JsonRpcNotification;
  const err: JsonRpcMessage = { jsonrpc: '2.0', id: 1, error: { code: 0, message: '' } } as JsonRpcError;
  void req; void res; void noti; void err;

  // ---- ResponseChunk — discriminated union ----
  const cText: ResponseChunk = { type: 'text', content: '' };
  const cTool: ResponseChunk = { type: 'tool_call', id: '', name: '', arguments: {} };
  const cResult: ResponseChunk = { type: 'tool_result', toolCallId: '', content: '' };
  const cErr: ResponseChunk = { type: 'error', code: '', message: '' };
  const cDone: ResponseChunk = { type: 'done', finishReason: 'stop' };
  const cThink: ResponseChunk = { type: 'thinking', content: 'reasoning...', phase: 'delta' };
  const cStats: ResponseChunk = { type: 'stats', tokensIn: 100, tokensOut: 50, elapsedMs: 2000, speed: 25 };
  const cPhase: ResponseChunk = { type: 'phase', phase: 'thinking' };
  void cText; void cTool; void cResult; void cErr; void cDone; void cThink; void cStats; void cPhase;

  // ---- Skill types ----
  void async function (adapter: SkillAdapter) {
    const input: SkillInput = { args: {}, context: { sessionId: '', signal: new AbortController().signal } };
    const output: SkillOutput = await adapter.execute(input);
    void output.content;
  };

  // ---- ZaiError — all subclasses ----
  const zBase = new ZaiError('test', 'CORE_PARSE_ERROR', 400);
  const zNet = new ZaiNetworkError('timeout', 'ENGINE_AGENT_TIMEOUT', 504);
  const zTool = new ZaiToolError('not found', 'TOOLS_FILE_NOT_FOUND', 404, 'file_read');
  const zSkill = new SkillLoadError('my-skill', 'import failed');
  const zSkillRun = new SkillRuntimeError('my-skill', 'runtime error');
  const zConfig = new ZaiConfigError('invalid config');
  const zSecurity = new ZaiSecurityError('denied', 'shell');
  const zGw = new ZaiGatewayError('transport error');
  void zBase; void zNet; void zTool; void zSkill; void zSkillRun; void zConfig; void zSecurity; void zGw;

  // ---- Error.toJSON() contract ----
  const json = zBase.toJSON();
  void (json as { code: ErrorCode; message: string; stack?: string });

  // ---- ErrorCodes constant ----
  void (ErrorCodes.CORE_PARSE_ERROR as string);
  void (ErrorCodes.ENGINE_AGENT_TIMEOUT as string);

  // ---- AgentPool ----
  void async function (pool: AgentPool) {
    const handle = pool.fork({ name: 'test', systemPrompt: 'You are helpful.' }, 'do thing');
    const results = await pool.gather([handle]);
    void results;
  };

  // ---- EngineAPI ----
  void async function (api: { version: string; getHealth(): EngineHealth }) {
    void api.version;
    const health: EngineHealth = api.getHealth();
    void health;
  };

  // ---- EngineAPI — full interface signature ----
  void async function (api: EngineAPI) {
    void api.version;
    void api.uptime;
    const health: EngineHealth = api.getHealth();
    void health;
    const s = await api.createSession();
    void s;
    const ctx = await api.detectProjectContext();
    void ctx;
    const sessions = api.listSessions();
    void sessions;
    await api.closeSession('test');
    const handle = api.createAgent({ name: 'test', systemPrompt: '' });
    void handle;
    for await (const c of api.chat('test', { id: '1', role: 'user', content: 'hi' })) { void c; }
    await api.destroy();
  };

  // ---- PendingApproval + ApprovalEvent — async approval types ----
  const pending: PendingApproval = {
    changeId: '',
    proposal: { path: '/tmp/f', operation: 'create', reason: 'test' },
    status: 'pending',
    queueOrder: 0,
    createdAt: 0,
    timeoutMs: 30000,
  };
  void pending;
  const appEvent: ApprovalEvent = { type: 'approval.request', changeId: '', proposal: pending.proposal, timeoutMs: 30000, agentId: '', sessionId: '' };
  void appEvent;

  // ---- IAuditor + AuditEvent — audit types ----
  void async function (auditor: IAuditor) {
    const event: AuditEvent = { timestamp: new Date().toISOString(), operation: 'read', level: 'C', sessionId: '', result: 'allowed' };
    await auditor.write(event);
    const results = await auditor.query({});
    void results;
  };

  // ---- ApprovalHandler ----
  void async function (handler: ApprovalHandler) {
    handler.onApprovalRequired(async (proposal: FileChangeProposal) => {
      void proposal.path; void proposal.operation;
      return true;
    });
    const approved = await handler.requestApproval({
      path: '/tmp/test',
      operation: 'create',
      reason: 'test',
    });
    void approved;
  };

  // ---- ISecurityProvider ----
  void function (sec: ISecurityProvider) {
    void sec.sandboxType;
    void sec.validatePath('/tmp', 'read');
    void sec.isSandboxAvailable();
  };
}
