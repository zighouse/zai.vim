// =============================================================================
// @zaivim/core — Config types
// Complete ZaiConfig type tree including engine.constants thresholds
// =============================================================================

/** Sandbox configuration */
export interface SandboxConfig {
  readonly enabled: boolean;
  readonly type: 'none' | 'bwrap';
  readonly workDir: string;
  readonly timeout: number;
}

/** Provider status: available (validated), unavailable (config or network error), untested (syntax ok, not yet verified) */
export type ProviderStatus = 'available' | 'unavailable' | 'untested' | 'degraded';

/** Provider configuration */
export interface ProviderConfig {
  readonly type: string;
  readonly apiKey: string;
  readonly baseURL: string;
  readonly models: readonly string[];
  readonly defaultModel: string;
  readonly status?: ProviderStatus;
  readonly protocol?: 'openai-compatible' | 'anthropic-native';
  readonly lastChecked?: number;
  readonly allowHttp?: boolean;
}

/** Default model settings */
export interface DefaultConfig {
  readonly provider: string;
  readonly model: string;
  readonly temperature: number;
  readonly maxTokens: number;
}

/** Audit thresholds (engine.constants) */
export interface AuditConstants {
  readonly maxLogSize: number;
  readonly logRotationCount: number;
  readonly sanitizePatterns: readonly string[];
}

/** Approval thresholds (engine.constants) */
export interface ApprovalConstants {
  readonly autoApproveTimeout: number;
  readonly maxPendingApprovals: number;
}

/** Tool call thresholds (engine.constants) */
export interface ToolCallConstants {
  readonly maxParallelCalls: number;
  readonly defaultTimeout: number;
  readonly maxRetries: number;
}

/** Engine runtime tunables — configurable thresholds */
export interface EngineConstants {
  readonly audit: AuditConstants;
  readonly approval: ApprovalConstants;
  readonly toolCall: ToolCallConstants;
}

/**
 * Story 3.3 (AC6): Tool exposure configuration.
 *
 * `tierOverride` lets operators promote or demote a tool's tier without
 * editing the ToolDefinition — e.g. expose `web_fetch` as a first-class
 * tool in one project and as second-class in another.
 *
 * Keys are tool names; values are the target tier.
 */
export interface ToolsConfig {
  readonly tierOverride?: Readonly<Record<string, 'first' | 'second'>>;
}

/** Complete ZaiConfig type tree (ADR-9: deepFreeze immutable) */
export interface ZaiConfig {
  readonly language: string;
  readonly sandbox: SandboxConfig;
  readonly providers: Readonly<Record<string, ProviderConfig>>;
  readonly defaults: DefaultConfig;
  readonly engine?: {
    readonly constants?: EngineConstants;
  };
  /** Story 3.3 (AC6): optional tools section for tier override etc. */
  readonly tools?: ToolsConfig;
}
