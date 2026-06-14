// @zaivim/tools — File operations tools
// Story 3.1: file_read, file_write, file_search
// All path validation delegates to ISecurityProvider.openFile() (Story 2.4).

import { existsSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, renameSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { readFile, readdir, stat } from 'node:fs/promises';
import { createTwoFilesPatch } from 'diff';
import { randomBytes } from 'node:crypto';
import type { ToolDefinition, ToolContext } from '@zaivim/core';

// ─── Constants ─────────────────────────────────────────────────────────────────

const MAX_OUTPUT_BYTES = 10_240; // 10KB default (ADR-19)
const MAX_FILE_READ_BYTES = 512_000; // 500KB hard limit
const MAX_SEARCH_RESULTS = 2000;
const SEARCH_TIMEOUT_MS = 10_000;
const DEFAULT_EXCLUDE_DIRS = ['node_modules', '.git', 'dist', 'build', '.zaivim'];
// Security-critical internal directories. These are NEVER searchable, even when
// the caller passes includeHidden=true. AC3: .zaivim/backups/ and .git/ must
// stay invisible to AI tools regardless of user override.
const HARDCODED_INTERNAL_DIRS = ['.git', '.zaivim'];

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface FileReadParams {
  path: string;
  offset?: number;
  limit?: number;
}

export interface FileReadResult {
  path: string;
  content: string;
  size: number;
  truncated: boolean;
  lines: number;
}

export interface FileWriteParams {
  path: string;
  content: string;
}

export interface FileWriteResult {
  path: string;
  proposal?: FileChangeProposal;
  size: number;
  /** Story 3.5: true when the write is pending user approval */
  pending?: boolean;
  /** Story 3.5: changeId for the pending approval */
  changeId?: string;
}

export interface FileChangeProposal {
  originalPath: string;
  backupPath: string;
  diff: string;
  proposedContent: string;
  operation: 'create' | 'modify';
}

export interface FileSearchParams {
  pattern: string;
  glob?: string;
  maxResults?: number;
  includeHidden?: boolean;
  contextLines?: number;
}

export interface FileSearchMatch {
  file: string;
  line: number;
  context: string[];
}

export interface FileSearchResult {
  matches: FileSearchMatch[];
  totalMatches: number;
  truncated: boolean;
  /** Present only when truncated=true; message the AI sees explaining the cap. */
  truncatedMessage?: string;
  elapsedMs: number;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** Generate a unified diff between original and proposed content using diff npm package (ADR-16). */
export function generateDiff(original: string, proposed: string, filePath?: string): string {
  return createTwoFilesPatch(filePath ?? 'original', filePath ?? 'proposed', original, proposed);
}

/** Check if a file path should be excluded from search. */
function isExcludedDir(relativePath: string, excludeDirs: string[]): boolean {
  const parts = relativePath.split(/[/\\]/);
  return parts.some(part => excludeDirs.includes(part));
}

/** Check if a path touches a security-critical internal directory (.git, .zaivim). */
function touchesInternalDir(relativePath: string): boolean {
  return isExcludedDir(relativePath, HARDCODED_INTERNAL_DIRS);
}

/**
 * Compile an AI-supplied pattern to a RegExp. If the pattern is not valid
 * regex, fall back to a literal substring search (escaped). This prevents
 * malformed patterns like "[" or "(*" from crashing the tool.
 *
 * Note: we do not attempt full ReDoS detection. The 10s AbortController and
 * the per-file readFile signal give coarse bounds; patterns like `(a+)+` on
 * a long line can still hang the synchronous regex match within a single
 * line. Mitigation relies on the timeout firing after the current line
 * completes; users who observe hangs should narrow their pattern.
 */
function tryCompilePattern(pattern: string): RegExp {
  try {
    return new RegExp(pattern, 'g');
  } catch {
    // Escape regex metacharacters and fall back to literal substring match
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(escaped, 'g');
  }
}

/** Safely read lines from buffer with size limit check. */
function truncatedLines(content: string, maxBytes: number): { content: string; truncated: boolean; lines: number } {
  const byteLen = Buffer.byteLength(content, 'utf-8');
  if (byteLen <= maxBytes) {
    const lineCount = content.split('\n').length;
    return { content, truncated: false, lines: lineCount };
  }
  const lines = content.split('\n');
  let accumulated = 0;
  let lineIdx = 0;
  for (let i = 0; i < lines.length; i++) {
    accumulated += Buffer.byteLength(lines[i] + '\n', 'utf-8');
    if (accumulated > maxBytes) {
      lineIdx = i;
      break;
    }
    lineIdx = i + 1;
  }
  const truncated = lines.slice(0, lineIdx).join('\n');
  return {
    content: truncated + `\n... [truncated, showing first ${lineIdx} of ${lines.length} lines. Use offset/limit for targeted reading]`,
    truncated: true,
    lines: lineIdx,
  };
}

// ─── FileReadTool ──────────────────────────────────────────────────────────────

export const fileReadTool: ToolDefinition<FileReadParams, FileReadResult> = {
  name: 'file_read',
  description: 'Read a file from the project. Returns content with line numbers. Large files are truncated. Path is validated against .git boundary and internal directories.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to project root' },
      offset: { type: 'number', description: 'Line offset for pagination (0-indexed)' },
      limit: { type: 'number', description: 'Max lines to return' },
    },
    required: ['path'],
  },
  harmLevel: 'C',
  requiresApproval: false,

  async execute(params: FileReadParams, ctx: ToolContext): Promise<FileReadResult> {
    // 1. Path validation via ISecurityProvider.openFile() (Story 2.4 validatePathSafe)
    const handle = await ctx.security.openFile(params.path, 'read');

    // Read through the handle in try/finally so fd is released even on throw
    try {
      // 2. Read full content via SafeFileHandle (not raw fs)
      const content = await handle.read('utf-8');

      // 3. Size pre-check — reject files over maxFileReadBytes
      const byteLen = Buffer.byteLength(content, 'utf-8');
      if (byteLen > MAX_FILE_READ_BYTES) {
        throw Object.assign(
          new Error(`File exceeds maximum read size of ${MAX_FILE_READ_BYTES / 1024}KB (${(byteLen / 1024).toFixed(1)}KB)`),
          { code: 'TOOLS_OUTPUT_TOO_LARGE' },
        );
      }

      // 4. Apply offset/limit if specified
      let targetContent = content;
      if (params.offset !== undefined || params.limit !== undefined) {
        const allLines = content.split('\n');
        const start = params.offset ?? 0;
        const end = params.limit !== undefined ? start + params.limit : allLines.length;
        targetContent = allLines.slice(start, end).join('\n');
      }

      // 5. Truncate if exceeds maxOutputBytes (ADR-19)
      const { content: finalContent, truncated, lines } = truncatedLines(targetContent, MAX_OUTPUT_BYTES);

      // 6. Audit
      ctx.audit('file_read', {
        path: params.path,
        size: byteLen,
        truncated,
        offset: params.offset,
        limit: params.limit,
      });

      return {
        path: params.path,
        content: finalContent,
        size: byteLen,
        truncated,
        lines,
      };
    } finally {
      await handle.close();
    }
  },
};

