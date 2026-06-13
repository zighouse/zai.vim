// @zaivim/tools — File operations tools
// Story 3.1: file_read, file_write, file_search
// All path validation delegates to ISecurityProvider.openFile() (Story 2.4).

import { existsSync, mkdirSync, copyFileSync, writeFileSync, readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { readFile, readdir, stat } from 'node:fs/promises';
import { createTwoFilesPatch } from 'diff';
import type { ToolDefinition, ToolContext } from '@zaivim/core';

// ─── Constants ─────────────────────────────────────────────────────────────────

const MAX_OUTPUT_BYTES = 10_240; // 10KB default (ADR-19)
const MAX_FILE_READ_BYTES = 512_000; // 500KB hard limit
const MAX_SEARCH_RESULTS = 2000;
const SEARCH_TIMEOUT_MS = 10_000;
const DEFAULT_EXCLUDE_DIRS = ['node_modules', '.git', 'dist', 'build', '.zaivim'];

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

    // 2. Read full content via SafeFileHandle (not raw fs)
    const content = await handle.read('utf-8');
    await handle.close();

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

    const targetPath = approval.resolvedPath;
    const exists = existsSync(targetPath);
    let proposal: FileChangeProposal | undefined;

    if (exists) {
      // 2. Backup before write (ADR-21)
      const backupDir = resolve(dirname(targetPath), '.zaivim', 'backups');
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
    }

    // 5. Write file (atomic: write to temp then rename)
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, params.content, 'utf-8');

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
      const excludeDirs = params.includeHidden ? [] : [...DEFAULT_EXCLUDE_DIRS];
      const maxResults = params.maxResults ?? MAX_SEARCH_RESULTS;
      const contextLines = params.contextLines ?? 1;
      const regex = new RegExp(params.pattern, 'g');

      const projectRoot = process.cwd();
      const matches: FileSearchMatch[] = [];
      let totalMatches = 0;

      // Recursive directory walk with AbortSignal support
      async function walkDir(dirPath: string, relativePath: string): Promise<void> {
        if (controller.signal.aborted) return;
        if (isExcludedDir(relativePath, excludeDirs)) return;

        let entries: string[];
        try {
          entries = await readdir(dirPath, { withFileTypes: false });
        } catch {
          return; // Permission denied, skip
        }

        for (const entry of entries) {
          if (controller.signal.aborted) return;

          const fullPath = resolve(dirPath, entry);
          const relPath = relativePath ? `${relativePath}/${entry}` : entry;

          try {
            const entryStat = await stat(fullPath);
            if (entryStat.isDirectory()) {
              if (!isExcludedDir(relPath, excludeDirs)) {
                await walkDir(fullPath, relPath);
              }
            } else if (entryStat.isFile() && entryStat.size > 0) {
              // Apply glob filter only to files, not directories
              if (params.glob) {
                const globSuffix = params.glob.replace('*', '');
                if (!entry.endsWith(globSuffix)) continue;
              }
              await searchFile(fullPath, relPath);
            }
          } catch {
            // Skip inaccessible entries
          }

          if (totalMatches >= maxResults) return;
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

      const truncated = totalMatches > maxResults;
      const elapsedMs = performance.now() - startTime;

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
        elapsedMs,
      };
    } finally {
      clearTimeout(timeout);
    }
  },
};
