import { describe, it, expect, vi } from 'vitest';
import type { ToolDefinition, ToolContext, SecurityDecision } from '@zaivim/core';
import { ToolRegistry } from '@zaivim/tools';
import { executeToolCall, executeToolCalls, validateToolCalls } from '../tool-executor.js';

/** Build a registry preloaded with the given tools. */
function makeRegistry(...tools: ToolDefinition[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);
  return registry;
}

/** Security provider that denies everything */
function denyProvider(): import('@zaivim/core').ISecurityProvider {
  return {
    sandboxType: 'none',
    preExecute: async (_op, _params): Promise<SecurityDecision> => ({
      allowed: false,
      harmLevel: 'S',
      reason: 'Test: all operations denied',
    }),
    postExecute: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn() as any,
    isSandboxAvailable: () => false,
    validatePath: () => false,
    proposeChange: async () => false,
  };
}

/** Security provider that always allows */
function allowProvider(): import('@zaivim/core').ISecurityProvider {
  return {
    sandboxType: 'none',
    preExecute: async (_op, _params): Promise<SecurityDecision> => ({
      allowed: true,
      harmLevel: 'C',
      reason: 'Test: all operations allowed',
    }),
    postExecute: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn() as any,
    isSandboxAvailable: () => false,
    validatePath: () => true,
    proposeChange: async () => true,
  };
}

function makeTool(name: string, impl?: (params: unknown, ctx: ToolContext) => Promise<unknown>): ToolDefinition {
  return {
    name,
    description: `Test tool: ${name}`,
    parameters: { type: 'object', properties: {} },
    execute: impl ?? (async () => 'ok'),
  };
}

const slowTool: ToolDefinition = {
  name: 'slow_tool',
  description: 'A tool that takes a long time',
  parameters: { type: 'object', properties: {} },
  execute: async (_params, ctx) => {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve('done'), 10_000);
      ctx.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve('aborted');
      });
    });
  },
};

describe('executeToolCall', () => {
  it('should execute a registered tool', async () => {
    const tool = makeTool('read_file', async (params) => `content of ${(params as { path: string }).path}`);
    const result = await executeToolCall(
      { id: 'tc-1', name: 'read_file', arguments: { path: '/test.txt' } },
      makeRegistry(tool),
      { sessionId: 's1', sandbox: '/tmp', security: allowProvider(), audit: vi.fn() },
    );
    expect(result.timedOut).toBe(false);
    expect(result.result).toContain('/test.txt');
  });

  it('should return error for unknown tool', async () => {
    const result = await executeToolCall(
      { id: 'tc-1', name: 'unknown_tool', arguments: {} },
      makeRegistry(),
      { sessionId: 's1', sandbox: '/tmp', security: { sandboxType: 'none', validatePath: () => true, proposeChange: async () => true, isSandboxAvailable: () => false }, audit: vi.fn() },
    );
    expect(result.result).toContain('Tool not found');
    const parsed = JSON.parse(result.result);
    expect(parsed.code).toBe('TOOLS_NOT_FOUND');
  });

  it('should timeout and emit event', async () => {
    const emit = vi.fn();
    const result = await executeToolCall(
      { id: 'tc-1', name: 'slow_tool', arguments: {} },
      makeRegistry(slowTool),
      {
        sessionId: 's1',
        sandbox: '/tmp',
        security: allowProvider(),
        audit: vi.fn(),
        timeout: 100, // 100ms timeout
        emit,
      },
    );
    expect(result.timedOut).toBe(true);
    expect(emit).toHaveBeenCalledWith('tool.timeout', expect.objectContaining({ toolCallId: 'tc-1' }));
  });
});

describe('executeToolCalls', () => {
  it('should execute multiple tool calls serially', async () => {
    const tool = makeTool('echo', async (params) => JSON.stringify(params));
    const { messages: results } = await executeToolCalls(
      [
        { id: 'tc-1', name: 'echo', arguments: { a: 1 } },
        { id: 'tc-2', name: 'echo', arguments: { b: 2 } },
      ],
      makeRegistry(tool),
      { sessionId: 's1', sandbox: '/tmp', security: allowProvider(), audit: vi.fn() },
    );
    expect(results.length).toBe(2);
    expect(results[0]!.role).toBe('tool');
    expect(results[1]!.role).toBe('tool');
  });

  it('should throw on abort signal', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      executeToolCalls(
        [{ id: 'tc-1', name: 'echo', arguments: {} }],
        makeRegistry(makeTool('echo')),
        { sessionId: 's1', sandbox: '/tmp', signal: ac.signal, security: { sandboxType: 'none', validatePath: () => true, proposeChange: async () => true, isSandboxAvailable: () => false }, audit: vi.fn() },
      ),
    ).rejects.toThrow();
  });
});

