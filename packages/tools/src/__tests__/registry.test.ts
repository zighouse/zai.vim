// Story 3.1, Task 5.4: ToolRegistry unit tests
// Covers: register/unregister/get/list/duplicate detection/toOpenAITools/createDefault.

import { describe, it, expect, beforeEach } from 'vitest';
import { ToolRegistry } from '../registry.js';
import { fileReadTool, fileWriteTool, fileSearchTool } from '../file.js';

describe('ToolRegistry', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it('should register a tool', () => {
    registry.register(fileReadTool);

    expect(registry.get('file_read')).toBe(fileReadTool);
  });

  it('should throw on duplicate registration', () => {
    registry.register(fileReadTool);

    expect(() => registry.register(fileReadTool)).toThrow('Tool already registered: file_read');
  });

  it('should unregister a tool', () => {
    registry.register(fileReadTool);

    const removed = registry.unregister('file_read');
    expect(removed).toBe(true);
    expect(registry.get('file_read')).toBeUndefined();
  });

  it('should return false when unregistering non-existent tool', () => {
    const removed = registry.unregister('nonexistent');

    expect(removed).toBe(false);
  });

  it('should get a tool by name', () => {
    registry.register(fileWriteTool);

    const tool = registry.get('file_write');
    expect(tool).toBe(fileWriteTool);
    expect(tool!.name).toBe('file_write');
  });

  it('should return undefined for unknown tool', () => {
    const tool = registry.get('unknown_tool');

    expect(tool).toBeUndefined();
  });

  it('should list all registered tools', () => {
    registry.register(fileReadTool);
    registry.register(fileWriteTool);
    registry.register(fileSearchTool);

    const tools = registry.list();
    expect(tools).toHaveLength(3);
    expect(tools.map(t => t.name).sort()).toEqual(['file_read', 'file_search', 'file_write']);
  });

  it('should return empty list when no tools registered', () => {
    const tools = registry.list();

    expect(tools).toHaveLength(0);
  });

  it('toOpenAITools: should convert to OpenAI function format', () => {
    registry.register(fileReadTool);

    const openaiTools = registry.toOpenAITools();

    expect(openaiTools).toHaveLength(1);
    expect(openaiTools[0].type).toBe('function');
    expect(openaiTools[0].function.name).toBe('file_read');
    expect(openaiTools[0].function.parameters).toBeDefined();
    expect(openaiTools[0].function.parameters.type).toBe('object');
  });

  it('toOpenAITools: should include all tools after multiple registrations', () => {
    registry.register(fileReadTool);
    registry.register(fileWriteTool);
    registry.register(fileSearchTool);

    const openaiTools = registry.toOpenAITools();

    expect(openaiTools).toHaveLength(3);
    const names = openaiTools.map(t => t.function.name).sort();
    expect(names).toEqual(['file_read', 'file_search', 'file_write']);
  });

  it('createDefault: should include all built-in tools', () => {
    const defaultRegistry = ToolRegistry.createDefault();

    const tools = defaultRegistry.list();
    expect(tools).toHaveLength(6);

    expect(defaultRegistry.get('file_read')).toBeDefined();
    expect(defaultRegistry.get('file_write')).toBeDefined();
    expect(defaultRegistry.get('file_search')).toBeDefined();
    expect(defaultRegistry.get('shell_execute')).toBeDefined();
    expect(defaultRegistry.get('web_fetch')).toBeDefined();
    expect(defaultRegistry.get('web_search')).toBeDefined();
  });

  it('should maintain independence between registries', () => {
    const registry2 = new ToolRegistry();

    registry.register(fileReadTool);
    registry2.register(fileWriteTool);

    expect(registry.list()).toHaveLength(1);
    expect(registry2.list()).toHaveLength(1);
    expect(registry.get('file_read')).toBeDefined();
    expect(registry2.get('file_write')).toBeDefined();
    expect(registry2.get('file_read')).toBeUndefined();
  });
});
