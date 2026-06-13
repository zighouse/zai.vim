// @zaivim/tools — ToolRegistry
// Story 3.1, Task 4: Registry for tool discovery, lookup, and OpenAI format conversion.
// Extended in Story 3.3 with lifecycle hooks, tier/source metadata, and skill namespacing.

import type { ToolDefinition, ToolContext, ZaiConfig } from '@zaivim/core';
import { ZaiToolError } from '@zaivim/core';
import { fileReadTool, fileWriteTool, fileSearchTool } from './file.js';
import { shellTool } from './shell.js';
import { webFetchTool, webSearchTool } from './web.js';

export type OpenAIExecuteFunction = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

/**
 * Story 3.3 (AC6/AC7): Metadata tracked alongside each registered tool.
 * `source` discriminates builtin tools from skill-contributed ones and
 * carries the skill namespace when applicable.
 */
export interface ToolMetadata {
  readonly source: 'builtin' | `skill:${string}`;
  readonly tier: 'first' | 'second';
}

/**
 * Built-in tool names that skill tools MUST NOT collide with (AC7).
 * Skill tools attempting to register these names are rejected with
 * TOOLS_NAME_CONFLICT regardless of namespace.
 */
const RESERVED_BUILTIN_NAMES: ReadonlySet<string> = new Set([
  'file_read',
  'file_write',
  'file_search',
  'shell_execute',
  'web_fetch',
  'web_search',
]);

/** Options accepted by {@link ToolRegistry.register}. */
export interface RegisterOptions {
  readonly source?: 'builtin' | 'skill';
  readonly skillName?: string;
}

/** Filter applied to {@link ToolRegistry.list}. */
export interface ListFilter {
  readonly tier?: 'first' | 'second';
  readonly source?: 'builtin' | 'skill';
}

/** Entry returned by {@link ToolRegistry.listWithMetadata}. */
export interface ToolListEntry {
  readonly tool: ToolDefinition;
  readonly source: string;
  readonly tier: 'first' | 'second';
}

type RegisterHandler = (tool: ToolDefinition, meta: ToolMetadata) => void;
type UnregisterHandler = (name: string) => void;

/**
 * ToolRegistry — manages tool registration, discovery, and format conversion.
 *
 * Thread-safe for concurrent reads (MVP: no locking; ToolExecutor serializes calls).
 * Name collision: register() throws on duplicate stored name.
 *
 * Story 3.3 additions:
 * - `register(tool, { source, skillName })` namespaces skill tools as
 *   `${skillName}.${toolName}` and rejects collisions with built-in names.
 * - `#metadata` tracks source + tier per tool without polluting ToolDefinition.
 * - `list({ tier, source })` filters for two-tier tool exposure (AC6).
 * - `listWithMetadata()` exposes source/tier for downstream consumers.
 * - `onRegister` / `onUnregister` lifecycle hooks (handler exceptions are
 *   swallowed — they MUST NOT abort registration, pre-mortem).
 * - `createDefault(config?)` applies `config.tools.tierOverride` after
 *   registering the six built-in tools.
 */
export class ToolRegistry {
  readonly #tools = new Map<string, ToolDefinition>();
  readonly #metadata = new Map<string, ToolMetadata>();
  readonly #registerHandlers = new Set<RegisterHandler>();
  readonly #unregisterHandlers = new Set<UnregisterHandler>();

  /**
   * Register a tool definition.
   *
   * - `source: 'builtin'` (default): stored under `tool.name`.
   * - `source: 'skill'` + `skillName`: stored under `${skillName}.${tool.name}`
   *   with `source: 'skill:${skillName}'` in metadata.
   * - `source: 'skill'` whose `tool.name` collides with a built-in: rejected
   *   with `TOOLS_NAME_CONFLICT`.
   *
   * Throws if the resolved stored name is already registered.
   */
  register(tool: ToolDefinition, options?: RegisterOptions): void {
    const source = options?.source ?? 'builtin';

    let storedName: string;
    let metaSource: ToolMetadata['source'];

    if (source === 'skill') {
      if (!options?.skillName) {
        throw new ZaiToolError(
          `Skill tool registration requires skillName: ${tool.name}`,
          'TOOLS_INVALID_PARAMS',
          400,
          tool.name,
        );
      }
      if (RESERVED_BUILTIN_NAMES.has(tool.name)) {
        throw new ZaiToolError(
          `tool name conflict: ${tool.name} is a reserved built-in tool`,
          'TOOLS_NAME_CONFLICT',
          409,
          tool.name,
        );
      }
      storedName = `${options.skillName}.${tool.name}`;
      metaSource = `skill:${options.skillName}`;
    } else {
      storedName = tool.name;
      metaSource = 'builtin';
    }

    if (this.#tools.has(storedName)) {
      throw new Error(`Tool already registered: ${storedName}`);
    }

    // For skill tools, expose the namespaced name on the stored definition so
    // list()/toOpenAITools() surface `docker.run` rather than the bare `run`.
    // Builtins are stored as-is (preserving the original reference).
    const storedTool: ToolDefinition = source === 'skill' && storedName !== tool.name
      ? { ...tool, name: storedName, skillName: options!.skillName, source: 'skill' }
      : tool;

    const tier = tool.tier ?? 'first';
    const meta: ToolMetadata = { source: metaSource, tier };
    this.#tools.set(storedName, storedTool);
    this.#metadata.set(storedName, meta);

    for (const handler of this.#registerHandlers) {
      try {
        handler(storedTool, meta);
      } catch (err) {
        // pre-mortem: handler exceptions must NOT abort registration.
        console.error('[ToolRegistry] onRegister handler threw:', err);
      }
    }
  }

