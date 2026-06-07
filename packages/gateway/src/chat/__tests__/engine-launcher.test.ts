// @zaivim/gateway — Engine launcher tests (AC3)

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @zaivim/engine module
vi.mock('@zaivim/engine', () => ({
  checkExistingPid: vi.fn(),
  readPidFile: vi.fn(),
}));

// Mock node:child_process
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

import { type EventEmitter } from 'node:events';
import { checkExistingPid } from '@zaivim/engine';
import { spawn } from 'node:child_process';

// Import after mocks are set up
const { ensureEngineRunning } = await import('../engine-launcher.js');

function makeMockStderr(): EventEmitter {
  const ee = new (require('node:events').EventEmitter)() as EventEmitter;
  (ee as any).destroy = vi.fn();
  return ee;
}

const mockCheckExistingPid = vi.mocked(checkExistingPid);
const mockSpawn = vi.mocked(spawn);

describe('ensureEngineRunning', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns immediately if engine is already running', async () => {
    mockCheckExistingPid.mockReturnValue({ alive: true, pid: 12345, data: null });

    const result = await ensureEngineRunning();

    expect(result.alreadyRunning).toBe(true);
    expect(result.pid).toBe(12345);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('spawns daemon and polls until engine is ready', async () => {
    mockCheckExistingPid
      .mockReturnValueOnce({ alive: false, pid: null, data: null }) // initial check
      .mockReturnValueOnce({ alive: false, pid: null, data: null }) // poll 1
      .mockReturnValueOnce({ alive: true, pid: 54321, data: null }); // poll 2

    const mockChild = { unref: vi.fn(), pid: 11111, stderr: makeMockStderr() };
    mockSpawn.mockReturnValue(mockChild as any);

    const result = await ensureEngineRunning();

    expect(result.alreadyRunning).toBe(false);
    expect(result.pid).toBe(54321);
    expect(mockSpawn).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining([expect.stringContaining('cli.js'), 'serve', '--daemon']),
      expect.objectContaining({ detached: true, stdio: ['ignore', 'ignore', 'pipe'] }),
    );
  });

  it('throws on startup timeout when engine never becomes alive', async () => {
    // Engine never becomes alive - but to avoid a 3-second test,
    // we use a scenario where initial check passes as not-alive,
    // spawn returns a child, but subsequent checks stay not-alive.
    // The function will poll for 3s, so we accept the slow test
    // or we can reduce the polling behavior.
    mockCheckExistingPid.mockReturnValue({ alive: false, pid: null, data: null });
    const mockChild = { unref: vi.fn(), pid: 11111, stderr: makeMockStderr() };
    mockSpawn.mockReturnValue(mockChild as any);

    // Use a race to avoid test running forever if logic changes
    const resultPromise = ensureEngineRunning();
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Test timeout')), 5000),
    );

    await expect(Promise.race([resultPromise, timeoutPromise])).rejects.toThrow(
      'Engine startup timed out',
    );
  });
});
