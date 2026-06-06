// @zaivim/gateway — Transport layer tests
// Tests health/ping/stop handlers and PID cross-check via stream injection

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { createStdioTransport } from '../stdio/transport.js';
import { MethodACL } from '../method-acl.js';
import type { EngineAPI } from '@zaivim/core';

// Mock engine factory
function createMockEngine(): EngineAPI & { destroy: ReturnType<typeof vi.fn> } {
  return {
    version: '0.1.0',
    getHealth: vi.fn().mockReturnValue({
      status: 'ok',
      sandboxAvailable: false,
      activeSessions: 0,
      activeAgents: 0,
    }),
    uptime: 1000,
    createSession: vi.fn().mockResolvedValue({ id: 'mock-session', status: 'active', createdAt: Date.now(), messages: [], config: {} }),
    getSession: vi.fn().mockReturnValue(undefined),
    closeSession: vi.fn().mockResolvedValue(undefined),
    pushSessionMessage: vi.fn(),
    createAgent: vi.fn(),
    destroy: vi.fn().mockResolvedValue(undefined),
  } as unknown as EngineAPI & { destroy: ReturnType<typeof vi.fn> };
}

/**
 * Collect all lines written to a PassThrough into an array.
 */
function collectOutput(stream: PassThrough): string[] {
  const lines: string[] = [];
  stream.on('data', (chunk: Buffer) => {
    lines.push(...chunk.toString().split('\n').filter(Boolean));
  });
  return lines;
}

describe('Transport method handlers', () => {
  let stdin: PassThrough;
  let stdout: PassThrough;
  let stdoutLines: string[];
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdin = new PassThrough();
    stdout = new PassThrough();
    stdoutLines = collectOutput(stdout);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
  });

  afterEach(async () => {
    stdin.end();
    stdout.end();
    // Yield so the readline close handler fires while spy is still active.
    // process.exit(0) in the close handler is async after stream.end().
    await new Promise((resolve) => setImmediate(resolve));
    exitSpy.mockRestore();
  });

  it('health handler returns engine status', async () => {
    const engine = createMockEngine();
    createStdioTransport(engine, undefined, { stdin: stdin as any, stdout: stdout as any });

    stdin.write('{"jsonrpc":"2.0","id":1,"method":"health"}\n');
    await new Promise((resolve) => setImmediate(resolve));

    expect(stdoutLines.length).toBeGreaterThan(0);
    const response = JSON.parse(stdoutLines[0]);
    expect(response.jsonrpc).toBe('2.0');
    expect(response.id).toBe(1);
    expect(response.result.status).toBe('ok');
    expect(response.result.version).toBe('0.1.0');
  });

  it('health handler returns down when PID cross-check fails (no daemon)', async () => {
    const engine = createMockEngine();
    // Pass a PID path that doesn't exist — cross-check returns 'down'
    createStdioTransport(engine, '/nonexistent/engine.pid', { stdin: stdin as any, stdout: stdout as any });

    stdin.write('{"jsonrpc":"2.0","id":2,"method":"health"}\n');
    await new Promise((resolve) => setImmediate(resolve));

    expect(stdoutLines.length).toBeGreaterThan(0);
    const response = JSON.parse(stdoutLines[0]);
    expect(response.result.status).toBe('down');
  });

  it('ping handler returns ok', async () => {
    const engine = createMockEngine();
    createStdioTransport(engine, undefined, { stdin: stdin as any, stdout: stdout as any });

    stdin.write('{"jsonrpc":"2.0","id":3,"method":"ping"}\n');
    await new Promise((resolve) => setImmediate(resolve));

    expect(stdoutLines.length).toBeGreaterThan(0);
    const response = JSON.parse(stdoutLines[0]);
    expect(response.result.status).toBe('ok');
    expect(response.result.version).toBe('0.1.0');
  });

  it('unknown method returns method_not_found error', async () => {
    const engine = createMockEngine();
    createStdioTransport(engine, undefined, { stdin: stdin as any, stdout: stdout as any });

    stdin.write('{"jsonrpc":"2.0","id":4,"method":"nonexistent"}\n');
    await new Promise((resolve) => setImmediate(resolve));

    expect(stdoutLines.length).toBeGreaterThan(0);
    const response = JSON.parse(stdoutLines[0]);
    expect(response.error.code).toBe(-32601);
    expect(response.error.message).toContain('Method not found');
  });

  it('stop handler calls engine.destroy', async () => {
    const engine = createMockEngine();
    createStdioTransport(engine, undefined, { stdin: stdin as any, stdout: stdout as any });

    stdin.write('{"jsonrpc":"2.0","id":5,"method":"stop"}\n');
    await new Promise((resolve) => setImmediate(resolve));

    expect(engine.destroy).toHaveBeenCalledWith({ force: false, reason: 'jsonrpc_stop' });

    expect(stdoutLines.length).toBeGreaterThan(0);
    const response = JSON.parse(stdoutLines[0]);
    expect(response.result.status).toBe('stopping');
  });

  it('parse error returns -32700 for invalid JSON', async () => {
    const engine = createMockEngine();
    createStdioTransport(engine, undefined, { stdin: stdin as any, stdout: stdout as any });

    stdin.write('this is not json\n');
    await new Promise((resolve) => setImmediate(resolve));

    expect(stdoutLines.length).toBeGreaterThan(0);
    const response = JSON.parse(stdoutLines[0]);
    expect(response.error.code).toBe(-32700);
  });
});

