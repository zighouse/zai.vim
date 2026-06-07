// @zaivim/engine — File attachment tests

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { resolveAttachments, formatAttachments } from '../file-attachment.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zai-attach-'));
}

describe('resolveAttachments', () => {
  let dir: string;

  beforeEach(() => { dir = tempDir(); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('reads file content and returns typed attachment', async () => {
    const filePath = path.join(dir, 'test.ts');
    fs.writeFileSync(filePath, 'console.log("hello");');

    const result = await resolveAttachments([filePath], { projectDir: dir });
    expect(result).toHaveLength(1);
    expect(result[0]!.path).toBe(filePath);
    expect(result[0]!.content).toBe('console.log("hello");');
    expect(result[0]!.truncated).toBe(false);
    expect(result[0]!.language).toBe('typescript');
  });

  it('inspects file language from extension', async () => {
    const files = [
      { name: 'test.py', content: 'print(1)', lang: 'python' },
      { name: 'main.js', content: 'const a = 1;', lang: 'javascript' },
      { name: 'test.go', content: 'package main', lang: 'go' },
      { name: 'test.rs', content: 'fn main() {}', lang: 'rust' },
    ];
    for (const f of files) {
      const fp = path.join(dir, f.name);
      fs.writeFileSync(fp, f.content);
    }

    const result = await resolveAttachments(files.map(f => path.join(dir, f.name)), { projectDir: dir });
    for (let i = 0; i < files.length; i++) {
      expect(result[i]!.language).toBe(files[i]!.lang);
    }
  });

  it('truncates content when exceeding maxOutputBytes', async () => {
    const filePath = path.join(dir, 'large.txt');
    const content = 'x'.repeat(200);
    fs.writeFileSync(filePath, content);

    const result = await resolveAttachments([filePath], {
      projectDir: dir,
      maxOutputBytes: 100,
    });
    expect(result[0]!.truncated).toBe(true);
    expect(result[0]!.content.length).toBeLessThan(content.length);
    expect(result[0]!.content).toContain('[truncated]');
  });

  it('rejects file paths outside projectDir', async () => {
    const outerPath = '/etc/passwd';
    await expect(resolveAttachments([outerPath], { projectDir: dir }))
      .rejects.toThrow('outside project directory');
  });

  it('throws on non-existent file', async () => {
    await expect(resolveAttachments([path.join(dir, 'nonexistent.ts')], { projectDir: dir }))
      .rejects.toThrow('Failed to read file');
  });
});

describe('formatAttachments', () => {
  it('returns empty string for empty array', () => {
    expect(formatAttachments([])).toBe('');
  });

  it('formats attachments with language and content', () => {
    const result = formatAttachments([{
      path: '/test/main.ts',
      content: 'const x = 1;',
      truncated: false,
      language: 'typescript',
    }]);
    expect(result).toContain('[Attached file: /test/main.ts]');
    expect(result).toContain('```typescript');
    expect(result).toContain('const x = 1;');
  });

  it('adds truncated tag for truncated files', () => {
    const result = formatAttachments([{
      path: '/test/big.ts',
      content: '...',
      truncated: true,
      language: 'typescript',
    }]);
    expect(result).toContain('[truncated]');
  });
});
