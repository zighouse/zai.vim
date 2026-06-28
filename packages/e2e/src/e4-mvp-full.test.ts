// @zaivim/e2e — Epic 4+: MVP full suite + Mock Sandbox + Temp isolation
// Run: pnpm test:e2e -- --epic e4  (or: pnpm test:e2e for all)
// When no --epic filter, all tests run (MVP full).

import { describe, it, expect, afterAll } from 'vitest';
import { describeEpic, useTempDir, useTempDirWithConfig, MockSandboxManager, mockFetch, mockSSEBody } from './test-utils.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

describeEpic('e4', () => {

  // ---- Temporary directory isolation ----------------------------------------

  it('creates and cleans up temp directories', () => {
    const { path, cleanup } = useTempDir();
    expect(existsSync(path)).toBe(true);
    cleanup();
    expect(existsSync(path)).toBe(false);
  });

  it('creates temp dir with zaivim config', () => {
    const { path, cleanup } = useTempDirWithConfig({ providers: { test: { apiKey: 'sk-test' } } });
    const configPath = join(path, '.zaivim', 'project.yaml');
    expect(existsSync(configPath)).toBe(true);
    const config = readFileSync(configPath, 'utf-8');
    expect(config).toContain('sk-test');
    cleanup();
  });

  // ---- Mock Sandbox ---------------------------------------------------------

  it('MockSandboxManager records calls instead of executing', async () => {
    const sandbox = new MockSandboxManager();
    expect(sandbox.isSandboxAvailable()).toBe(false);

    await sandbox.execCommand('ls');
    await sandbox.readFile('/etc/passwd');
    await sandbox.writeFile('/tmp/test', 'data');

    expect(sandbox.calls).toHaveLength(3);
    expect(sandbox.calls[0].method).toBe('execCommand');
    expect(sandbox.calls[1].method).toBe('readFile');
    expect(sandbox.calls[2].method).toBe('writeFile');
  });

  it('MockSandboxManager resets between tests', () => {
    const sandbox = new MockSandboxManager();
    sandbox.calls.push({ method: 'stale', args: [] });
    sandbox.reset();
    expect(sandbox.calls).toHaveLength(0);
  });

  // ---- Mock SSE fetch -------------------------------------------------------

  it('mockFetch returns SSE-compatible response', async () => {
    const fetch = mockFetch(mockSSEBody(['data: {"hello":"world"}}']));
    const response = await fetch('http://test');
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/event-stream');

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const { value } = await reader.read();
    const text = decoder.decode(value);
    expect(text).toContain('hello');
  });
});
