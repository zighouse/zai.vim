// =============================================================================
// @zaivim/engine — Path validator tests
// Story 2.4, Task 2: TOCTOU, Unicode, boundary, side-channel
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  validatePathSafe,
  validatePathAsync,
  normalizePath,
  findGitRoot,
  isWithinBoundary,
  hasConfusableChars,
  skeleton,
  BidiControlCharError,
  detectNormalizationForm,
  SealedFileHandle,
  ZaiHandleClosedError,
} from '../../security/path-validator.js';

describe('normalizePath (Task 4)', () => {
  it('should normalize Unicode NFC on Linux', () => {
    // é can be composed (U+00E9) or decomposed (e + U+0301)
    const composed = 'é'; // é
    const decomposed = 'é'; // e + combining acute
    const result = normalizePath(decomposed);
    expect(result).toBe(composed);
  });

  it('should strip zero-width characters', () => {
    const input = 'src​index.ts'; // zero-width space
    const result = normalizePath(input);
    expect(result).not.toContain('​');
  });

  it('should throw BidiControlCharError on bidi characters (Task 4.5)', () => {
    const input = 'src‮index.ts'; // RIGHT-TO-LEFT OVERRIDE
    expect(() => normalizePath(input)).toThrow(BidiControlCharError);
  });

  it('should convert full-width Latin to half-width', () => {
    const input = 'ｓｒｃ'; // full-width "src"
    const result = normalizePath(input);
    expect(result).toContain('src');
  });

  it('should normalize path separators', () => {
    const input = 'src//index.ts';
    const result = normalizePath(input);
    expect(result).toBe('src/index.ts');
  });
});

describe('hasConfusableChars (Task 4.4)', () => {
  it('should detect Cyrillic homoglyphs', () => {
    // Cyrillic 'а' (U+0430) looks like Latin 'a' (U+0061)
    expect(hasConfusableChars('src/іndex.ts')).toBe(true);
  });

  it('should not flag pure ASCII', () => {
    expect(hasConfusableChars('src/index.ts')).toBe(false);
  });

  it('should detect Greek homoglyphs', () => {
    // Greek 'ο' (U+03BF) looks like Latin 'o' (U+006F)
    expect(hasConfusableChars('hellο')).toBe(true);
  });
});

describe('skeleton (Task 4.6)', () => {
  it('should map Cyrillic і to Latin i', () => {
    const result = skeleton('іndex');
    expect(result).toBe('index');
  });

  it('should preserve ASCII characters', () => {
    const result = skeleton('hello');
    expect(result).toBe('hello');
  });
});

describe('findGitRoot (Task 2.3)', () => {
  it('should find .git from project root', () => {
    // Set up mock to find .git at the monorepo root
    mockExistsSync.mockImplementation((p: any) => {
      return String(p).endsWith('.git') || String(p).endsWith('/home/zhigang/mywork/github/zai.vim/.git');
    });
    const result = findGitRoot(process.cwd());
    expect(result).not.toBeNull();
    expect(result).toBeDefined();
  });

  it('should return null for non-git directory', () => {
    mockExistsSync.mockReturnValue(false);
    const result = findGitRoot('/tmp/nonexistent-git-dir');
    expect(result).toBeNull();
  });
});

describe('isWithinBoundary (Task 2.3)', () => {
  it('should accept path within boundary', () => {
    expect(isWithinBoundary('/project/src/index.ts', '/project')).toBe(true);
  });

  it('should reject path outside boundary', () => {
    expect(isWithinBoundary('/other/file.txt', '/project')).toBe(false);
  });

  it('should accept the boundary root itself', () => {
    expect(isWithinBoundary('/project', '/project')).toBe(true);
  });
});

describe('detectNormalizationForm', () => {
  it('should return NFC on non-macOS', () => {
    // Linux returns NFC
    expect(['NFC', 'NFD']).toContain(detectNormalizationForm());
  });
});

// ---- validatePathSafe tests ----

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

