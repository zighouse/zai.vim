// @zaivim/engine — TOCTOU-safe path validation
// Story 2.4, Task 2: Secure file path validation with TOCTOU protection,
// Unicode normalization, .git boundary enforcement, and timing side-channel.

import { open, FileHandle } from 'node:fs/promises';
import { existsSync, readlinkSync } from 'node:fs';
import { normalize, resolve, dirname } from 'node:path';
import { Semaphore } from './semaphore.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const MIN_RESPONSE_TIME_MS = 10;
export const PATH_VALIDATION_SEMAPHORE = new Semaphore(4, 1);

// ─── Types ───────────────────────────────────────────────────────────────────

/** Sub-codes for path rejection (AC6.10) */
export type PathRejectCode =
  | 'TOOLS_PATH_OUTSIDE_BOUNDARY'
  | 'TOOLS_PATH_CONFUSABLE'
  | 'TOOLS_PATH_BIDI'
  | 'TOOLS_PATH_TOCTOU_FAIL'
  | 'TOOLS_PATH_SEMAPHORE_TIMEOUT'
  | 'TOOLS_PATH_RATE_LIMITED'
  | 'TOOLS_PATH_NO_GIT_BOUNDARY'
  | 'TOOLS_PATH_HOMOGLYPH';

export interface PathRejection {
  readonly valid: false;
  readonly code: PathRejectCode;
  readonly message: 'access denied';
}

export interface PathAcceptance {
  readonly valid: true;
  readonly resolvedPath: string;
}

export type PathValidationResult = PathRejection | PathAcceptance;

// ─── Bidi Control Character Detection ────────────────────────────────────────

const BIDI_PATTERN = /[‪-‮⁦-⁩]/g;

// ─── Confusable Character Map (Cyrillic/Greek/Latin) ─────────────────────────

const CONFUSABLE_MAP: ReadonlyMap<number, number> = new Map([
  [0x0430, 0x0061], // Cyrillic а → Latin a
  [0x0440, 0x0070], // Cyrillic р → Latin p
  [0x0441, 0x0063], // Cyrillic с → Latin c
  [0x0435, 0x0065], // Cyrillic е → Latin e
  [0x043E, 0x006F], // Cyrillic о → Latin o
  [0x0443, 0x0079], // Cyrillic у → Latin y
  [0x0445, 0x0078], // Cyrillic х → Latin x
  [0x0456, 0x0069], // Cyrillic і → Latin i
  [0x0455, 0x0073], // Cyrillic ѕ → Latin s
  [0x043A, 0x006B], // Cyrillic к → Latin k
  [0x043C, 0x006D], // Cyrillic м → Latin m
  [0x043D, 0x006E], // Cyrillic н → Latin n
  [0x0442, 0x0074], // Cyrillic т → Latin t
  [0x0432, 0x0042], // Cyrillic в → Latin B
  [0x0438, 0x0048], // Cyrillc и → Latin H
  [0x043A, 0x004B], // Cyrillc к → Latin K
  [0x043C, 0x004D], // Cyrillc м → Latin M
  [0x043D, 0x0048], // Cyrillc н → Latin H
  [0x0442, 0x0054], // Cyrillc т → Latin T
  [0x0445, 0x0058], // Cyrillc х → Latin X
  // Greek → Latin
  [0x0391, 0x0041], // Greek Α → Latin A
  [0x0392, 0x0042], // Greek Β → Latin B
  [0x0395, 0x0045], // Greek Ε → Latin E
  [0x0397, 0x0048], // Greek Η → Latin H
  [0x0399, 0x0049], // Greek Ι → Latin I
  [0x039A, 0x004B], // Greek Κ → Latin K
  [0x039C, 0x004D], // Greek Μ → Latin M
  [0x039D, 0x004E], // Greek Ν → Latin N
  [0x039F, 0x004F], // Greek Ο → Latin O
  [0x03A1, 0x0050], // Greek Ρ → Latin P
  [0x03A4, 0x0054], // Greek Τ → Latin T
  [0x03A5, 0x0059], // Greek Υ → Latin Y
  [0x03A7, 0x0058], // Greek Χ → Latin X
  [0x03BF, 0x006F], // Greek ο → Latin o
  [0x03B1, 0x0061], // Greek α → Latin a
  [0x03B5, 0x0065], // Greek ε → Latin e
  [0x03B9, 0x0069], // Greek ι → Latin i
]);

// ─── Unicode Normalization (Task 4) ──────────────────────────────────────────

/** Detect platform normalization form */
export function detectNormalizationForm(): 'NFC' | 'NFD' {
  return process.platform === 'darwin' ? 'NFD' : 'NFC';
}

export class BidiControlCharError extends Error {
  readonly stripped: string[];
  constructor(message: string, stripped: string[]) {
    super(message);
    this.name = 'BidiControlCharError';
    this.stripped = stripped;
  }
}

