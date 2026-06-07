// @zaivim/engine — File attachment resolver
// Reads file content, enforces maxOutputBytes truncation (ADR-19),
// and validates paths stay within projectDir (FR79).

import type { FileAttachment } from '@zaivim/core';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

const DEFAULT_MAX_OUTPUT_BYTES = 100 * 1024; // 100KB (ADR-19)

const EXT_LANGUAGE_MAP: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  rb: 'ruby',
  sh: 'bash', bash: 'bash',
  sql: 'sql',
  html: 'html', htm: 'html',
  css: 'css',
  json: 'json',
  yaml: 'yaml', yml: 'yaml',
  xml: 'xml',
  md: 'markdown',
  vim: 'vim',
};

function inferLanguage(filePath: string): string {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return EXT_LANGUAGE_MAP[ext] ?? ext;
}

export interface ResolveAttachmentOptions {
  maxOutputBytes?: number;
  projectDir: string;
}

/**
 * Resolve file attachments: read content, truncate, validate paths.
 * Returns FileAttachment[] ready for injection into message context.
 */
export async function resolveAttachments(
  paths: string[],
  options: ResolveAttachmentOptions,
): Promise<FileAttachment[]> {
  const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const results: FileAttachment[] = [];

  for (const filePath of paths) {
    // Security: path must be within projectDir
    const resolved = path.resolve(filePath);
    const projectResolved = path.resolve(options.projectDir);
    if (!resolved.startsWith(projectResolved + path.sep) && resolved !== projectResolved) {
      throw new Error(`File path outside project directory: ${filePath}`);
    }

    let content: string;
    try {
      content = await fsp.readFile(resolved, 'utf-8');
    } catch (err) {
      throw new Error(`Failed to read file: ${filePath} — ${err instanceof Error ? err.message : String(err)}`);
    }

    const truncated = Buffer.byteLength(content, 'utf-8') > maxBytes;
    if (truncated) {
      content = content.slice(0, maxBytes) + '\n[truncated]';
    }

    results.push({
      path: filePath,
      content,
      truncated,
      language: inferLanguage(filePath),
    });
  }

  return results;
}

/**
 * Format attachments for injection into message content.
 */
export function formatAttachments(attachments: readonly FileAttachment[]): string {
  if (attachments.length === 0) return '';
  return '\n\n---\n' + attachments.map(a => {
    const tag = a.truncated ? ' [truncated]' : '';
    const lang = a.language ?? '';
    return `[Attached file: ${a.path}]${tag}\n\`\`\`${lang}\n${a.content}\n\`\`\``;
  }).join('\n\n');
}