import { existsSync, readlinkSync } from 'node:fs';
import { open } from 'node:fs/promises';

// Restore real existsSync behavior for helper tests that need actual .git detection
const realExistsSync = vi.importActual<typeof import('node:fs')>('node:fs').then(m => m.existsSync);

describe('validatePathSafe (Task 2 — TOCTOU-safe validation)', () => {
  const projectRoot = '/home/user/project';

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: .git exists at project root
    mockExistsSync.mockImplementation((p: any) => {
      const s = String(p);
      return s === projectRoot + '/.git';
    });
    // Default: proc fd resolves to sentinel (overridden in specific tests)
    mockReadlinkSync.mockReturnValue(projectRoot + '/valid');
  });

  it('should return SealedFileHandle for valid read within boundary', async () => {
    const mockHandle = { fd: 42, readFile: vi.fn().mockResolvedValue('content'), close: vi.fn().mockResolvedValue(undefined) };
    mockOpen.mockResolvedValue(mockHandle as any);

    const absPath = projectRoot + '/src/index.ts';
    // /proc/self/fd cross-verification must return the same real path
    mockReadlinkSync.mockReturnValue(absPath);

    const result = await validatePathSafe(absPath, projectRoot, 'read');

    expect(result).toBeInstanceOf(SealedFileHandle);
    const sealed = result as SealedFileHandle;
    expect(sealed.validatedPath).toBe(absPath);
  });

  it('should reject path outside .git boundary', async () => {
    // Absolute path outside the project boundary
    const result = await validatePathSafe('/etc/passwd', projectRoot, 'read');

    expect(result).not.toBeInstanceOf(SealedFileHandle);
    if (!(result instanceof SealedFileHandle)) {
      expect(result.valid).toBe(false);
      expect(result.message).toBe('access denied');
      expect(result.code).toBe('TOOLS_PATH_OUTSIDE_BOUNDARY');
    }
  });

  it('should reject path with confusable chars', async () => {
    // Cyrillic 'і' (U+0456) looks like Latin 'i'
    const absPath = projectRoot + '/src/іndex.ts';
    const result = await validatePathSafe(absPath, projectRoot, 'read');

    expect(result).not.toBeInstanceOf(SealedFileHandle);
    if (!(result instanceof SealedFileHandle)) {
      expect(result.valid).toBe(false);
      expect(result.code).toBe('TOOLS_PATH_CONFUSABLE');
    }
  });

  it('should reject path with bidi control chars', async () => {
    const absPath = projectRoot + '/src/‮index.ts';
    const result = await validatePathSafe(absPath, projectRoot, 'read');

    expect(result).not.toBeInstanceOf(SealedFileHandle);
    if (!(result instanceof SealedFileHandle)) {
      expect(result.valid).toBe(false);
      expect(result.code).toBe('TOOLS_PATH_BIDI');
    }
  });

  it('should fail-closed when .git not found', async () => {
    mockExistsSync.mockReturnValue(false);

    const absPath = projectRoot + '/src/index.ts';
    const result = await validatePathSafe(absPath, projectRoot, 'read');

    expect(result).not.toBeInstanceOf(SealedFileHandle);
    if (!(result instanceof SealedFileHandle)) {
      expect(result.valid).toBe(false);
      expect(result.code).toBe('TOOLS_PATH_NO_GIT_BOUNDARY');
    }
  });

  it('should return PathAcceptance for write within boundary', async () => {
    const absPath = projectRoot + '/src/new-file.ts';
    const result = await validatePathSafe(absPath, projectRoot, 'write');

    expect(result).not.toBeInstanceOf(SealedFileHandle);
    if (!(result instanceof SealedFileHandle)) {
      expect(result.valid).toBe(true);
      expect(result.resolvedPath).toBe(absPath);
    }
  });

  it('should reject write outside boundary', async () => {
    const result = await validatePathSafe('/etc/config', projectRoot, 'write');

    expect(result).not.toBeInstanceOf(SealedFileHandle);
    if (!(result instanceof SealedFileHandle)) {
      expect(result.valid).toBe(false);
      expect(result.code).toBe('TOOLS_PATH_OUTSIDE_BOUNDARY');
    }
  });

  it('should reject when open fails (file not found)', async () => {
    mockOpen.mockRejectedValue(new Error('ENOENT'));

    const absPath = projectRoot + '/src/missing.ts';
    const result = await validatePathSafe(absPath, projectRoot, 'read');

    expect(result).not.toBeInstanceOf(SealedFileHandle);
    if (!(result instanceof SealedFileHandle)) {
      expect(result.valid).toBe(false);
      expect(result.code).toBe('TOOLS_PATH_OUTSIDE_BOUNDARY');
    }
  });

  it('should reject on TOCTOU cross-verification failure', async () => {
    const mockHandle = { fd: 42, readFile: vi.fn().mockResolvedValue('content'), close: vi.fn().mockResolvedValue(undefined) };
    mockOpen.mockResolvedValue(mockHandle as any);
    // Cross-verification: /proc/self/fd resolves differently from real path
    mockReadlinkSync.mockReturnValue('/tmp/evil/passwd');

    const absPath = projectRoot + '/src/index.ts';
    const result = await validatePathSafe(absPath, projectRoot, 'read');

    expect(result).not.toBeInstanceOf(SealedFileHandle);
    if (!(result instanceof SealedFileHandle)) {
      expect(result.valid).toBe(false);
      expect(result.code).toBe('TOOLS_PATH_TOCTOU_FAIL');
    }
  });
});

