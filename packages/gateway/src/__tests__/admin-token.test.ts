// @zaivim/gateway — Admin token file round-trip tests (Story 4.3 Task 5)
//
// admin-token.ts resolves ADMIN_TOKEN_PATH via `os.homedir()` at module
// load time. We mock `node:os` so each test gets a fresh temp home, then
// re-import the module so it picks up the new path.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mutable pointer that the mocked homedir reads from. The `vi.hoisted`
// wrapper lifts it above Vitest's module hoisting so it's available when
// the mocked factory runs.
const state = vi.hoisted(() => ({ home: '' }));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    homedir: () => state.home || actual.homedir(),
  };
});

let tempHome = '';

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'zaivim-admin-token-'));
  state.home = tempHome;
  vi.resetModules();
});

afterEach(() => {
  state.home = '';
  if (existsSync(tempHome)) {
    rmSync(tempHome, { recursive: true, force: true });
  }
  vi.resetModules();
});

describe('admin token file', () => {
  it('returns the configured hex length', async () => {
    const mod = await import('../admin-token.js');
    expect(mod.ADMIN_TOKEN_LENGTH).toBe(64);
  });

  it('returns undefined when the token file is absent', async () => {
    const mod = await import('../admin-token.js');
    expect(mod.readAdminToken()).toBeUndefined();
  });

  it('generate creates a 64-char token at ADMIN_TOKEN_PATH with mode 0600', async () => {
    const mod = await import('../admin-token.js');
    const token = mod.generateAdminToken();

    expect(token).toHaveLength(64);
    expect(existsSync(mod.ADMIN_TOKEN_PATH)).toBe(true);
    expect(readFileSync(mod.ADMIN_TOKEN_PATH, 'utf-8').trim()).toBe(token);

    const mode = statSync(mod.ADMIN_TOKEN_PATH).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('read returns the most recently written token', async () => {
    const mod = await import('../admin-token.js');
    const a = mod.generateAdminToken();
    expect(mod.readAdminToken()).toBe(a);

    const b = mod.generateAdminToken();
    expect(mod.readAdminToken()).toBe(b);
    expect(a).not.toBe(b);
  });

  it('remove deletes the token file (idempotent)', async () => {
    const mod = await import('../admin-token.js');
    mod.generateAdminToken();
    expect(existsSync(mod.ADMIN_TOKEN_PATH)).toBe(true);

    mod.removeAdminToken();
    expect(existsSync(mod.ADMIN_TOKEN_PATH)).toBe(false);

    // Calling again should be a no-op, not an error.
    expect(() => mod.removeAdminToken()).not.toThrow();
  });
});
