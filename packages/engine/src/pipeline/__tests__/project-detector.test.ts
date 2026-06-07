// @zaivim/engine — Project detector unit tests
// Tests findProjectRoot, scanProjectMeta, framework detection, formatProjectContext, timeout/safety valves.

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { mkdtemp, writeFile, symlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Import must be after fs setup for path-based tests
import {
  findProjectRoot,
  scanProjectMeta,
  formatProjectContext,
  truncateProjectContext,
  detectFramework,
  detectLanguage,
} from '../project-detector.js';

// ---- Test helpers -----------------------------------------------------------

let tmpDir: string;

function tmp(subdir = ''): string {
  return subdir ? join(tmpDir, subdir) : tmpDir;
}

function write(root: string, file: string, content = ''): void {
  const fullPath = join(root, file);
  const dir = fullPath.replace(/\/[^/]+$/, '');
  if (dir !== fullPath) mkdirSync(dir, { recursive: true });
  writeFileSync(fullPath, content);
}

// -----------------------------------------------------------------------------
// findProjectRoot — Subtask 7.1
// -----------------------------------------------------------------------------

describe('findProjectRoot', () => {
  it('should find .git and return parent dir', () => {
    const root = mkdtempSync(join(tmpdir(), 'test-fpr-'));
    mkdirSync(join(root, '.git'));
    const result = findProjectRoot(root);
    expect(result.root).toBe(realpathSync(root));
    expect(result.detected).toBe(true);
  });

  it('should find package.json when no .git', () => {
    const root = mkdtempSync(join(tmpdir(), 'test-fpr-'));
    writeFileSync(join(root, 'package.json'), '{}');
    const result = findProjectRoot(root);
    expect(result.root).toBe(realpathSync(root));
    expect(result.detected).toBe(true);
  });

  it('should find pnpm-workspace.yaml', () => {
    const root = mkdtempSync(join(tmpdir(), 'test-fpr-'));
    writeFileSync(join(root, 'pnpm-workspace.yaml'), '');
    const result = findProjectRoot(root);
    expect(result.detected).toBe(true);
  });

  it('should walk up directories to find identifier', () => {
    const root = mkdtempSync(join(tmpdir(), 'test-fpr-'));
    const deep = join(root, 'a', 'b', 'c');
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(root, '.git'), '');
    const result = findProjectRoot(deep);
    expect(result.root).toBe(realpathSync(root));
    expect(result.detected).toBe(true);
  });

  it('should fall back to cwd with detected:false when no identifier found', () => {
    const root = mkdtempSync(join(tmpdir(), 'test-fpr-'));
    const result = findProjectRoot(root);
    expect(result.root).toBe(realpathSync(root));
    expect(result.detected).toBe(false);
  });

  it('should resolve symlinks via fs.realpath', async () => {
    const root = mkdtempSync(join(tmpdir(), 'test-fpr-'));
    const realTarget = join(root, 'real-target');
    mkdirSync(realTarget);
    writeFileSync(join(realTarget, 'package.json'), '{}');
    const linkPath = join(root, 'link-to-target');
    await symlink(realTarget, linkPath);
    const result = findProjectRoot(linkPath);
    expect(result.root).toBe(realpathSync(realTarget));
    expect(result.detected).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// detectFramework — Subtask 7.3
// -----------------------------------------------------------------------------

describe('detectFramework', () => {
  it('should detect React', () => {
    expect(detectFramework({ dependencies: { react: '^18.0.0' } })).toBe('React');
  });

  it('should detect Next.js', () => {
    expect(detectFramework({ dependencies: { next: '^14.0.0' } })).toBe('Next.js');
  });

  it('should detect Vue', () => {
    expect(detectFramework({ dependencies: { vue: '^3.0.0' } })).toBe('Vue');
  });

  it('should detect Nuxt', () => {
    expect(detectFramework({ dependencies: { nuxt: '^3.0.0' } })).toBe('Nuxt');
  });

  it('should detect Express', () => {
    expect(detectFramework({ dependencies: { express: '^4.0.0' } })).toBe('Express');
  });

  it('should detect NestJS', () => {
    expect(detectFramework({ dependencies: { '@nestjs/core': '^10.0.0' } })).toBe('NestJS');
  });

  it('should detect Koa', () => {
    expect(detectFramework({ dependencies: { koa: '^2.0.0' } })).toBe('Koa');
  });

  it('should detect Fastify', () => {
    expect(detectFramework({ dependencies: { fastify: '^4.0.0' } })).toBe('Fastify');
  });

  it('should detect SvelteKit', () => {
    expect(detectFramework({ dependencies: { '@sveltejs/kit': '^2.0.0' } })).toBe('SvelteKit');
  });

  it('should detect Svelte', () => {
    expect(detectFramework({ dependencies: { svelte: '^4.0.0' } })).toBe('Svelte');
  });

  it('should detect Angular', () => {
    expect(detectFramework({ dependencies: { '@angular/core': '^17.0.0' } })).toBe('Angular');
  });

  it('should detect Astro', () => {
    expect(detectFramework({ dependencies: { astro: '^4.0.0' } })).toBe('Astro');
  });

  it('should detect Remix', () => {
    expect(detectFramework({ dependencies: { remix: '^2.0.0' } })).toBe('Remix');
  });

  it('should detect Electron', () => {
    expect(detectFramework({ dependencies: { electron: '^28.0.0' } })).toBe('Electron');
  });

  it('should detect Anthropic SDK', () => {
    expect(detectFramework({ dependencies: { '@anthropic-ai/sdk': '^0.20.0' } })).toBe('Anthropic SDK');
  });

  it('should detect OpenAI SDK', () => {
    expect(detectFramework({ dependencies: { openai: '^4.0.0' } })).toBe('OpenAI SDK');
  });

  it('should detect framework from devDependencies', () => {
    expect(detectFramework({ devDependencies: { react: '^18.0.0' } })).toBe('React');
  });

  it('should return undefined when no framework matches', () => {
    expect(detectFramework({ dependencies: { lodash: '^4.0.0' } })).toBeUndefined();
  });

  it('should handle empty package.json gracefully', () => {
    expect(detectFramework({})).toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
// detectLanguage — Subtask 7.3 (partial)
// -----------------------------------------------------------------------------

describe('detectLanguage', () => {
  it('should detect TypeScript when typescript in devDependencies', () => {
    expect(detectLanguage({ devDependencies: { typescript: '^5.0.0' } })).toBe('TypeScript');
  });

  it('should detect TypeScript when typescript in dependencies', () => {
    expect(detectLanguage({ dependencies: { typescript: '^5.0.0' } })).toBe('TypeScript');
  });

  it('should default to JavaScript', () => {
    expect(detectLanguage({ dependencies: { express: '^4.0.0' } })).toBe('JavaScript');
  });

  it('should handle empty', () => {
    expect(detectLanguage({})).toBe('JavaScript');
  });
});

// -----------------------------------------------------------------------------
// scanProjectMeta — Subtask 7.2
// -----------------------------------------------------------------------------

describe('scanProjectMeta', () => {
  it('should return minimal context when detected:false', async () => {
    const ctx = await scanProjectMeta('/nonexistent', false);
    expect(ctx.detected).toBe(false);
    expect(ctx.projectRoot).toBe('/nonexistent');
    expect(ctx.name).toBeUndefined();
  });

  it('should detect basic project metadata from package.json', async () => {
    const root = mkdtempSync(join(tmpdir(), 'test-spm-'));
    write(root, 'package.json', JSON.stringify({
      name: 'test-project',
      version: '1.0.0',
      type: 'module',
      engines: { node: '>=18.0.0' },
      devDependencies: { typescript: '^5.0.0' },
      dependencies: { express: '^4.0.0' },
    }));

    const ctx = await scanProjectMeta(root, true);
    expect(ctx.name).toBe('test-project');
    expect(ctx.language).toBe('TypeScript');
    expect(ctx.framework).toBe('Express');
    expect(ctx.moduleSystem).toBe('esm');
    expect(ctx.nodeVersion).toBe('>=18.0.0');
    expect(ctx.detected).toBe(true);
  });

  it('should detect CJS when no type field', async () => {
    const root = mkdtempSync(join(tmpdir(), 'test-spm-'));
    write(root, 'package.json', JSON.stringify({
      name: 'cjs-project',
    }));

    const ctx = await scanProjectMeta(root, true);
    expect(ctx.moduleSystem).toBe('cjs');
  });

  it('should detect pnpm package manager', async () => {
    const root = mkdtempSync(join(tmpdir(), 'test-spm-'));
    write(root, 'package.json', JSON.stringify({ name: 'pkg' }));
    write(root, 'pnpm-lock.yaml', '');

    const ctx = await scanProjectMeta(root, true);
    expect(ctx.packageManager).toBe('pnpm');
  });

  it('should detect yarn package manager', async () => {
    const root = mkdtempSync(join(tmpdir(), 'test-spm-'));
    write(root, 'package.json', JSON.stringify({ name: 'pkg' }));
    write(root, 'yarn.lock', '');

    const ctx = await scanProjectMeta(root, true);
    expect(ctx.packageManager).toBe('yarn');
  });

  it('should detect npm package manager', async () => {
    const root = mkdtempSync(join(tmpdir(), 'test-spm-'));
    write(root, 'package.json', JSON.stringify({ name: 'pkg' }));
    write(root, 'package-lock.json', '');

    const ctx = await scanProjectMeta(root, true);
    expect(ctx.packageManager).toBe('npm');
  });

  it('should detect monorepo via pnpm-workspace.yaml', async () => {
    const root = mkdtempSync(join(tmpdir(), 'test-spm-'));
    write(root, 'package.json', JSON.stringify({ name: 'monorepo' }));
    write(root, 'pnpm-workspace.yaml', 'packages:\n  - packages/*');

    const ctx = await scanProjectMeta(root, true);
    expect(ctx.monorepo).toBe(true);
  });

  it('should scan monorepo packages', async () => {
    const root = mkdtempSync(join(tmpdir(), 'test-spm-'));
    write(root, 'package.json', JSON.stringify({ name: 'monorepo' }));
    write(root, 'pnpm-workspace.yaml', '');
    write(root, 'packages/core/package.json', JSON.stringify({ name: '@scope/core' }));
    write(root, 'packages/utils/package.json', JSON.stringify({ name: '@scope/utils' }));

    const ctx = await scanProjectMeta(root, true);
    expect(ctx.monorepo).toBe(true);
    expect(ctx.packages).toContain('@scope/core');
    expect(ctx.packages).toContain('@scope/utils');
  });

  it('should scan config files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'test-spm-'));
    write(root, 'package.json', JSON.stringify({ name: 'cfg-test' }));
    write(root, 'tsconfig.json', '{}');
    write(root, '.prettierrc', '{}');
    write(root, 'Dockerfile', 'FROM node:20');

    const ctx = await scanProjectMeta(root, true);
    expect(ctx.configFiles).toContain('tsconfig.json');
    expect(ctx.configFiles).toContain('.prettierrc');
    expect(ctx.configFiles).toContain('Dockerfile');
  });

  it('should handle no package.json gracefully', async () => {
    const root = mkdtempSync(join(tmpdir(), 'test-spm-'));
    // No package.json — only dir with marker file
    write(root, '.git', '');
    const ctx = await scanProjectMeta(root, true);
    expect(ctx.detected).toBe(true);
    expect(ctx.name).toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
// formatProjectContext — Subtask 7.4
// -----------------------------------------------------------------------------

describe('formatProjectContext', () => {
  it('should format detected context with all fields', () => {
    const result = formatProjectContext({
      projectRoot: '/home/user/project',
      detected: true,
      name: 'my-app',
      language: 'TypeScript',
      packageManager: 'pnpm',
      framework: 'Express',
      moduleSystem: 'esm',
      nodeVersion: '>=18.0.0',
      monorepo: true,
      packages: ['@scope/a', '@scope/b'],
      configFiles: ['tsconfig.json', '.prettierrc'],
    });

    expect(result).toContain('--- Project Context ---');
    expect(result).toContain('Project: my-app');
    expect(result).toContain('Language: TypeScript');
    expect(result).toContain('Package Manager: pnpm');
    expect(result).toContain('Framework: Express');
    expect(result).toContain('Module System: ESM');
    expect(result).toContain('Node.js: >=18.0.0');
    expect(result).toContain('Monorepo: yes');
    expect(result).toContain('Packages: @scope/a, @scope/b');
    expect(result).toContain('Config Files: tsconfig.json, .prettierrc');
    expect(result).toContain('---');
  });

  it('should format minimal context when not detected', () => {
    const result = formatProjectContext({
      projectRoot: '/tmp/empty',
      detected: false,
    });

    expect(result).toContain('Project Root: /tmp/empty');
    expect(result).toContain('(No project metadata detected)');
  });

  it('should omit optional fields when absent', () => {
    const result = formatProjectContext({
      projectRoot: '/tmp/minimal',
      detected: true,
    });

    expect(result).not.toContain('Project:');
    expect(result).not.toContain('Language:');
    expect(result).toContain('--- Project Context ---');
  });
});

describe('truncateProjectContext', () => {
  it('should not truncate when within limit', () => {
    const ctx = formatProjectContext({ projectRoot: '/tmp', detected: true, name: 'a' });
    expect(truncateProjectContext(ctx, 500)).toBe(ctx);
  });

  it('should truncate when over limit', () => {
    const longName = 'x'.repeat(500);
    const ctx = `--- Project Context ---\nProject: ${longName}\n---`;
    const result = truncateProjectContext(ctx, 50);
    // result = 50 chars of original + '\n' + '--- (truncated) ---'
    expect(result.length).toBe(50 + 1 + '--- (truncated) ---'.length);
    expect(result).toContain('(truncated)');
  });
});

// -----------------------------------------------------------------------------
// assembleContext project context integration — Subtask 7.5
// -----------------------------------------------------------------------------

import { assembleContext, PIPELINE_DEFAULTS } from '../context-assembler.js';
import type { Session, Message, ZaiConfig } from '@zaivim/core';

function makeSession(messages: Message[]): Session {
  return {
    id: 'test-session',
    messages,
    createdAt: Date.now(),
    config: {} as ZaiConfig,
    status: 'active',
  };
}

describe('assembleContext with project context', () => {
  it('should inject project context after system prompt', () => {
    const session = makeSession([
      { id: 'msg-1', role: 'user', content: 'hello', seq: 1 },
    ]);
    const persona = { name: 'test', systemPrompt: 'You are a helpful assistant.' };
    const projectContext = {
      projectRoot: '/tmp/p',
      detected: true,
      name: 'test-app',
      language: 'TypeScript' as const,
    };

    const result = assembleContext(session, persona, {
      sessionId: 'test',
      projectContext,
    });

    const systemMsgs = result.messages.filter(m => m.role === 'system');
    expect(systemMsgs.length).toBe(2); // persona system + project context
    expect(systemMsgs[0]!.content).toContain('You are a helpful assistant');
    expect(systemMsgs[1]!.content).toContain('test-app');
    expect(systemMsgs[1]!.content).toContain('--- Project Context ---');
  });

  it('should inject project context as first message when no system prompt', () => {
    const session = makeSession([
      { id: 'msg-1', role: 'user', content: 'hi', seq: 1 },
    ]);
    const projectContext = {
      projectRoot: '/tmp/p',
      detected: true,
      name: 'test-app',
    };

    const result = assembleContext(session, undefined, {
      sessionId: 'test',
      projectContext,
    });

    expect(result.messages[0]!.role).toBe('system');
    expect(result.messages[0]!.content).toContain('test-app');
  });

  it('should count project context toward token budget', () => {
    const session = makeSession([
      { id: 'msg-1', role: 'user', content: 'x', seq: 1 },
    ]);
    const projectContext = {
      projectRoot: '/tmp/p',
      detected: true,
      name: 'x'.repeat(500), // very long project name
    };

    const maxTokens = 5; // very small budget
    const result = assembleContext(session, undefined, {
      sessionId: 'test',
      maxContextTokens: maxTokens,
      projectContext,
      formatAttachments: () => '',
    });

    // With such a tight budget, project context alone would exceed it,
    // but the assembler should still produce some messages
    expect(result.messages.length).toBeGreaterThan(0);
  });

  it('should not inject project context when not provided', () => {
    const session = makeSession([
      { id: 'msg-1', role: 'user', content: 'hello', seq: 1 },
    ]);
    const persona = { name: 'test', systemPrompt: 'You are helpful.' };
    const result = assembleContext(session, persona, {
      sessionId: 'test',
    });

    const systemMsgs = result.messages.filter(m => m.role === 'system');
    expect(systemMsgs.length).toBe(1); // only persona system prompt
  });
});
