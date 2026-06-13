// Story 3.3, Task 7.3: Tool output JSON roundtrip regression
// Verifies that every builtin tool result shape JSON.stringify/parse deep-equal,
// including edge cases that historically trip JSON serialization (truncation
// flags, large content, nested truncated structures).

import { describe, it, expect } from 'vitest';
import type {
  ShellResult,
  WebFetchResult,
  WebSearchResult,
  SearchResultItem,
} from '@zaivim/core';
import type {
  FileReadResult,
  FileWriteResult,
  FileSearchResult,
  FileChangeProposal,
} from '../file.js';

/** Structural deep-equal over JSON-compatible shapes. */
function jsonDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => jsonDeepEqual(v, (b as unknown[])[i]));
  }
  if (typeof a === 'object') {
    if (typeof b !== 'object' || Array.isArray(b)) return false;
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const aKeys = Object.keys(aObj);
    const bKeys = Object.keys(bObj);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every(
      k => Object.prototype.hasOwnProperty.call(bObj, k) && jsonDeepEqual(aObj[k], bObj[k]),
    );
  }
  return false;
}

/** Asserts that a value survives JSON.stringify → JSON.parse unchanged. */
function expectJsonRoundtrip<T>(label: string, value: T): void {
  const serialized = JSON.stringify(value);
  expect(serialized, `${label}: JSON.stringify should not return undefined`).toBeDefined();
  const roundtripped = JSON.parse(serialized as string);
  expect(
    jsonDeepEqual(value, roundtripped),
    `${label}: value should survive JSON roundtrip`,
  ).toBe(true);
}

