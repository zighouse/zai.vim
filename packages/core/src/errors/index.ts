// =============================================================================
// @zaivim/core — Error system
// All cross-package-caught exceptions must be ZaiError subclasses.
// =============================================================================

// ---- Error Codes -----------------------------------------------------------

export const ErrorCodes = {
  // Core
  CORE_PARSE_ERROR: 'CORE_PARSE_ERROR',
  CORE_INVALID_MESSAGE: 'CORE_INVALID_MESSAGE',
  CORE_PROTOCOL_ERROR: 'CORE_PROTOCOL_ERROR',

  // Engine
  ENGINE_AGENT_TIMEOUT: 'ENGINE_AGENT_TIMEOUT',
  ENGINE_CONTEXT_OVERFLOW: 'ENGINE_CONTEXT_OVERFLOW',
  ENGINE_SANDBOX_UNAVAILABLE: 'ENGINE_SANDBOX_UNAVAILABLE',
  ENGINE_PROVIDER_ERROR: 'ENGINE_PROVIDER_ERROR',
  ENGINE_PROVIDER_RATE_LIMITED: 'ENGINE_PROVIDER_RATE_LIMITED',
  ENGINE_PROVIDER_AUTH_FAILED: 'ENGINE_PROVIDER_AUTH_FAILED',
  ENGINE_PROVIDER_MODEL_NOT_FOUND: 'ENGINE_PROVIDER_MODEL_NOT_FOUND',
  ENGINE_SESSION_NOT_FOUND: 'ENGINE_SESSION_NOT_FOUND',
  ENGINE_SESSION_EXPIRED: 'ENGINE_SESSION_EXPIRED',
  ENGINE_SESSION_MAX_MESSAGES: 'ENGINE_SESSION_MAX_MESSAGES',
  ENGINE_CONFIG_INVALID: 'ENGINE_CONFIG_INVALID',
  ENGINE_INSTANCE_CONFLICT: 'ENGINE_INSTANCE_CONFLICT',

  // Tools
  TOOLS_INVALID_PARAMS: 'TOOLS_INVALID_PARAMS',
  TOOLS_FILE_NOT_FOUND: 'TOOLS_FILE_NOT_FOUND',
  TOOLS_PERMISSION_DENIED: 'TOOLS_PERMISSION_DENIED',
  TOOLS_EXECUTION_FAILED: 'TOOLS_EXECUTION_FAILED',
  TOOLS_OUTPUT_TOO_LARGE: 'TOOLS_OUTPUT_TOO_LARGE',
  TOOLS_SANDBOX_DENIED: 'TOOLS_SANDBOX_DENIED',
  // Story 3.3: Tool registry dispatch / namespace contract
  TOOLS_NOT_FOUND: 'TOOLS_NOT_FOUND',
  TOOLS_NAME_CONFLICT: 'TOOLS_NAME_CONFLICT',
  TOOLS_OUTPUT_NOT_SERIALIZABLE: 'TOOLS_OUTPUT_NOT_SERIALIZABLE',

  // Story 3.4: Isolated execution environment (sub-sandbox lifecycle)
  ISOLATED_TIMEOUT: 'ISOLATED_TIMEOUT',
  ISOLATED_ALREADY_DESTROYED: 'ISOLATED_ALREADY_DESTROYED',
  ISOLATED_CONCURRENCY_LIMIT: 'ISOLATED_CONCURRENCY_LIMIT',
  ISOLATED_UNAVAILABLE: 'ISOLATED_UNAVAILABLE',
  RESOURCE_INSUFFICIENT: 'RESOURCE_INSUFFICIENT',

  // Skills
  SKILLS_LOAD_FAILED: 'SKILLS_LOAD_FAILED',
  SKILLS_RUNTIME_ERROR: 'SKILLS_RUNTIME_ERROR',
  SKILLS_INVALID_SIGNATURE: 'SKILLS_INVALID_SIGNATURE',

  // Gateway
  GATEWAY_PAYLOAD_TOO_LARGE: 'GATEWAY_PAYLOAD_TOO_LARGE',
  GATEWAY_TRANSPORT_ERROR: 'GATEWAY_TRANSPORT_ERROR',
  GATEWAY_METHOD_NOT_FOUND: 'GATEWAY_METHOD_NOT_FOUND',

  // Pipeline
  PIPELINE_CONTEXT_LENGTH_EXCEEDED: 'PIPELINE_CONTEXT_LENGTH_EXCEEDED',
  PIPELINE_TOOL_EXECUTION_TIMEOUT: 'PIPELINE_TOOL_EXECUTION_TIMEOUT',
  PIPELINE_TOOL_NOT_FOUND: 'PIPELINE_TOOL_NOT_FOUND',
  PIPELINE_MAX_TOOL_ROUNDS_EXCEEDED: 'PIPELINE_MAX_TOOL_ROUNDS_EXCEEDED',
  PIPELINE_PROVIDER_STREAM_INTERRUPTED: 'PIPELINE_PROVIDER_STREAM_INTERRUPTED',
  PIPELINE_PROVIDER_NOT_STREAMING: 'PIPELINE_PROVIDER_NOT_STREAMING',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

// ---- Base ZaiError ---------------------------------------------------------

export class ZaiError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly detail?: unknown;

  constructor(message: string, code: ErrorCode, statusCode = 500, detail?: unknown) {
    super(message);
    this.name = 'ZaiError';
    this.code = code;
    this.statusCode = statusCode;
    this.detail = detail;
    // Ensure instanceof works correctly across package boundaries
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toJSON(): { code: ErrorCode; message: string; stack?: string } {
    return {
      code: this.code,
      message: this.message,
      ...(this.stack ? { stack: this.stack } : {}),
    };
  }
}

// ---- Network errors --------------------------------------------------------

export class ZaiNetworkError extends ZaiError {
  constructor(message: string, code: ErrorCode = 'ENGINE_PROVIDER_ERROR', statusCode = 502, detail?: unknown) {
    super(message, code, statusCode, detail);
    this.name = 'ZaiNetworkError';
  }
}

// ---- Tool errors -----------------------------------------------------------

export class ZaiToolError extends ZaiError {
  readonly toolName?: string;

  constructor(
    message: string,
    code: ErrorCode = 'TOOLS_EXECUTION_FAILED',
    statusCode = 400,
    toolName?: string,
    detail?: unknown,
  ) {
    super(message, code, statusCode, detail);
    this.name = 'ZaiToolError';
    this.toolName = toolName;
  }

  override toJSON() {
    return {
      ...super.toJSON(),
      ...(this.toolName ? { toolName: this.toolName } : {}),
    };
  }
}

// ---- Skill errors ----------------------------------------------------------

export class SkillLoadError extends ZaiError {
  readonly skillName: string;
  readonly skillPath?: string;

  constructor(skillName: string, reason: string, skillPath?: string) {
    super(`Failed to load skill "${skillName}": ${reason}`, 'SKILLS_LOAD_FAILED', 500);
    this.name = 'SkillLoadError';
    this.skillName = skillName;
    this.skillPath = skillPath;
  }
}

export class SkillRuntimeError extends ZaiError {
  readonly skillName: string;

  constructor(skillName: string, message: string, detail?: unknown) {
    super(message, 'SKILLS_RUNTIME_ERROR', 500, detail);
    this.name = 'SkillRuntimeError';
    this.skillName = skillName;
  }
}

export class SkillInvalidSignatureError extends ZaiError {
  readonly skillName: string;

  constructor(skillName: string, message: string) {
    super(message, 'SKILLS_INVALID_SIGNATURE', 400);
    this.name = 'SkillInvalidSignatureError';
    this.skillName = skillName;
  }
}

// ---- Config errors ---------------------------------------------------------

export class ZaiConfigError extends ZaiError {
  constructor(message: string, detail?: unknown) {
    super(message, 'ENGINE_CONFIG_INVALID', 400, detail);
    this.name = 'ZaiConfigError';
  }
}

// ---- Instance errors -------------------------------------------------------

export class ZaiInstanceConflictError extends ZaiError {
  readonly existingPid: number;
  readonly existingStartedAt?: number;

  constructor(existingPid: number, existingStartedAt?: number) {
    super(
      `Existing instance running (PID: ${existingPid})`,
      'ENGINE_INSTANCE_CONFLICT',
      409,
      { existingPid, existingStartedAt }
    );
    this.name = 'ZaiInstanceConflictError';
    this.existingPid = existingPid;
    this.existingStartedAt = existingStartedAt;
  }

  override toJSON() {
    return {
      ...super.toJSON(),
      existingPid: this.existingPid,
      ...(this.existingStartedAt ? { existingStartedAt: this.existingStartedAt } : {}),
    };
  }
}

// ---- Security errors -------------------------------------------------------

export class ZaiSecurityError extends ZaiError {
  readonly operation: string;

  constructor(message: string, operation: string, code: ErrorCode = 'TOOLS_SANDBOX_DENIED') {
    super(message, code, 403, { operation });
    this.name = 'ZaiSecurityError';
    this.operation = operation;
  }
}

// ---- Gateway errors --------------------------------------------------------

export class ZaiGatewayError extends ZaiError {
  constructor(message: string, code: ErrorCode = 'GATEWAY_TRANSPORT_ERROR', statusCode = 502) {
    super(message, code, statusCode);
    this.name = 'ZaiGatewayError';
  }
}

// ---- Session errors ---------------------------------------------------------

export class ZaiSessionNotFoundError extends ZaiError {
  readonly sessionId: string;

  constructor(sessionId: string) {
    super(`Session not found: ${sessionId}`, 'ENGINE_SESSION_NOT_FOUND', 404, { sessionId });
    this.name = 'ZaiSessionNotFoundError';
    this.sessionId = sessionId;
  }
}

export class ZaiSessionExpiredError extends ZaiError {
  readonly sessionId: string;

  constructor(sessionId: string) {
    super(`Session expired: ${sessionId}`, 'ENGINE_SESSION_EXPIRED', 410, { sessionId });
    this.name = 'ZaiSessionExpiredError';
    this.sessionId = sessionId;
  }
}

export class ZaiSessionMaxMessagesError extends ZaiError {
  readonly sessionId: string;
  readonly current: number;
  readonly max: number;

  constructor(sessionId: string, current: number, max: number) {
    super(
      `Session message limit reached: ${current}/${max}`,
      'ENGINE_SESSION_MAX_MESSAGES',
      422,
      { sessionId, current, max },
    );
    this.name = 'ZaiSessionMaxMessagesError';
    this.sessionId = sessionId;
    this.current = current;
    this.max = max;
  }
}