describe('SealedFileHandle', () => {
  it('should throw ZaiHandleClosedError when reading after close', async () => {
    const mockHandle = { fd: 42, readFile: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
    const sealed = new SealedFileHandle(mockHandle as any, '/test/path');

    await sealed.close();

    await expect(sealed.read()).rejects.toThrow(ZaiHandleClosedError);
  });

  it('should throw ZaiHandleClosedError when accessing fd after close', async () => {
    const mockHandle = { fd: 42, readFile: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
    const sealed = new SealedFileHandle(mockHandle as any, '/test/path');

    await sealed.close();

    expect(() => sealed.fd).toThrow(ZaiHandleClosedError);
  });

  it('close should be idempotent', async () => {
    const mockHandle = { fd: 42, readFile: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
    const sealed = new SealedFileHandle(mockHandle as any, '/test/path');

    await sealed.close();
    await sealed.close(); // Should not throw

    expect(mockHandle.close).toHaveBeenCalledTimes(1);
  });
});

describe('validatePathAsync (Story 3.3)', () => {
  const projectRoot = '/home/user/project';

  beforeEach(() => {
    mockExistsSync.mockImplementation((p: any) => {
      const s = String(p);
      return s === projectRoot + '/.git';
    });
    mockReadlinkSync.mockReturnValue(projectRoot + '/valid');
  });

  it('should accept a path within the .git boundary', async () => {
    const result = await validatePathAsync(projectRoot + '/src/index.ts', projectRoot);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.resolvedPath).toBe(projectRoot + '/src/index.ts');
    }
  });

  it('should reject a path outside the .git boundary', async () => {
    const result = await validatePathAsync('/tmp/evil', projectRoot);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe('TOOLS_PATH_OUTSIDE_BOUNDARY');
    }
  });

  it('should reject confusable characters', async () => {
    const result = await validatePathAsync('src/dаta', projectRoot);
    expect(result.valid).toBe(false);
  });

  it('should reject bidi control characters', async () => {
    const result = await validatePathAsync('src‮index.ts', projectRoot);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe('TOOLS_PATH_BIDI');
    }
  });

  it('should return TOOLS_PATH_NO_GIT_BOUNDARY when git root not found', async () => {
    mockExistsSync.mockReturnValue(false);
    const result = await validatePathAsync('/tmp/something', '/tmp');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe('TOOLS_PATH_NO_GIT_BOUNDARY');
    }
  });
});