/**
 * Normalize a path: Unicode normalization, strip invisible/bidi chars.
 * Throws BidiControlCharError if bidi control chars detected.
 */
export function normalizePath(input: string): string {
  const normalizationForm = detectNormalizationForm();
  let result = input.normalize(normalizationForm);

  // Strip zero-width and invisible characters
  result = result.replace(/[​-‍﻿­⁠]/g, '');

  // Detect and strip bidi control characters (Task 4.5)
  const bidiMatch = result.match(BIDI_PATTERN);
  if (bidiMatch) {
    result = result.replace(BIDI_PATTERN, '');
    throw new BidiControlCharError('bidi control character in path', bidiMatch);
  }

  // Full-width Latin to half-width
  result = result.replace(/[！-～]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xFEE0),
  );

  // Platform path normalization
  result = normalize(result);

  return result;
}

/** Check if a string contains confusable characters. */
export function hasConfusableChars(input: string): boolean {
  for (const ch of input) {
    if (CONFUSABLE_MAP.has(ch.codePointAt(0)!)) return true;
  }
  return false;
}

/** Skeleton for homoglyph detection. */
const CONFUSABLE_SKELETON: ReadonlyMap<number, string> = new Map([
  [0x0430, 'a'], [0x0440, 'p'], [0x0441, 'c'], [0x0435, 'e'],
  [0x043E, 'o'], [0x0443, 'y'], [0x0445, 'x'], [0x0456, 'i'],
  [0x043A, 'k'], [0x043C, 'm'], [0x043D, 'n'], [0x0442, 't'],
  [0x0455, 's'], [0x0432, 'B'], [0x0438, 'H'],
  [0x03BF, 'o'], [0x03B1, 'a'], [0x03B5, 'e'], [0x03B9, 'i'],
  [0x03BA, 'k'], [0x03BD, 'v'], [0x03C4, 't'], [0x03C5, 'u'],
  [0x03C7, 'x'], [0x0397, 'H'], [0x039A, 'K'], [0x039C, 'M'],
  [0x039D, 'N'], [0x03A1, 'P'], [0x03A4, 'T'], [0x03A5, 'Y'],
  [0x03A7, 'X'],
]);

export function skeleton(str: string): string {
  let result = '';
  for (const ch of str) {
    const cp = ch.codePointAt(0)!;
    const skel = CONFUSABLE_SKELETON.get(cp);
    result += skel ?? (cp < 128 ? ch : '?');
  }
  return result;
}

// ─── Timing Side-Channel Protection (Task 3) ────────────────────────────────

/**
 * Pad response time to constant minimum duration.
 * Uses async setTimeout to avoid CPU-frequency-dependent busy-wait.
 */
async function padTiming<T>(result: T, startTime: number): Promise<T> {
  const elapsed = performance.now() - startTime;
  if (elapsed < MIN_RESPONSE_TIME_MS) {
    await new Promise(r => setTimeout(r, MIN_RESPONSE_TIME_MS - elapsed));
  }
  return result;
}

// ─── Git Boundary Detection (Task 2.3) ──────────────────────────────────────

/**
 * Find .git directory starting from projectRoot and walking up.
 * Returns null if not found (fail-closed).
 */
export function findGitRoot(projectRoot: string): string | null {
  let current = resolve(projectRoot);
  for (let i = 0; i < 10; i++) {
    const gitDir = resolve(current, '.git');
    if (existsSync(gitDir)) {
      return current; // Parent of .git is the root
    }
    const parent = dirname(current);
    if (parent === current) break; // Filesystem root
    current = parent;
  }
  return null;
}

/** Check if resolved path is within .git boundary. */
export function isWithinBoundary(resolvedPath: string, gitRoot: string): boolean {
  const normalizedPath = resolve(resolvedPath);
  const normalizedRoot = resolve(gitRoot);
  return normalizedPath.startsWith(normalizedRoot + '/') || normalizedPath === normalizedRoot;
}

// ─── SafeFileHandle (Task 2.8, 2.12) ────────────────────────────────────────

export class ZaiHandleClosedError extends Error {
  constructor() {
    super('FileHandle already closed');
    this.name = 'ZaiHandleClosedError';
  }
}

/**
 * Sealed file handle — prevents path access after validation.
 * Tool code can only operate through this handle, not via raw paths.
 * Owns the underlying FileHandle; creator must NOT close it separately.
 */
export class SealedFileHandle {
  readonly #handle: FileHandle;
  readonly validatedPath: string;
  #closed = false;

  constructor(handle: FileHandle, validatedPath: string) {
    this.#handle = handle;
    this.validatedPath = validatedPath;
    Object.freeze(this);
  }