  /**
   * Unregister a tool by its stored name.
   * Returns true if the tool was registered and removed, false if not found.
   */
  unregister(name: string): boolean {
    const deleted = this.#tools.delete(name);
    this.#metadata.delete(name);
    if (deleted) {
      for (const handler of this.#unregisterHandlers) {
        try {
          handler(name);
        } catch (err) {
          console.error('[ToolRegistry] onUnregister handler threw:', err);
        }
      }
    }
    return deleted;
  }

  /**
   * Look up a tool by its stored name.
   * Returns undefined if not found.
   */
  get(name: string): ToolDefinition | undefined {
    return this.#tools.get(name);
  }

  /**
   * Inspect metadata for a stored tool name.
   * Returns undefined for unknown names; builtin defaults when metadata is missing.
   */
  getMetadata(name: string): ToolMetadata | undefined {
    return this.#metadata.get(name);
  }

  /**
   * List registered tools, optionally filtered by tier or source.
   * Without a filter, returns every tool (backward-compatible with Story 3.1).
   */
  list(filter?: ListFilter): ToolDefinition[] {
    const entries = Array.from(this.#tools.entries());
    const filtered = entries.filter(([name, _tool]) => {
      const meta = this.#metadata.get(name);
      if (!meta) return true;
      if (filter?.tier && meta.tier !== filter.tier) return false;
      if (filter?.source === 'builtin' && meta.source !== 'builtin') return false;
      if (filter?.source === 'skill' && !meta.source.startsWith('skill:')) return false;
      return true;
    });
    return filtered.map(([_name, tool]) => tool);
  }

  /**
   * List registered tools with their metadata (source + tier).
   * Used by Gateway / audit log to distinguish builtin vs skill contributions.
   */
  listWithMetadata(): ToolListEntry[] {
    return Array.from(this.#tools.entries()).map(([name, tool]) => {
      const meta = this.#metadata.get(name) ?? { source: 'builtin' as const, tier: 'first' as const };
      return { tool, source: meta.source, tier: meta.tier };
    });
  }

  /**
   * Apply a tier override map (e.g. from `config.tools.tierOverride`).
   * Unknown tool names are silently ignored — operators may keep stale
   * entries in config without crashing the registry.
   */
  applyTierOverride(map: Readonly<Record<string, 'first' | 'second'>>): void {
    for (const [name, tier] of Object.entries(map)) {
      const existing = this.#metadata.get(name);
      if (!existing) continue;
      this.#metadata.set(name, { ...existing, tier });
    }
  }

  /**
   * Subscribe to tool registration events.
   * Returns an unsubscribe function. Handler exceptions are caught and
   * logged — they do not abort the registration flow.
   */
  onRegister(handler: RegisterHandler): () => void {
    this.#registerHandlers.add(handler);
    return () => this.#registerHandlers.delete(handler);
  }

  /**
   * Subscribe to tool unregistration events.
   * Returns an unsubscribe function. Handler exceptions are caught and logged.
   */
  onUnregister(handler: UnregisterHandler): () => void {
    this.#unregisterHandlers.add(handler);
    return () => this.#unregisterHandlers.delete(handler);
  }

  /**
   * Convert all registered tools to OpenAI-compatible function calling format.
   * Each tool's parameters.properties becomes the function.parameters schema.
   */
  toOpenAITools(): OpenAIExecuteFunction[] {
    return this.list().map(tool => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters as unknown as Record<string, unknown>,
      },
    }));
  }

  /**
   * Create a default ToolRegistry with all built-in tools registered.
   * When `config.tools.tierOverride` is provided, the override is applied
   * after registration (Story 3.3 AC6).
   */
  static createDefault(config?: ZaiConfig): ToolRegistry {
    const registry = new ToolRegistry();
    registry.register(fileReadTool);
    registry.register(fileWriteTool);
    registry.register(fileSearchTool);
    registry.register(shellTool);
    registry.register(webFetchTool);
    registry.register(webSearchTool);
    const tierOverride = config?.tools?.tierOverride;
    if (tierOverride) {
      registry.applyTierOverride(tierOverride);
    }
    return registry;
  }
}

// =============================================================================
// Story 3.3, Task 4: validateAndExecute — registry-layer entry point
// ADR-19 specifies this as the unified validation + execution + serialization
// gate. Hand-written validation per ADR + 3-1/3-2a/3-2b established pattern;
// ajv migration deferred to Epic 5.
// =============================================================================

