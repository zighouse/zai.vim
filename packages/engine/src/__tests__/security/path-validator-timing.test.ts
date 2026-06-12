// =============================================================================
// @zaivim/engine — Timing side-channel statistical test (Subtask 6.5)
// Story 2.4, Task 3: Verifies padTiming/rejectWithTiming produce
// statistically indistinguishable response times for valid vs rejected paths.
//
// Uses 200 iterations per path type. Measures external elapsed time to detect
// observable timing differences. setTimeout has inherent jitter (1-4ms), so
// individual measurements may dip slightly below 10ms; the statistical tests
// focus on mean-level indistinguishability and distribution overlap.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted mock functions — accessible inside vi.mock factories
const { mockExistsSync, mockReadlinkSync, mockOpen } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockReadlinkSync: vi.fn(),
  mockOpen: vi.fn(),
}));

vi.mock('node:fs', () => ({
  existsSync: mockExistsSync,
  readlinkSync: mockReadlinkSync,
}));

vi.mock('node:fs/promises', () => ({
  open: mockOpen,
}));

import { validatePathSafe } from '../../security/path-validator.js';

// ─── Helpers ─────────────────────────────────────────────────────────────

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Measure elapsed time for a single validatePathSafe call */
async function measureOne(absPath: string, projectRoot: string): Promise<number> {
  const start = performance.now();
  await validatePathSafe(absPath, projectRoot, 'read');
  return performance.now() - start;
}

/** Collect N timing samples */
async function collectSamples(
  absPath: string,
  projectRoot: string,
  iterations: number,
): Promise<number[]> {
  const timings: number[] = [];
  for (let i = 0; i < iterations; i++) {
    timings.push(await measureOne(absPath, projectRoot));
  }
  return timings;
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('Timing side-channel protection (Subtask 6.5)', () => {
  const projectRoot = '/home/user/project';
  const validPath = projectRoot + '/src/index.ts';
  const rejectedPath = '/etc/passwd';
  const ITERATIONS = 200;

  beforeEach(() => {
    vi.clearAllMocks();

    // .git exists at project root
    mockExistsSync.mockImplementation((p: unknown) => {
      return String(p) === projectRoot + '/.git';
    });

    // Mock open succeeds for valid path, fails for rejected
    mockOpen.mockImplementation(async (p: string) => {
      if (String(p).startsWith(projectRoot)) {
        return { fd: 42, readFile: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
      }
      throw new Error('ENOENT');
    });

    // /proc/self/fd cross-verification: return same valid path
    mockReadlinkSync.mockReturnValue(projectRoot + '/src/index.ts');
  });

  // setTimeout(10) may fire 0.5-2ms early in Node.js due to event-loop
  // scheduling; the ≥10ms in code guards against sub-ms timing leaks.
  // The practical floor with real timers is ~9ms for both paths.
  it(`mean timing >= 9ms for valid paths (${ITERATIONS} iterations)`, async () => {
    const timings = await collectSamples(validPath, projectRoot, ITERATIONS);
    expect(mean(timings)).toBeGreaterThanOrEqual(9);
  });

  it(`mean timing >= 9ms for rejected paths (${ITERATIONS} iterations)`, async () => {
    const timings = await collectSamples(rejectedPath, projectRoot, ITERATIONS);
    expect(mean(timings)).toBeGreaterThanOrEqual(9);
  });

  it(`no more than 5% of valid-path timings below 5ms (setTimeout floor)`, async () => {
    const timings = await collectSamples(validPath, projectRoot, ITERATIONS);
    const belowFloor = timings.filter(t => t < 5).length;
    expect(belowFloor).toBeLessThanOrEqual(ITERATIONS * 0.05);
  });

  it(`no more than 5% of rejected-path timings below 5ms (setTimeout floor)`, async () => {
    const timings = await collectSamples(rejectedPath, projectRoot, ITERATIONS);
    const belowFloor = timings.filter(t => t < 5).length;
    expect(belowFloor).toBeLessThanOrEqual(ITERATIONS * 0.05);
  });

  it('mean timing difference between valid and rejected paths < 0.5ms', async () => {
    const validTimings = await collectSamples(validPath, projectRoot, ITERATIONS);
    const rejectedTimings = await collectSamples(rejectedPath, projectRoot, ITERATIONS);

    const diff = Math.abs(mean(validTimings) - mean(rejectedTimings));
    expect(diff).toBeLessThan(0.5);
  });

  it('timing distributions overlap: valid median within rejected IQR', async () => {
    const validTimings = await collectSamples(validPath, projectRoot, ITERATIONS);
    const rejectedTimings = await collectSamples(rejectedPath, projectRoot, ITERATIONS);

    const sortedRejected = [...rejectedTimings].sort((a, b) => a - b);
    const q1 = sortedRejected[Math.floor(ITERATIONS * 0.25)];
    const q3 = sortedRejected[Math.floor(ITERATIONS * 0.75)];

    const validMedian = [...validTimings].sort((a, b) => a - b)[Math.floor(ITERATIONS * 0.5)];

    // Valid median should fall within rejected IQR if distributions overlap
    expect(validMedian).toBeGreaterThanOrEqual(q1 - 2); // 2ms tolerance for jitter
    expect(validMedian).toBeLessThanOrEqual(q3 + 2);
  });
});