describe('Transport ACL integration', () => {
  let stdin: PassThrough;
  let stdout: PassThrough;
  let stdoutLines: string[];
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdin = new PassThrough();
    stdout = new PassThrough();
    stdoutLines = collectOutput(stdout);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
  });

  afterEach(async () => {
    stdin.end();
    stdout.end();
    await new Promise((resolve) => setImmediate(resolve));
    exitSpy.mockRestore();
  });

  it('public method health passes ACL check', async () => {
    const engine = createMockEngine();
    const acl = MethodACL.createDefault();
    createStdioTransport(engine, undefined, { stdin: stdin as any, stdout: stdout as any }, { acl });

    stdin.write('{"jsonrpc":"2.0","id":1,"method":"health"}\n');
    await new Promise((resolve) => setImmediate(resolve));

    expect(stdoutLines.length).toBeGreaterThan(0);
    const response = JSON.parse(stdoutLines[0]);
    expect(response.result.status).toBe('ok');
    expect(response.result.methods).toBeDefined();
    expect(response.result.methods.health).toBe('public');
  });

  it('admin method without token returns -32001', async () => {
    const engine = createMockEngine();
    const acl = MethodACL.createDefault();
    createStdioTransport(engine, undefined, { stdin: stdin as any, stdout: stdout as any }, { acl });

    stdin.write('{"jsonrpc":"2.0","id":2,"method":"audit.query"}\n');
    await new Promise((resolve) => setImmediate(resolve));

    expect(stdoutLines.length).toBeGreaterThan(0);
    const response = JSON.parse(stdoutLines[0]);
    expect(response.error.code).toBe(-32001);
    expect(response.error.message).toContain('Unauthorized');
  });

  it('admin method with token fails when no admin token file exists', async () => {
    // Without an actual ~/.zaivim/.admin-token file, even a provided token won't match
    const engine = createMockEngine();
    const acl = MethodACL.createDefault();
    createStdioTransport(engine, undefined, { stdin: stdin as any, stdout: stdout as any }, { acl });

    stdin.write('{"jsonrpc":"2.0","id":3,"method":"engine.stop","params":{"token":"some-token"}}\n');
    await new Promise((resolve) => setImmediate(resolve));

    expect(stdoutLines.length).toBeGreaterThan(0);
    const response = JSON.parse(stdoutLines[0]);
    // Will fail because admin token file doesn't exist
    expect(response.error.code).toBe(-32001);
  });

  it('session-scoped method without token returns -32001', async () => {
    const engine = createMockEngine();
    const acl = MethodACL.createDefault();
    createStdioTransport(engine, undefined, { stdin: stdin as any, stdout: stdout as any }, { acl });

    stdin.write('{"jsonrpc":"2.0","id":4,"method":"session.get","params":{"sessionId":"test"}}\n');
    await new Promise((resolve) => setImmediate(resolve));

    expect(stdoutLines.length).toBeGreaterThan(0);
    const response = JSON.parse(stdoutLines[0]);
    expect(response.error.code).toBe(-32001);
  });

  it('session-scoped method with token passes ACL', async () => {
    const engine = createMockEngine();
    const acl = MethodACL.createDefault();
    createStdioTransport(engine, undefined, { stdin: stdin as any, stdout: stdout as any }, { acl });

    // session.get is session-scoped — with token it passes ACL, then fails on session not found
    stdin.write('{"jsonrpc":"2.0","id":5,"method":"session.get","params":{"token":"sess-token","sessionId":"nonexistent"}}\n');
    await new Promise((resolve) => setImmediate(resolve));

    expect(stdoutLines.length).toBeGreaterThan(0);
    const response = JSON.parse(stdoutLines[0]);
    // Should pass ACL, then handler throws "Session not found"
    expect(response.error.message).toContain('Session not found');
  });

  it('unknown method still returns method_not_found (ACL check passes through)', async () => {
    const engine = createMockEngine();
    const acl = MethodACL.createDefault();
    createStdioTransport(engine, undefined, { stdin: stdin as any, stdout: stdout as any }, { acl });

    stdin.write('{"jsonrpc":"2.0","id":6,"method":"nonexistent"}\n');
    await new Promise((resolve) => setImmediate(resolve));

    expect(stdoutLines.length).toBeGreaterThan(0);
    const response = JSON.parse(stdoutLines[0]);
    expect(response.error.code).toBe(-32601);
  });

  it('methods field appears in health response when ACL is configured', async () => {
    const engine = createMockEngine();
    const acl = MethodACL.createDefault();
    createStdioTransport(engine, undefined, { stdin: stdin as any, stdout: stdout as any }, { acl });

    stdin.write('{"jsonrpc":"2.0","id":7,"method":"health"}\n');
    await new Promise((resolve) => setImmediate(resolve));

    const response = JSON.parse(stdoutLines[0]);
    expect(response.result.methods).toBeDefined();
    expect(response.result.methods.health).toBe('public');
    expect(response.result.methods['engine.stop']).toBe('admin');
  });

  it('methods field absent when ACL is not configured (backward compat)', async () => {
    const engine = createMockEngine();
    createStdioTransport(engine, undefined, { stdin: stdin as any, stdout: stdout as any });

    stdin.write('{"jsonrpc":"2.0","id":8,"method":"health"}\n');
    await new Promise((resolve) => setImmediate(resolve));

    const response = JSON.parse(stdoutLines[0]);
    expect(response.result.methods).toBeUndefined();
  });
});