describe('Story 3.3 Task 7.3: builtin tool outputs JSON roundtrip', () => {
  describe('file_read', () => {
    it('typical FileReadResult roundtrips', () => {
      const result: FileReadResult = {
        path: '/sandbox/file.txt',
        content: 'hello world\nsecond line',
        size: 23,
        truncated: false,
        lines: 2,
      };
      expectJsonRoundtrip('FileReadResult', result);
    });

    it('truncated FileReadResult roundtrips', () => {
      const result: FileReadResult = {
        path: '/sandbox/large.log',
        content: 'x'.repeat(10_000),
        size: 1_000_000,
        truncated: true,
        lines: 99_999,
      };
      expectJsonRoundtrip('FileReadResult.truncated', result);
    });
  });

  describe('file_write', () => {
    it('FileWriteResult without proposal roundtrips', () => {
      const result: FileWriteResult = {
        path: '/sandbox/out.txt',
        size: 42,
      };
      expectJsonRoundtrip('FileWriteResult', result);
    });

    it('FileWriteResult with FileChangeProposal roundtrips', () => {
      const proposal: FileChangeProposal = {
        originalPath: '/sandbox/out.txt',
        backupPath: '/sandbox/.zaivim/backups/out.txt.bak',
        diff: '--- original\n+++ proposed\n@@ -1 +1 @@\n-old\n+new\n',
        proposedContent: 'new content',
        operation: 'modify',
      };
      const result: FileWriteResult = {
        path: '/sandbox/out.txt',
        proposal,
        size: 11,
      };
      expectJsonRoundtrip('FileWriteResult.proposal', result);
    });
  });

  describe('file_search', () => {
    it('FileSearchResult with matches roundtrips', () => {
      const result: FileSearchResult = {
        matches: [
          { file: '/sandbox/a.ts', line: 12, context: ['const x = 1;'] },
          { file: '/sandbox/b.ts', line: 34, context: ['  return x + 1;', '}'] },
        ],
        totalMatches: 2,
        truncated: false,
        elapsedMs: 42,
      };
      expectJsonRoundtrip('FileSearchResult', result);
    });

    it('truncated FileSearchResult with truncatedMessage roundtrips', () => {
      const result: FileSearchResult = {
        matches: [{ file: '/sandbox/big.ts', line: 1, context: ['x'] }],
        totalMatches: 1500,
        truncated: true,
        truncatedMessage: 'Results capped at 1000 matches; refine your pattern.',
        elapsedMs: 500,
      };
      expectJsonRoundtrip('FileSearchResult.truncated', result);
    });

    it('empty FileSearchResult roundtrips', () => {
      const result: FileSearchResult = {
        matches: [],
        totalMatches: 0,
        truncated: false,
        elapsedMs: 5,
      };
      expectJsonRoundtrip('FileSearchResult.empty', result);
    });
  });

  describe('shell_execute', () => {
    it('typical ShellResult roundtrips', () => {
      const result: ShellResult = {
        exitCode: 0,
        stdout: 'hello\n',
        stderr: '',
        killed: false,
        truncated: { stdout: false, stderr: false },
      };
      expectJsonRoundtrip('ShellResult', result);
    });

    it('ShellResult with nested truncated flags roundtrips', () => {
      const result: ShellResult = {
        exitCode: 137,
        stdout: 'x'.repeat(50_000),
        stderr: 'OOM killed',
        killed: true,
        truncated: { stdout: true, stderr: false },
      };
      expectJsonRoundtrip('ShellResult.truncated', result);
    });

    it('rejected ShellResult roundtrips', () => {
      const result: ShellResult = {
        exitCode: -1,
        stdout: '',
        stderr: '',
        killed: false,
        truncated: { stdout: false, stderr: false },
        rejected: true,
        rejectionReason: 'Command blocked by security policy',
      };
      expectJsonRoundtrip('ShellResult.rejected', result);
    });
  });

  describe('web_fetch', () => {
    it('typical WebFetchResult roundtrips', () => {
      const result: WebFetchResult = {
        url: 'https://example.com/page',
        content: '<html>…</html>',
        contentType: 'text/html; charset=utf-8',
        statusCode: 200,
        truncated: false,
        size: 1024,
        elapsed: 312,
      };
      expectJsonRoundtrip('WebFetchResult', result);
    });

    it('WebFetchResult with large content + truncation roundtrips', () => {
      const result: WebFetchResult = {
        url: 'https://example.com/huge.html',
        content: 'A'.repeat(100_000),
        contentType: 'text/html',
        statusCode: 200,
        truncated: true,
        size: 5_000_000,
        elapsed: 1500,
      };
      expectJsonRoundtrip('WebFetchResult.large', result);
    });

    it('error WebFetchResult with errorCode roundtrips', () => {
      const result: WebFetchResult = {
        url: 'https://example.com/missing',
        content: '',
        contentType: '',
        statusCode: 404,
        truncated: false,
        size: 0,
        elapsed: 89,
        errorCode: 'HTTP_404',
      };
      expectJsonRoundtrip('WebFetchResult.error', result);
    });
  });

  describe('web_search', () => {
    it('typical WebSearchResult roundtrips', () => {
      const items: SearchResultItem[] = [
        { title: 'Example A', url: 'https://a.example', snippet: 'snip A' },
        { title: 'Example B', url: 'https://b.example', snippet: 'snip B' },
      ];
      const result: WebSearchResult = {
        query: 'test query',
        results: items,
        totalResults: 2,
        elapsed: 245,
        truncated: false,
      };
      expectJsonRoundtrip('WebSearchResult', result);
    });

    it('truncated WebSearchResult roundtrips', () => {
      const items: SearchResultItem[] = Array.from({ length: 10 }, (_, i) => ({
        title: `Result ${i}`,
        url: `https://r${i}.example`,
        snippet: `snippet ${i}`,
      }));
      const result: WebSearchResult = {
        query: 'popular query',
        results: items,
        totalResults: 1_000_000,
        elapsed: 1200,
        truncated: true,
      };
      expectJsonRoundtrip('WebSearchResult.truncated', result);
    });

    it('error WebSearchResult with errorCode roundtrips', () => {
      const result: WebSearchResult = {
        query: 'failed query',
        results: [],
        totalResults: 0,
        elapsed: 100,
        truncated: false,
        errorCode: 'PROVIDER_TIMEOUT',
      };
      expectJsonRoundtrip('WebSearchResult.error', result);
    });
  });
});
