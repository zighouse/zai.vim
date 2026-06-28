// @zaivim/e2e — Shared test utilities
// Temporary directories, mock sandbox, epic filtering.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---- Epic filtering ---------------------------------------------------------

const currentEpic = process.env.E2E_EPIC || '';

/** Skip test suite if the current epic filter doesn't match. */
export function describeEpic(epic: string, fn: () => void): void {
  const describeFn = !currentEpic || currentEpic === epic ? describe : describe.skip;
  describeFn(`Epic ${epic}`, fn);
}

// ---- Temporary directory ----------------------------------------------------

/** Create a disposable temp directory. Returns path and cleanup function. */
export function useTempDir(): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), 'zaivim-e2e-'));
  return {
    path,
    cleanup: () => { rmSync(path, { recursive: true, force: true }); },
  };
}

/** Create a disposable temp directory with a zaivim config. */
export function useTempDirWithConfig(config?: Record<string, unknown>): { path: string; cleanup: () => void } {
  const { path, cleanup } = useTempDir();
  const configDir = join(path, '.zaivim');
  mkdirSync(configDir, { recursive: true });
  if (config) {
    writeFileSync(join(configDir, 'project.yaml'), JSON.stringify(config, null, 2));
  }
  return { path, cleanup };
}

// ---- Mock Sandbox -----------------------------------------------------------

export interface MockSandboxCall {
  method: string;
  args: unknown[];
}

/** A fake sandbox manager that records calls instead of executing bwrap. */
export class MockSandboxManager {
  readonly calls: MockSandboxCall[] = [];

  isSandboxAvailable(): boolean { return false; }

  async execCommand(_cmd: string, _args?: string[], _opts?: Record<string, unknown>): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    this.calls.push({ method: 'execCommand', args: [_cmd, _args, _opts] });
    return { exitCode: 0, stdout: 'mock', stderr: '' };
  }

  async readFile(_path: string, _encoding?: string): Promise<string> {
    this.calls.push({ method: 'readFile', args: [_path, _encoding] });
    return 'mock content';
  }

  async writeFile(_path: string, _content: string): Promise<void> {
    this.calls.push({ method: 'writeFile', args: [_path, _content] });
  }

  /** Reset recorded calls (for per-test isolation). */
  reset(): void { this.calls.length = 0; }
}

// ---- Mock fetch for provider testing ----------------------------------------

/** Build a mock SSE response body from data lines. */
export function mockSSEBody(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const chunks = lines.map(l => encoder.encode(l + '\n'));
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

/** Create a mock fetch function that returns the given body as SSE. */
export function mockFetch(body: ReadableStream<Uint8Array>): typeof globalThis.fetch {
  return async () =>
    new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
}

/** Create a mock fetch that returns the given status and body. */
export function mockFetchError(status: number, body?: string): typeof globalThis.fetch {
  return async () =>
    new Response(body ?? null, { status });
}
