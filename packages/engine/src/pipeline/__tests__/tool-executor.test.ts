import { describe, it, expect, vi } from 'vitest';
import type { ToolDefinition, ToolContext } from '@zaivim/core';
import { executeToolCall, executeToolCalls, validateToolCalls } from '../tool-executor.js';

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
      [tool],
      { sessionId: 's1', sandbox: '/tmp', security: { sandboxType: 'none', validatePath: () => true, proposeChange: async () => true, isSandboxAvailable: () => false }, audit: vi.fn() },
    );
    expect(result.timedOut).toBe(false);
    expect(result.result).toContain('/test.txt');
  });

  it('should return error for unknown tool', async () => {
    const result = await executeToolCall(
      { id: 'tc-1', name: 'unknown_tool', arguments: {} },
      [],
      { sessionId: 's1', sandbox: '/tmp', security: { sandboxType: 'none', validatePath: () => true, proposeChange: async () => true, isSandboxAvailable: () => false }, audit: vi.fn() },
    );
    expect(result.result).toContain('Tool not found');
  });

  it('should timeout and emit event', async () => {
    const emit = vi.fn();
    const result = await executeToolCall(
      { id: 'tc-1', name: 'slow_tool', arguments: {} },
      [slowTool],
      {
        sessionId: 's1',
        sandbox: '/tmp',
        security: { sandboxType: 'none', validatePath: () => true, proposeChange: async () => true, isSandboxAvailable: () => false },
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
    const results = await executeToolCalls(
      [
        { id: 'tc-1', name: 'echo', arguments: { a: 1 } },
        { id: 'tc-2', name: 'echo', arguments: { b: 2 } },
      ],
      [tool],
      { sessionId: 's1', sandbox: '/tmp', security: { sandboxType: 'none', validatePath: () => true, proposeChange: async () => true, isSandboxAvailable: () => false }, audit: vi.fn() },
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
        [makeTool('echo')],
        { sessionId: 's1', sandbox: '/tmp', signal: ac.signal, security: { sandboxType: 'none', validatePath: () => true, proposeChange: async () => true, isSandboxAvailable: () => false }, audit: vi.fn() },
      ),
    ).rejects.toThrow();
  });
});

describe('validateToolCalls', () => {
  it('should accept registered tool calls', () => {
    const tools = [makeTool('read_file'), makeTool('write_file')];
    const result = validateToolCalls(
      [{ id: 'tc-1', name: 'read_file', arguments: {} }],
      tools,
    );
    expect(result.valid.length).toBe(1);
    expect(result.errors.length).toBe(0);
  });

  it('should reject unknown tool names', () => {
    const tools = [makeTool('read_file')];
    const result = validateToolCalls(
      [{ id: 'tc-1', name: 'delete_everything', arguments: {} }],
      tools,
    );
    expect(result.valid.length).toBe(0);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]!.code).toBe('PIPELINE_TOOL_NOT_FOUND');
  });

  it('should reject tool calls without id', () => {
    const tools = [makeTool('read_file')];
    const result = validateToolCalls(
      [{ id: '', name: 'read_file', arguments: {} }],
      tools,
    );
    expect(result.valid.length).toBe(0);
    expect(result.errors.length).toBe(1);
  });
});
