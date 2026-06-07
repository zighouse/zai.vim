// @zaivim/engine — Project context detection
// Auto-detects project root, metadata, and structure for context injection.
// Zero external dependencies — uses only Node.js built-in fs + path.

import { existsSync, realpathSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { access, readdir, readFile, stat } from 'node:fs/promises';
import { join, basename, relative } from 'node:path';
import type { ProjectContext, PackageManager } from '@zaivim/core';

// ---- Constants ---------------------------------------------------------------

const IDENTIFIER_FILES = ['.git', 'package.json', 'pnpm-workspace.yaml', 'tsconfig.json', '.editorconfig'] as const;

const FRAMEWORK_MAP: ReadonlyArray<[string, string]> = [
  ['next', 'Next.js'],
  ['nuxt', 'Nuxt'],
  ['react', 'React'],
  ['vue', 'Vue'],
  ['@nestjs/core', 'NestJS'],
  ['express', 'Express'],
  ['koa', 'Koa'],
  ['fastify', 'Fastify'],
  ['@sveltejs/kit', 'SvelteKit'],
  ['svelte', 'Svelte'],
  ['@angular/core', 'Angular'],
  ['astro', 'Astro'],
  ['remix', 'Remix'],
  ['@remix-run/react', 'Remix'],
  ['electron', 'Electron'],
  ['@anthropic-ai/sdk', 'Anthropic SDK'],
  ['openai', 'OpenAI SDK'],
];

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.zaivim', '_bmad-output', '.codegraph']);
const SCAN_FILE_LIMIT = 50;
const SCAN_TIMEOUT_MS = 500;
export const MAX_PROJECT_CONTEXT_CHARS = 2000;

// ---- findProjectRoot --------------------------------------------------------
// AC1: Auto-detect project root by walking up from cwd.

export interface ProjectRootResult {
  readonly root: string;
  readonly detected: boolean;
}

export function findProjectRoot(cwd?: string): ProjectRootResult {
  const start = cwd ?? process.cwd();
  let current = start;

  while (true) {
    for (const id of IDENTIFIER_FILES) {
      const candidate = join(current, id);
      try {
        if (existsSync(candidate)) {
          // Resolve symlinks so project root is always a real path (ADR-17)
          const real = realpathSync(current);
          return { root: real, detected: true };
        }
      } catch {
        // realpath can throw on permission errors — fall through to next file
      }
    }

    const parent = join(current, '..');
    if (parent === current) break; // Reached filesystem root
    current = parent;
  }

  // No identifier found — fall back to cwd with detected: false
  return { root: realpathSync(start), detected: false };
}

// ---- scanProjectMeta --------------------------------------------------------
// AC2+AC3: Async metadata scanning with timeout and file limits.

export async function scanProjectMeta(projectRoot: string, detected: boolean): Promise<ProjectContext> {
  if (!detected) {
    return { projectRoot, detected: false, detectedAt: Date.now() };
  }

  const result: ProjectContext = {
    projectRoot,
    detected: true,
    detectedAt: Date.now(),
  };

  // Run the full scan inside a timeout wrapper
  const scanned = await withTimeout(scanMetaInner(projectRoot, result), SCAN_TIMEOUT_MS, result);
  return scanned;
}

async function scanMetaInner(root: string, ctx: ProjectContext): Promise<ProjectContext> {
  // 1. Read package.json
  const pkgPath = join(root, 'package.json');
  try {
    await access(pkgPath);
    const raw = await readFile(pkgPath, 'utf-8');
    const pkg = JSON.parse(raw);

    // Project name
    if (typeof pkg.name === 'string') {
      ctx = { ...ctx, name: pkg.name };
    }

    // Node.js version
    const nodeVersion = pkg.engines?.node;
    if (typeof nodeVersion === 'string') {
      ctx = { ...ctx, nodeVersion };
    } else {
      // Try .nvmrc or .node-version
      for (const f of ['.nvmrc', '.node-version'] as const) {
        try {
          const v = await readFile(join(root, f), 'utf-8');
          ctx = { ...ctx, nodeVersion: v.trim() };
          break;
        } catch { /* file not found */ }
      }
    }

    // Module system
    const type = pkg.type;
    if (type === 'module') {
      ctx = { ...ctx, moduleSystem: 'esm' };
    } else if (type === 'commonjs' || type === undefined) {
      ctx = { ...ctx, moduleSystem: 'cjs' };
    }

    // Package manager detection
    ctx = { ...ctx, packageManager: detectPackageManager(root) };

    // Framework detection
    ctx = { ...ctx, framework: detectFramework(pkg) };

    // Language inference
    ctx = { ...ctx, language: detectLanguage(pkg) };

    // Monorepo detection
    ctx = { ...ctx, monorepo: await detectMonorepo(root) };
  } catch {
    // No package.json — fall through with partial context
  }

  // 2. Config file scan
  ctx = { ...ctx, configFiles: await scanConfigFiles(root) };

  // 3. Monorepo packages scan
  if (ctx.monorepo) {
    ctx = { ...ctx, packages: await scanMonorepoPackages(root) };
  }

  return ctx;
}

// ---- detectPackageManager ---------------------------------------------------

function detectPackageManager(root: string): PackageManager {
  if (existsSync(join(root, 'pnpm-workspace.yaml')) || existsSync(join(root, 'pnpm-lock.yaml'))) {
    return 'pnpm';
  }
  if (existsSync(join(root, 'yarn.lock'))) {
    return 'yarn';
  }
  if (existsSync(join(root, 'package-lock.json'))) {
    return 'npm';
  }
  return 'unknown';
}

// ---- detectFramework --------------------------------------------------------

export function detectFramework(pkg: Record<string, unknown>): string | undefined {
  const deps = {
    ...(pkg.dependencies as Record<string, string> | undefined),
    ...(pkg.devDependencies as Record<string, string> | undefined),
  };

  // Check in order — more specific (longer package name) matches first
  for (const [dep, framework] of FRAMEWORK_MAP) {
    if (dep in deps) return framework;
  }

  return undefined;
}

// ---- detectLanguage ---------------------------------------------------------

export function detectLanguage(pkg: Record<string, unknown>): string {
  const devDeps = (pkg.devDependencies as Record<string, string> | undefined) ?? {};
  const deps = (pkg.dependencies as Record<string, string> | undefined) ?? {};

  // TypeScript check
  if ('typescript' in devDeps || 'typescript' in deps) {
    return 'TypeScript';
  }

  return 'JavaScript';
}

// ---- detectMonorepo ---------------------------------------------------------

async function detectMonorepo(root: string): Promise<boolean> {
  if (existsSync(join(root, 'pnpm-workspace.yaml'))) return true;
  if (existsSync(join(root, 'lerna.json'))) return true;
  return false;
}

// ---- scanConfigFiles --------------------------------------------------------

async function scanConfigFiles(root: string): Promise<string[]> {
  const configs: string[] = [];
  const candidates = [
    'tsconfig.json',
    'eslint.config.js',
    'eslint.config.mjs',
    'eslint.config.ts',
    '.prettierrc',
    '.prettierrc.json',
    '.editorconfig',
    'Dockerfile',
    '.dockerignore',
    '.gitignore',
    'biome.json',
    'rome.json',
    '.eslintrc',
    '.eslintrc.json',
    '.eslintrc.js',
  ];

  for (const c of candidates) {
    try {
      await access(join(root, c));
      configs.push(c);
    } catch { /* not found */ }
  }

  return configs;
}

// ---- scanMonorepoPackages ---------------------------------------------------

async function scanMonorepoPackages(root: string): Promise<string[]> {
  const packagesDir = join(root, 'packages');
  const result: string[] = [];
  let count = 0;

  try {
    const entries = await readdir(packagesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (count >= SCAN_FILE_LIMIT) {
        result.push('[truncated]');
        break;
      }

      if (!entry.isDirectory()) continue;
      if (SKIP_DIRS.has(entry.name)) continue;

      const pkgJsonPath = join(packagesDir, entry.name, 'package.json');
      try {
        await access(pkgJsonPath);
        const raw = await readFile(pkgJsonPath, 'utf-8');
        const pkg = JSON.parse(raw);
        if (typeof pkg.name === 'string') {
          result.push(pkg.name);
          count++;
        }
      } catch { /* no package.json in sub-package */ }
    }
  } catch { /* packages/ does not exist or is inaccessible */ }

  return result;
}

// ---- withTimeout ------------------------------------------------------------

async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timer = undefined;
          reject(new Error('TIMEOUT'));
        }, ms);
      }),
    ]);
    return result;
  } catch (err) {
    if (err instanceof Error && err.message === 'TIMEOUT') {
      return fallback;
    }
    throw err;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ---- formatProjectContext ---------------------------------------------------
// AC4: Format ProjectContext as a markdown block for system prompt injection.

export function formatProjectContext(ctx: ProjectContext): string {
  const lines: string[] = ['--- Project Context ---'];

  if (!ctx.detected) {
    lines.push(`Project Root: ${ctx.projectRoot}`);
    lines.push('(No project metadata detected)');
    lines.push('---');
    return lines.join('\n');
  }

  if (ctx.name) lines.push(`Project: ${ctx.name}`);
  if (ctx.language) lines.push(`Language: ${ctx.language}`);
  if (ctx.packageManager && ctx.packageManager !== 'unknown') {
    lines.push(`Package Manager: ${ctx.packageManager}`);
  }
  if (ctx.framework) lines.push(`Framework: ${ctx.framework}`);
  if (ctx.moduleSystem) lines.push(`Module System: ${ctx.moduleSystem.toUpperCase()}`);
  if (ctx.nodeVersion) lines.push(`Node.js: ${ctx.nodeVersion}`);
  if (ctx.monorepo !== undefined) lines.push(`Monorepo: ${ctx.monorepo ? 'yes' : 'no'}`);
  if (ctx.packages && ctx.packages.length > 0) {
    lines.push(`Packages: ${ctx.packages.join(', ')}`);
  }
  if (ctx.configFiles && ctx.configFiles.length > 0) {
    lines.push(`Config Files: ${ctx.configFiles.join(', ')}`);
  }

  lines.push('---');
  return lines.join('\n');
}

/**
 * Truncate the formatted context to maxChars if needed.
 */
export function truncateProjectContext(formatted: string, maxChars: number = MAX_PROJECT_CONTEXT_CHARS): string {
  if (formatted.length <= maxChars) return formatted;
  return formatted.slice(0, maxChars) + '\n--- (truncated) ---';
}