// ─── FileWriteTool ─────────────────────────────────────────────────────────────

export const fileWriteTool: ToolDefinition<FileWriteParams, FileWriteResult> = {
  name: 'file_write',
  description: 'Write content to a file. Existing files are backed up and a diff proposal is generated for user review. New files are created with parent directories.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to project root' },
      content: { type: 'string', description: 'Content to write' },
    },
    required: ['path', 'content'],
  },
  harmLevel: 'B',
  requiresApproval: true,

  async execute(params: FileWriteParams, ctx: ToolContext): Promise<FileWriteResult> {
    // 1. Path validation — openFile validates write permissions
    const approval = await ctx.security.openFile(params.path, 'write');

    // Resolve project root via the security provider so backups land at the
    // session-scoped {projectRoot}/.zaivim/backups/{sessionId}/... location
    // mandated by AC8 (ADR-21), not next to the target file.
    const rootHandle = await ctx.security.openFile('.', 'read');
    const projectRoot = rootHandle.validatedPath;
    await rootHandle.close();

    const targetPath = approval.resolvedPath;
    const exists = existsSync(targetPath);
    let proposal: FileChangeProposal | undefined;

    if (exists) {
      // 2. Backup before write (ADR-21) — session-scoped under project root
      const backupDir = resolve(projectRoot, '.zaivim', 'backups', ctx.sessionId);
      mkdirSync(backupDir, { recursive: true });
      const backupPath = resolve(backupDir, `${Date.now()}-${basename(params.path)}`);
      copyFileSync(targetPath, backupPath);

      // 3. Generate diff (ADR-16)
      const originalContent = readFileSync(targetPath, 'utf-8');
      const diff = generateDiff(originalContent, params.content, params.path);

      // 4. Create proposal for rollback support
      proposal = {
        originalPath: params.path,
        backupPath,
        diff,
        proposedContent: params.content,
        operation: 'modify',
      };

      // 4a. Story 3.5: Async approval path — submit for review instead of writing
      if (ctx.requestApproval) {
        // Build core-compatible proposal with required fields
        const coreProposal: import('@zaivim/core').FileChangeProposal = {
          path: params.path,
          operation: 'modify',
          diff,
          reason: `Modify ${params.path}`,
          originalPath: params.path,
          backupPath,
          proposedContent: params.content,
          sessionId: ctx.sessionId,
        };

        const pending = await ctx.requestApproval(coreProposal);
        const byteLen = Buffer.byteLength(params.content, 'utf-8');

        ctx.audit('file_write', {
          path: params.path,
          size: byteLen,
          isNew: !exists,
          pending: true,
          changeId: pending.changeId,
        });

        return {
          path: params.path,
          proposal,
          size: byteLen,
          pending: true,
          changeId: pending.changeId,
        };
      }
    }

    // 5. Atomic write: write to temp file in the same directory, then rename.
    // POSIX rename() is atomic — a crash mid-write leaves the original file
    // intact and the temp file orphaned, never a half-written target.
    // (Skipped when approval path was taken above; reaching here means either
    // this is a new file or ctx.requestApproval was undefined.)
    mkdirSync(dirname(targetPath), { recursive: true });
    const tempPath = resolve(dirname(targetPath), `.${basename(targetPath)}.${randomBytes(6).toString('hex')}.tmp`);
    writeFileSync(tempPath, params.content, 'utf-8');
    renameSync(tempPath, targetPath);

    const byteLen = Buffer.byteLength(params.content, 'utf-8');

    // 6. Audit
    ctx.audit('file_write', {
      path: params.path,
      size: byteLen,
      isNew: !exists,
      backupPath: proposal?.backupPath,
    });

    return {
      path: params.path,
      proposal,
      size: byteLen,
    };
  },
};