describe('validateToolCalls', () => {
  it('should accept registered tool calls', () => {
    const registry = makeRegistry(makeTool('read_file'), makeTool('write_file'));
    const result = validateToolCalls(
      [{ id: 'tc-1', name: 'read_file', arguments: {} }],
      registry,
    );
    expect(result.valid.length).toBe(1);
    expect(result.errors.length).toBe(0);
  });

  it('should reject unknown tool names', () => {
    const registry = makeRegistry(makeTool('read_file'));
    const result = validateToolCalls(
      [{ id: 'tc-1', name: 'delete_everything', arguments: {} }],
      registry,
    );
    expect(result.valid.length).toBe(0);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]!.code).toBe('TOOLS_NOT_FOUND');
  });

  it('should reject tool calls without id', () => {
    const registry = makeRegistry(makeTool('read_file'));
    const result = validateToolCalls(
      [{ id: '', name: 'read_file', arguments: {} }],
      registry,
    );
    expect(result.valid.length).toBe(0);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]!.code).toBe('PIPELINE_TOOL_NOT_FOUND');
  });
});

describe('security enforcement (AC9 / ADR-5)', () => {
  it('should block execution when security denies', async () => {
    const tool = makeTool('read_file');
    const result = await executeToolCall(
      { id: 'tc-1', name: 'read_file', arguments: { path: '/test.txt' } },
      makeRegistry(tool),
      { sessionId: 's1', sandbox: '/tmp', security: denyProvider(), audit: vi.fn() },
    );
    expect(result.timedOut).toBe(false);
    const parsed = JSON.parse(result.result);
    expect(parsed.error).toContain('blocked');
    expect(parsed.harmLevel).toBe('S');
  });

  it('should allow execution when security allows', async () => {
    const tool = makeTool('echo', async (params) => JSON.stringify(params));
    const result = await executeToolCall(
      { id: 'tc-1', name: 'echo', arguments: { msg: 'hello' } },
      makeRegistry(tool),
      { sessionId: 's1', sandbox: '/tmp', security: allowProvider(), audit: vi.fn() },
    );
    expect(result.result).toContain('hello');
    expect(result.timedOut).toBe(false);
  });

  it('should call postExecute after successful execution', async () => {
    const postExecute = vi.fn().mockResolvedValue(undefined);
    const provider: import('@zaivim/core').ISecurityProvider = {
      ...allowProvider(),
      postExecute,
    };
    const tool = makeTool('echo', async (params) => JSON.stringify(params));
    await executeToolCall(
      { id: 'tc-1', name: 'echo', arguments: { msg: 'hello' } },
      makeRegistry(tool),
      { sessionId: 's1', sandbox: '/tmp', security: provider, audit: vi.fn() },
    );
    expect(postExecute).toHaveBeenCalledWith('echo', expect.objectContaining({ success: true }));
  });

  it('should call postExecute on execution error', async () => {
    const postExecute = vi.fn().mockResolvedValue(undefined);
    const provider: import('@zaivim/core').ISecurityProvider = {
      ...allowProvider(),
      postExecute,
    };
    const tool = makeTool('fail', async () => { throw new Error('execution failed'); });
    await executeToolCall(
      { id: 'tc-1', name: 'fail', arguments: {} },
      makeRegistry(tool),
      { sessionId: 's1', sandbox: '/tmp', security: provider, audit: vi.fn() },
    );
    expect(postExecute).toHaveBeenCalledWith('fail', expect.objectContaining({ success: false }));
  });

  it('should propagate harm level in error message', async () => {
    const result = await executeToolCall(
      { id: 'tc-1', name: 'read_file', arguments: { path: '/etc/passwd' } },
      makeRegistry(makeTool('read_file')),
      { sessionId: 's1', sandbox: '/tmp', security: denyProvider(), audit: vi.fn() },
    );
    const parsed = JSON.parse(result.result);
    expect(parsed.harmLevel).toBe('S');
    expect(parsed.reason).toContain('denied');
  });
});