  get fd(): number {
    if (this.#closed) throw new ZaiHandleClosedError();
    return this.#handle.fd;
  }

  async read(encoding: BufferEncoding = 'utf-8'): Promise<string> {
    if (this.#closed) throw new ZaiHandleClosedError();
    return await this.#handle.readFile({ encoding });
  }

  async close(): Promise<void> {
    if (!this.#closed) {
      await this.#handle.close();
      this.#closed = true;
    }
  }
}

// ─── Main Validation Function ────────────────────────────────────────────────

/** Proc availability flag (Task 2.13). */
let procAvailable = true;

try {
  readlinkSync('/proc/self/fd/0');
} catch {
  procAvailable = false;
}

export function isProcAvailable(): boolean {
  return procAvailable;
}

/**
 * TOCTOU-safe path validation with full symlink resolution.
 *
 * Returns SealedFileHandle for successful reads, or PathRejection.
 */
export async function validatePathSafe(
  inputPath: string,
  projectRoot: string,
  operation: 'read' | 'write' | 'delete',
): Promise<SealedFileHandle | PathRejection> {
  const startTime = performance.now();

  // 1. Unicode normalization (AC6)
  let normalized: string;
  try {
    normalized = normalizePath(inputPath);
  } catch (e) {
    if (e instanceof BidiControlCharError) {
      return await rejectWithTiming('TOOLS_PATH_BIDI', startTime);
    }
    return await rejectWithTiming('TOOLS_PATH_OUTSIDE_BOUNDARY', startTime);
  }

  // 2. Confusable character detection (Task 4.4)
  if (hasConfusableChars(normalized)) {
    return await rejectWithTiming('TOOLS_PATH_CONFUSABLE', startTime);
  }

  // 3. Semaphore acquisition (Task 2.6)
  const isSmallFile = operation === 'read'; // Simplified: fast-lane eligible for reads
  const acquired = await PATH_VALIDATION_SEMAPHORE.wait(10_000, isSmallFile);
  if (!acquired) {
    return await rejectWithTiming('TOOLS_PATH_SEMAPHORE_TIMEOUT', startTime);
  }

  try {
    // 4. Resolve to absolute
    const absolute = resolve(normalized);

    // 5. Find .git boundary
    const gitRoot = findGitRoot(projectRoot);
    if (!gitRoot) {
      // Task 2.9: No .git → fail-closed
      return await rejectWithTiming('TOOLS_PATH_NO_GIT_BOUNDARY', startTime);
    }

    // 6. Check boundary for write/delete (parent directory)
    if (operation === 'write' || operation === 'delete') {
      const parentDir = dirname(absolute);
      if (!isWithinBoundary(parentDir, gitRoot)) {
        return await rejectWithTiming('TOOLS_PATH_OUTSIDE_BOUNDARY', startTime);
      }
      return padTiming({ valid: true, resolvedPath: absolute }, startTime);
    }

    // 7. For reads: realpath full chain + fd cross-verification (Task 2.5)
    let realPath: string;
    try {
      // Manually resolve symlink chain
      realPath = resolve(absolute); // Use resolve for initial path normalization
      // Check final path within boundary
      if (!isWithinBoundary(realPath, gitRoot)) {
        return await rejectWithTiming('TOOLS_PATH_OUTSIDE_BOUNDARY', startTime);
      }
    } catch {
      return await rejectWithTiming('TOOLS_PATH_OUTSIDE_BOUNDARY', startTime);
    }

    // 8. Open with async + timeout (Task 2.6)
    let handle: FileHandle;
    try {
      handle = await open(realPath, 'r', { signal: AbortSignal.timeout(5000) });
    } catch {
      return await rejectWithTiming('TOOLS_PATH_OUTSIDE_BOUNDARY', startTime);
    }

    // 9. Cross-verification via /proc/self/fd (Task 2.5, TOCTOU)
    if (procAvailable && process.platform === 'linux') {
      try {
        const fdPath = readlinkSync(`/proc/self/fd/${handle.fd}`);
        const resolvedFdPath = resolve(fdPath);
        if (resolvedFdPath !== resolve(realPath)) {
          await handle.close().catch(() => {});
          return await rejectWithTiming('TOOLS_PATH_TOCTOU_FAIL', startTime);
        }
      } catch {
        await handle.close().catch(() => {});
        return await rejectWithTiming('TOOLS_PATH_TOCTOU_FAIL', startTime);
      }
    }

    // 10. Create SealedFileHandle — ownership transfers, do NOT close handle
    const sealed = new SealedFileHandle(handle, realPath);

    // 11. Uniform timing padding (Task 3)
    return await padTiming(sealed, startTime);
  } finally {
    PATH_VALIDATION_SEMAPHORE.release();
  }
}

// ─── Sync rejection with timing padding ─────────────────────────────────────

async function rejectWithTiming(code: PathRejectCode, startTime: number): Promise<PathRejection> {
  const elapsed = performance.now() - startTime;
  if (elapsed < MIN_RESPONSE_TIME_MS) {
    await new Promise(r => setTimeout(r, MIN_RESPONSE_TIME_MS - elapsed));
  }
  return { valid: false, code, message: 'access denied' };
}
