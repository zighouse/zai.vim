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

/** Complete ZaiConfig type tree (ADR-9: deepFreeze immutable) */
export interface ZaiConfig {
  readonly language: string;
  readonly sandbox: SandboxConfig;
  readonly providers: Readonly<Record<string, ProviderConfig>>;
  readonly defaults: DefaultConfig;
  readonly engine?: {
    readonly constants?: EngineConstants;
  };
}