// ─── FileSearchTool ────────────────────────────────────────────────────────────

export const fileSearchTool: ToolDefinition<FileSearchParams, FileSearchResult> = {
  name: 'file_search',
  description: 'Search for a pattern across project files. Returns matching files with line numbers and context. Supports regex and literal patterns.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Text or regex pattern to search for' },
      glob: { type: 'string', description: 'File glob filter (e.g., "*.ts")' },
      maxResults: { type: 'number', default: MAX_SEARCH_RESULTS, description: 'Maximum results to return (default 2000)' },
      includeHidden: { type: 'boolean', default: false, description: 'Include hidden directories like node_modules' },
      contextLines: { type: 'number', default: 1, description: 'Lines of context before/after each match' },
    },
    required: ['pattern'],
  },
  harmLevel: 'C',
  requiresApproval: false,

  async execute(params: FileSearchParams, ctx: ToolContext): Promise<FileSearchResult> {
    const startTime = performance.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);

    try {
      const excludeDirs = params.includeHidden ? [...HARDCODED_INTERNAL_DIRS] : [...DEFAULT_EXCLUDE_DIRS];
      const maxResults = params.maxResults ?? MAX_SEARCH_RESULTS;
      const contextLines = params.contextLines ?? 1;

      // Build the matcher. AI-supplied patterns may be invalid regex; fall back
      // to a literal substring search rather than crashing with SyntaxError.
      // We also cap pattern length to bound worst-case regex compile cost.
      const MAX_PATTERN_LEN = 500;
      if (params.pattern.length > MAX_PATTERN_LEN) {
        throw Object.assign(
          new Error(`pattern exceeds maximum length of ${MAX_PATTERN_LEN} characters`),
          { code: 'TOOLS_INVALID_PATTERN' },
        );
      }
      const regex = tryCompilePattern(params.pattern);

      // Use ctx.security to obtain a validated project root. We openFile('.')
      // for read; providers validate that the cwd is within the .git boundary
      // and return a SafeFileHandle whose validatedPath is the resolved root.
      // If validation fails, the search itself is rejected — preventing AI
      // from probing paths outside the project.
      const rootHandle = await ctx.security.openFile('.', 'read');
      const projectRoot = rootHandle.validatedPath;
      await rootHandle.close();

      const matches: FileSearchMatch[] = [];
      let totalMatches = 0;
      // True if walkDir exited before exhausting the project tree because the
      // maxResults cap was reached. Distinct from totalMatches > maxResults
      // since the cap check (>=) can fire at exactly maxResults.
      let stoppedAtCap = false;

      // Recursive directory walk with AbortSignal support
      async function walkDir(dirPath: string, relativePath: string): Promise<void> {
        if (controller.signal.aborted) return;
        // Hard filter: never descend into internal dirs (.git, .zaivim)
        // regardless of includeHidden. AC3.
        if (touchesInternalDir(relativePath)) return;
        if (isExcludedDir(relativePath, excludeDirs)) return;

        let entries: import('node:fs').Dirent[];
        try {
          entries = await readdir(dirPath, { withFileTypes: true });
        } catch {
          return; // Permission denied, skip
        }

        for (const entry of entries) {
          if (controller.signal.aborted) return;

          const fullPath = resolve(dirPath, entry.name);
          const relPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

          // Defense in depth: skip any path component matching internal dirs
          // even if the dirent name differs in casing we already cover above.
          if (touchesInternalDir(relPath)) continue;

          try {
            if (entry.isDirectory()) {
              if (!isExcludedDir(relPath, excludeDirs)) {
                await walkDir(fullPath, relPath);
              }
            } else if (entry.isFile()) {
              const entryStat = await stat(fullPath);
              if (entryStat.size === 0) continue;
              // Apply glob filter only to files, not directories
              if (params.glob) {
                const globSuffix = params.glob.replace('*', '');
                if (!entry.name.endsWith(globSuffix)) continue;
              }
              await searchFile(fullPath, relPath);
            }
          } catch {
            // Skip inaccessible entries
          }

          if (totalMatches >= maxResults) {
            stoppedAtCap = true;
            return;
          }
        }
      }

      async function searchFile(fullPath: string, relPath: string): Promise<void> {
        if (controller.signal.aborted) return;

        try {
          const content = await readFile(fullPath, 'utf-8');
          const lines = content.split('\n');

          for (let i = 0; i < lines.length; i++) {
            if (controller.signal.aborted) return;
            regex.lastIndex = 0; // Reset regex state

            const line = lines[i];
            if (line !== undefined && regex.test(line)) {
              totalMatches++;
              if (matches.length < maxResults) {
                const context: string[] = [];
                for (let c = Math.max(0, i - contextLines); c <= Math.min(lines.length - 1, i + contextLines); c++) {
                  const ctxLine = lines[c];
                  if (ctxLine !== undefined) context.push(ctxLine);
                }
                matches.push({
                  file: relPath,
                  line: i + 1, // 1-indexed
                  context,
                });
              }
            }
          }
        } catch {
          // Skip unreadable files (binary, etc.)
        }
      }

      await walkDir(projectRoot, '');

      const truncated = stoppedAtCap;
      const elapsedMs = performance.now() - startTime;
      // totalMatches is a lower bound when truncated: we stop counting once
      // the cap is reached, so the true total may be higher. Surface that
      // ambiguity in the message so AI knows to narrow its query (AC7).
      const truncatedMessage = truncated
        ? `[truncated, ${matches.length} of ${totalMatches}+ matches shown. Narrow your pattern or glob for targeted results]`
        : undefined;

      // Audit
      ctx.audit('file_search', {
        pattern: params.pattern,
        glob: params.glob,
        matches: matches.length,
        totalMatches,
        truncated,
        elapsedMs,
      });

      return {
        matches,
        totalMatches,
        truncated,
        truncatedMessage,
        elapsedMs,
      };
    } finally {
      clearTimeout(timeout);
    }
  },
};
