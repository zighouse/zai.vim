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
  ENGINE_SESSION_NOT_FOUND: 'ENGINE_SESSION_NOT_FOUND',
  ENGINE_CONFIG_INVALID: 'ENGINE_CONFIG_INVALID',

  // Tools
  TOOLS_INVALID_PARAMS: 'TOOLS_INVALID_PARAMS',
  TOOLS_FILE_NOT_FOUND: 'TOOLS_FILE_NOT_FOUND',
  TOOLS_PERMISSION_DENIED: 'TOOLS_PERMISSION_DENIED',
  TOOLS_EXECUTION_FAILED: 'TOOLS_EXECUTION_FAILED',
  TOOLS_OUTPUT_TOO_LARGE: 'TOOLS_OUTPUT_TOO_LARGE',
  TOOLS_SANDBOX_DENIED: 'TOOLS_SANDBOX_DENIED',

  // Skills
  SKILLS_LOAD_FAILED: 'SKILLS_LOAD_FAILED',
  SKILLS_RUNTIME_ERROR: 'SKILLS_RUNTIME_ERROR',
  SKILLS_INVALID_SIGNATURE: 'SKILLS_INVALID_SIGNATURE',

  // Gateway
  GATEWAY_PAYLOAD_TOO_LARGE: 'GATEWAY_PAYLOAD_TOO_LARGE',
  GATEWAY_TRANSPORT_ERROR: 'GATEWAY_TRANSPORT_ERROR',
  GATEWAY_METHOD_NOT_FOUND: 'GATEWAY_METHOD_NOT_FOUND',
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
