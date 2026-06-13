// Story 3.1, Task 5.4: ToolRegistry unit tests
// Story 3.3, Task 7.1: Extended with skill namespacing, conflict detection,
// tier/source filtering, lifecycle hooks, and config-driven tier override.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ZaiToolError } from '@zaivim/core';
import { ToolRegistry } from '../registry.js';
import type { ToolDefinition } from '@zaivim/core';
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

// ---- Story 3.3: skill namespacing + conflict detection (AC7) ----

function makeSkillTool(name: string): ToolDefinition {
  return {
    name,
    description: `Skill tool: ${name}`,
    parameters: { type: 'object', properties: {} },
    execute: async () => 'skill-ok',
  };
}

describe('ToolRegistry — skill namespacing (Story 3.3 AC7)', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it('auto-prefixes skill tools with `${skillName}.`', () => {
    registry.register(makeSkillTool('run'), { source: 'skill', skillName: 'docker' });

    expect(registry.get('docker.run')).toBeDefined();
    expect(registry.get('run')).toBeUndefined();
  });

  it('rejects skill tool name colliding with reserved builtin', () => {
    expect(() =>
      registry.register(makeSkillTool('file_read'), { source: 'skill', skillName: 'fs' }),
    ).toThrow(ZaiToolError);
    expect(() =>
      registry.register(makeSkillTool('file_read'), { source: 'skill', skillName: 'fs' }),
    ).toThrow(/reserved built-in tool/);
  });

  it('rejects every reserved builtin name', () => {
    const reserved = ['file_read', 'file_write', 'file_search', 'shell_execute', 'web_fetch', 'web_search'];
    for (const name of reserved) {
      expect(() =>
        registry.register(makeSkillTool(name), { source: 'skill', skillName: 'fs' }),
      ).toThrow(/reserved built-in tool/);
    }
  });

  it('requires skillName when source === skill', () => {
    expect(() =>
      registry.register(makeSkillTool('run'), { source: 'skill' }),
    ).toThrow(/skillName/);
  });

  it('default source is builtin — stored under bare tool.name', () => {
    registry.register(makeSkillTool('run'));
    expect(registry.get('run')).toBeDefined();
    expect(registry.getMetadata('run')?.source).toBe('builtin');
  });

  it('exposes skill source in metadata', () => {
    registry.register(makeSkillTool('run'), { source: 'skill', skillName: 'docker' });
    expect(registry.getMetadata('docker.run')?.source).toBe('skill:docker');
  });

  it('rejects duplicate stored name (skill vs builtin collision via namespace)', () => {
    registry.register(makeSkillTool('run'));
    expect(() =>
      registry.register(makeSkillTool('run'), { source: 'skill', skillName: 'docker'}),
    ).not.toThrow(); // different stored names — allowed
    expect(() =>
      registry.register(makeSkillTool('run'), { source: 'skill', skillName: 'docker'}),
    ).toThrow(/already registered/);
  });
});

// ---- Story 3.3: tier + source filtering (AC6) ----

describe('ToolRegistry — tier / source filtering (Story 3.3 AC6/AC7)', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
    registry.register({ ...fileReadTool, tier: 'first' });
    registry.register({ ...fileWriteTool, tier: 'second' });
    registry.register(makeSkillTool('search'), { source: 'skill', skillName: 'fs' });
  });

  it('list({tier:"first"}) returns only first-tier tools', () => {
    const tools = registry.list({ tier: 'first' });
    expect(tools.map(t => t.name)).toContain('file_read');
    expect(tools.map(t => t.name)).not.toContain('file_write');
  });

  it('list({tier:"second"}) returns only second-tier tools', () => {
    const tools = registry.list({ tier: 'second' });
    expect(tools.map(t => t.name)).toEqual(['file_write']);
  });

  it('list({source:"builtin"}) excludes skill tools', () => {
    const tools = registry.list({ source: 'builtin' });
    expect(tools.map(t => t.name)).not.toContain('fs.search');
  });

  it('list({source:"skill"}) returns only skill-namespaced tools', () => {
    const tools = registry.list({ source: 'skill' });
    expect(tools.map(t => t.name)).toEqual(['fs.search']);
  });

  it('listWithMetadata exposes source + tier', () => {
    const entries = registry.listWithMetadata();
    const read = entries.find(e => e.tool.name === 'file_read');
    expect(read?.source).toBe('builtin');
    expect(read?.tier).toBe('first');
    const skill = entries.find(e => e.tool.name === 'fs.search');
    expect(skill?.source).toBe('skill:fs');
  });

  it('createDefault(config) applies tierOverride', () => {
    const reg = ToolRegistry.createDefault({
      language: 'en',
      sandbox: { enabled: false, type: 'none', workDir: '/tmp', timeout: 30000 },
      providers: {},
      defaults: { provider: '', model: '', temperature: 0.7, maxTokens: 4096 },
      tools: { tierOverride: { web_fetch: 'second' } },
    });
    expect(reg.getMetadata('web_fetch')?.tier).toBe('second');
    expect(reg.getMetadata('file_read')?.tier).toBe('first');
  });

  it('applyTierOverride ignores unknown tool names', () => {
    registry.applyTierOverride({ nonexistent_tool: 'second' });
    // No throw, no change to existing tools
    expect(registry.getMetadata('file_read')?.tier).toBe('first');
  });
});

// ---- Story 3.3: lifecycle hooks (AC7, pre-mortem) ----

describe('ToolRegistry — lifecycle hooks (Story 3.3)', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it('onRegister fires with tool + metadata', () => {
    const handler = vi.fn();
    registry.onRegister(handler);
    registry.register(fileReadTool);

    expect(handler).toHaveBeenCalledWith(fileReadTool, expect.objectContaining({
      source: 'builtin',
      tier: 'first',
    }));
  });

  it('onUnregister fires with the stored name', () => {
    const handler = vi.fn();
    registry.onUnregister(handler);
    registry.register(fileReadTool);
    registry.unregister('file_read');

    expect(handler).toHaveBeenCalledWith('file_read');
  });

  it('unsubscribe stops further notifications', () => {
    const handler = vi.fn();
    const unsubscribe = registry.onRegister(handler);
    registry.register(fileReadTool);
    unsubscribe();
    registry.register(fileWriteTool);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('handler exceptions do NOT abort registration (pre-mortem)', () => {
    const throwing = vi.fn(() => { throw new Error('boom'); });
    const ok = vi.fn();
    registry.onRegister(throwing);
    registry.onRegister(ok);

    expect(() => registry.register(fileReadTool)).not.toThrow();
    expect(ok).toHaveBeenCalledWith(fileReadTool, expect.anything());
  });
});