function isPlainObject(x: unknown): x is Record<string, unknown> {
  if (x === null || typeof x !== 'object') return false;
  if (Array.isArray(x)) return false;
  const proto = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
}

function matchesDeclaredType(value: unknown, declared: string): boolean {
  switch (declared) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'null':
      return value === null;
    default:
      // Unknown / custom declared type (e.g. union) — accept; tools are
      // responsible for stricter checks when they opt into exotic schemas.
      return true;
  }
}

function validateParamsShape(def: ToolDefinition, rawParams: unknown): asserts rawParams is Record<string, unknown> {
  if (!isPlainObject(rawParams)) {
    throw new ZaiToolError(
      `Tool params must be a plain object: ${def.name}`,
      'TOOLS_INVALID_PARAMS',
      400,
      def.name,
      { receivedType: Array.isArray(rawParams) ? 'array' : rawParams === null ? 'null' : typeof rawParams },
    );
  }

  const required = def.parameters.required ?? [];
  for (const field of required) {
    if (rawParams[field] === undefined) {
      throw new ZaiToolError(
        `Missing required parameter "${field}" for tool ${def.name}`,
        'TOOLS_INVALID_PARAMS',
        400,
        def.name,
        { field },
      );
    }
  }

  // Light type validation for declared primitive properties.
  for (const [key, value] of Object.entries(rawParams)) {
    if (value === undefined) continue;
    const schema = def.parameters.properties[key];
    if (!schema) continue;
    if (!matchesDeclaredType(value, schema.type)) {
      throw new ZaiToolError(
        `Parameter "${key}" has wrong type for tool ${def.name}: expected ${schema.type}`,
        'TOOLS_INVALID_PARAMS',
        400,
        def.name,
        { field: key, expectedType: schema.type, actualType: typeof value },
      );
    }
  }
}

/** Structural deep-equal over JSON-compatible shapes (no function/symbol/undefined). */
function jsonDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => jsonDeepEqual(v, (b as unknown[])[i]));
  }
  if (typeof a === 'object') {
    if (typeof b !== 'object' || Array.isArray(b)) return false;
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const aKeys = Object.keys(aObj);
    const bKeys = Object.keys(bObj);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every(
      k => Object.prototype.hasOwnProperty.call(bObj, k) && jsonDeepEqual(aObj[k], bObj[k]),
    );
  }
  return false;
}

function assertJsonRoundtrip(def: ToolDefinition, original: unknown): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(original);
  } catch (err) {
    // Circular reference or other stringify failure
    throw new ZaiToolError(
      `Tool output is not JSON-serializable: ${def.name}`,
      'TOOLS_OUTPUT_NOT_SERIALIZABLE',
      500,
      def.name,
      { reason: err instanceof Error ? err.message : 'JSON.stringify threw' },
    );
  }

  if (typeof serialized === 'undefined') {
    // Top-level undefined/function/Symbol — JSON.stringify returns undefined.
    throw new ZaiToolError(
      `Tool output is not JSON-serializable: ${def.name} (top-level value cannot be stringified)`,
      'TOOLS_OUTPUT_NOT_SERIALIZABLE',
      500,
      def.name,
      { reason: 'JSON.stringify returned undefined' },
    );
  }

  const roundtripped = JSON.parse(serialized);
  if (!jsonDeepEqual(original, roundtripped)) {
    throw new ZaiToolError(
      `Tool output failed JSON roundtrip: ${def.name} (likely contains undefined, function, or Symbol that JSON.stringify silently drops)`,
      'TOOLS_OUTPUT_NOT_SERIALIZABLE',
      500,
      def.name,
    );
  }
}

/**
 * Validate params + execute tool + assert JSON roundtrip on result.
 *
 * Throws:
 * - `ZaiToolError(TOOLS_INVALID_PARAMS)` when rawParams is not a plain object,
 *   missing a required field, or has a primitive type mismatch.
 * - `ZaiToolError(TOOLS_OUTPUT_NOT_SERIALIZABLE)` when the tool returns a
 *   value containing undefined/function/Symbol members or a circular
 *   reference (JSON.stringify would silently drop or throw).
 *
 * Does NOT introduce ajv/zod — hand-written validation per ADR + established
 * 3-1/3-2a/3-2b pattern. Migration to ajv deferred to Epic 5.
 */
export async function validateAndExecute<TParams, TResult>(
  def: ToolDefinition<TParams, TResult>,
  rawParams: unknown,
  context: ToolContext,
): Promise<TResult> {
  validateParamsShape(def, rawParams);
  const params = rawParams as unknown as TParams;
  const result = await def.execute(params, context);
  assertJsonRoundtrip(def, result);
  return result;
}

// TODO(story-3.3-growth): two-tier sub-agent dispatch via AgentHandle (Epic 6)
//   The complete two-tier exposure requires `agent_{category}` pseudo-tools
//   that fan out through a ToolSubAgent. Defer until AgentHandle (Epic 6) lands.
// TODO(epic-7): skill warning non-blocking path when loader registers tools
//   Skill loader should emit `tool name conflict: {name} is a reserved
//   built-in tool` as a non-blocking warning (in addition to the hard reject
//   we do here) once the skill system exists.
