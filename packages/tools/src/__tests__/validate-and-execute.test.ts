// Story 3.3, Task 4.2: validateAndExecute tests
// Covers param shape validation, type checks, and JSON roundtrip enforcement.

import { describe, it, expect, vi } from 'vitest';
import { ZaiToolError } from '@zaivim/core';
import type { ToolDefinition, ToolContext } from '@zaivim/core';
import { validateAndExecute } from '../registry.js';

function makeContext(): ToolContext {
  return {
    sessionId: 's1',
    sandbox: '/tmp',
    signal: new AbortController().signal,
    security: {
      sandboxType: 'none',
      preExecute: async () => ({ allowed: true, harmLevel: 'C' as const, reason: 'test' }),
      postExecute: async () => {},
      getStatus: () => ({ sandboxMode: 'null', platform: 'linux', filesystemRestricted: false, networkIsolated: false, auditLogPath: '', isOperational: false }),
      isSandboxAvailable: () => false,
      openFile: vi.fn() as any,
      validatePath: () => true,
      proposeChange: async () => true,
    },
    audit: vi.fn(),
    spawn: vi.fn() as any,
  };
}

function makeTool(overrides: Partial<ToolDefinition>): ToolDefinition {
  return {
    name: 'test_tool',
    description: 'test',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    execute: async () => 'ok',
    ...overrides,
  };
}

describe('validateAndExecute — params validation', () => {
  it('throws TOOLS_INVALID_PARAMS when rawParams is not a plain object', async () => {
    const tool = makeTool({});
    await expect(validateAndExecute(tool, null, makeContext())).rejects.toThrow(ZaiToolError);
    await expect(validateAndExecute(tool, 'string', makeContext())).rejects.toThrow(ZaiToolError);
    await expect(validateAndExecute(tool, [1, 2], makeContext())).rejects.toThrow(ZaiToolError);
    await expect(validateAndExecute(tool, 42, makeContext())).rejects.toThrow(ZaiToolError);
  });

  it('throws TOOLS_INVALID_PARAMS when required field is missing', async () => {
    const tool = makeTool({});
    await expect(
      validateAndExecute(tool, {}, makeContext()),
    ).rejects.toMatchObject({ code: 'TOOLS_INVALID_PARAMS' });
  });

  it('throws TOOLS_INVALID_PARAMS when primitive type does not match', async () => {
    const tool = makeTool({});
    await expect(
      validateAndExecute(tool, { path: 123 }, makeContext()),
    ).rejects.toMatchObject({ code: 'TOOLS_INVALID_PARAMS' });
  });

  it('executes when params match the schema', async () => {
    const tool = makeTool({ execute: async (p) => `got ${(p as { path: string }).path}` });
    const result = await validateAndExecute(tool, { path: '/x' }, makeContext());
    expect(result).toBe('got /x');
  });
});

describe('validateAndExecute — JSON roundtrip enforcement', () => {
  it('throws TOOLS_OUTPUT_NOT_SERIALIZABLE when result has undefined field', async () => {
    const tool = makeTool({
      execute: async () => ({ a: 1, b: undefined as unknown as number }),
    });
    await expect(
      validateAndExecute(tool, { path: '/x' }, makeContext()),
    ).rejects.toMatchObject({ code: 'TOOLS_OUTPUT_NOT_SERIALIZABLE' });
  });

  it('throws TOOLS_OUTPUT_NOT_SERIALIZABLE when result has a function member', async () => {
    const tool = makeTool({
      execute: async () => ({ a: 1, fn: (() => 1) as unknown as number }),
    });
    await expect(
      validateAndExecute(tool, { path: '/x' }, makeContext()),
    ).rejects.toMatchObject({ code: 'TOOLS_OUTPUT_NOT_SERIALIZABLE' });
  });

  it('throws TOOLS_OUTPUT_NOT_SERIALIZABLE when result has a circular reference', async () => {
    const tool = makeTool({
      execute: async () => {
        const obj: Record<string, unknown> = { a: 1 };
        obj.self = obj;
        return obj;
      },
    });
    await expect(
      validateAndExecute(tool, { path: '/x' }, makeContext()),
    ).rejects.toMatchObject({ code: 'TOOLS_OUTPUT_NOT_SERIALIZABLE' });
  });

  it('accepts nested JSON-serializable objects', async () => {
    const tool = makeTool({
      execute: async () => ({
        nested: { num: 1, str: 'a', bool: true, arr: [1, { x: 'y' }, null] },
      }),
    });
    const result = await validateAndExecute(tool, { path: '/x' }, makeContext());
    expect(result).toEqual({
      nested: { num: 1, str: 'a', bool: true, arr: [1, { x: 'y' }, null] },
    });
  });

  it('accepts a plain string result', async () => {
    const tool = makeTool({ execute: async () => 'plain string' });
    const result = await validateAndExecute(tool, { path: '/x' }, makeContext());
    expect(result).toBe('plain string');
  });

  it('throws TOOLS_OUTPUT_NOT_SERIALIZABLE when top-level result is undefined', async () => {
    const tool = makeTool({ execute: async () => undefined });
    await expect(
      validateAndExecute(tool, { path: '/x' }, makeContext()),
    ).rejects.toMatchObject({ code: 'TOOLS_OUTPUT_NOT_SERIALIZABLE' });
  });
});
