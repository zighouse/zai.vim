// @zaivim/tools — ToolRegistry
// Story 3.1, Task 4: Registry for tool discovery, lookup, and OpenAI format conversion.
// Extended in Story 3.3 with lifecycle hooks and dependency resolution.

import type { ToolDefinition } from '@zaivim/core';
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
 * ToolRegistry — manages tool registration, discovery, and format conversion.
 *
 * Thread-safe for concurrent reads (MVP: no locking; ToolExecutor serializes calls).
 * Name collision: register() throws on duplicate name.
 */
export class ToolRegistry {
  readonly #tools = new Map<string, ToolDefinition>();

  /**
   * Register a tool definition.
   * Throws if a tool with the same name is already registered.
   */
  register(tool: ToolDefinition): void {
    if (this.#tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.#tools.set(tool.name, tool);
  }

  /**
   * Unregister a tool by name.
   * Returns true if the tool was registered and removed, false if not found.
   */
  unregister(name: string): boolean {
    return this.#tools.delete(name);
  }

  /**
   * Look up a tool by name.
   * Returns undefined if not found.
   */
  get(name: string): ToolDefinition | undefined {
    return this.#tools.get(name);
  }

  /**
   * List all registered tools.
   * Returns a snapshot array — modifications to the registry are not reflected.
   */
  list(): ToolDefinition[] {
    return Array.from(this.#tools.values());
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
   */
  static createDefault(): ToolRegistry {
    const registry = new ToolRegistry();
    registry.register(fileReadTool);
    registry.register(fileWriteTool);
    registry.register(fileSearchTool);
    registry.register(shellTool);
    registry.register(webFetchTool);
    registry.register(webSearchTool);
    return registry;
  }
}
