// Story 3.3, Task 7.2: ToolExecutor registry-dispatch regression
// Verifies that executeToolCall/validateToolCalls dispatch through ToolRegistry
// (not array lookup), and that the 6 builtin tools from 3-1/3-2a/3-2b remain
// registered + dispatchable end-to-end.

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolRegistry } from '@zaivim/tools';
import type { ToolDefinition, ISecurityProvider, SecurityDecision } from '@zaivim/core';
import { executeToolCall, validateToolCalls } from '../tool-executor.js';

function allowProvider(): ISecurityProvider {
  return {
    sandboxType: 'none',
    preExecute: async (): Promise<SecurityDecision> => ({
      allowed: true,
      harmLevel: 'C',
      reason: 'test allow',
    }),
    postExecute: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn() as never,
    isSandboxAvailable: () => false,
    validatePath: () => true,
    proposeChange: async () => true,
    validatePathAsync: async () => '/test/project',
  };
}

describe('Story 3.3 Task 7.2: registry dispatch (executeToolCall)', () => {
  it('registry.get(name) hit → executes', async () => {
    const registry = new ToolRegistry();
    const tool: ToolDefinition = {
      name: 'echo_test',
      description: 'echo',
      parameters: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
      execute: async (p) => `echoed:${(p as { msg: string }).msg}`,
    };
    registry.register(tool);

    const result = await executeToolCall(
      { id: 'tc-1', name: 'echo_test', arguments: { msg: 'hi' } },
      registry,
      { sessionId: 's1', sandbox: '/tmp', security: allowProvider(), audit: vi.fn() },
    );
    expect(result.timedOut).toBe(false);
    expect(result.result).toBe('echoed:hi');
  });

  it('registry.get(name) miss → returns TOOLS_NOT_FOUND', async () => {
    const registry = new ToolRegistry();
    const result = await executeToolCall(
      { id: 'tc-1', name: 'missing_tool', arguments: {} },
      registry,
      { sessionId: 's1', sandbox: '/tmp', security: allowProvider(), audit: vi.fn() },
    );
    expect(result.timedOut).toBe(false);
    const parsed = JSON.parse(result.result);
    expect(parsed.code).toBe('TOOLS_NOT_FOUND');
    expect(parsed.message).toContain('missing_tool');
  });

  it('executeToolCall never falls back to array lookup', async () => {
    // Ensure we exercise the registry.get path by spying on it.
    const registry = new ToolRegistry();
    const spy = vi.spyOn(registry, 'get');
    registry.register({
      name: 'sample',
      description: 'd',
      parameters: { type: 'object', properties: {} },
      execute: async () => 'ok',
    });

    await executeToolCall(
      { id: 'tc-1', name: 'sample', arguments: {} },
      registry,
      { sessionId: 's1', sandbox: '/tmp', security: allowProvider(), audit: vi.fn() },
    );

    expect(spy).toHaveBeenCalledWith('sample');
  });
});

describe('Story 3.3 Task 7.2: validateToolCalls uses registry.list()', () => {
  it('rejects tool names not present in registry', () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'known',
      description: 'd',
      parameters: { type: 'object', properties: {} },
      execute: async () => 'ok',
    });
    const result = validateToolCalls(
      [
        { id: 'tc-1', name: 'known', arguments: {} },
        { id: 'tc-2', name: 'unknown', arguments: {} },
      ],
      registry,
    );
    expect(result.valid.length).toBe(1);
    expect(result.valid[0]!.name).toBe('known');
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]!.code).toBe('TOOLS_NOT_FOUND');
    expect(result.errors[0]!.message).toContain('unknown');
  });

  it('accepts all valid tool calls when registry contains them', () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'a',
      description: 'd',
      parameters: { type: 'object', properties: {} },
      execute: async () => 'ok',
    });
    registry.register({
      name: 'b',
      description: 'd',
      parameters: { type: 'object', properties: {} },
      execute: async () => 'ok',
    });
    const result = validateToolCalls(
      [
        { id: 'tc-1', name: 'a', arguments: {} },
        { id: 'tc-2', name: 'b', arguments: {} },
      ],
      registry,
    );
    expect(result.valid.length).toBe(2);
    expect(result.errors.length).toBe(0);
  });
});

describe('Story 3.3 Task 7.2: builtin tools regression (3-1/3-2a/3-2b)', () => {
  it('createDefault() registers all 6 builtin tools with stable names', () => {
    const registry = ToolRegistry.createDefault();
    const expected = ['file_read', 'file_write', 'file_search', 'shell_execute', 'web_fetch', 'web_search'];
    for (const name of expected) {
      expect(registry.get(name), `expected ${name} to be registered`).toBeDefined();
    }
    expect(registry.list().length).toBeGreaterThanOrEqual(6);
  });

  it('file_read dispatches end-to-end via registry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zai-3-3-reg-'));
    try {
      const path = join(dir, 'sample.txt');
      writeFileSync(path, 'registry dispatch content');
      const registry = ToolRegistry.createDefault();

      // No security injected → NullSecurityProvider fallback (AC5) provides
      // a real openFile used by file_read.
      const result = await executeToolCall(
        { id: 'tc-1', name: 'file_read', arguments: { path } },
        registry,
        { sessionId: 's1', sandbox: dir, audit: vi.fn() },
      );
      expect(result.timedOut).toBe(false);
      expect(result.result).toContain('registry dispatch content');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('validateToolCalls accepts all 6 builtin tool names', () => {
    const registry = ToolRegistry.createDefault();
    const result = validateToolCalls(
      [
        { id: '1', name: 'file_read', arguments: { path: '/x' } },
        { id: '2', name: 'file_write', arguments: { path: '/x', content: '' } },
        { id: '3', name: 'file_search', arguments: { pattern: '*' } },
        { id: '4', name: 'shell_execute', arguments: { command: 'echo hi' } },
        { id: '5', name: 'web_fetch', arguments: { url: 'https://example.com' } },
        { id: '6', name: 'web_search', arguments: { query: 'x' } },
      ],
      registry,
    );
    expect(result.valid.length).toBe(6);
    expect(result.errors.length).toBe(0);
  });
});
