// @zaivim/gateway — REPL tests (AC1, AC2, AC6, AC8)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseSpecialCommand, printStreamChunk } from '../repl.js';
import type { ResponseChunk } from '@zaivim/core';
import { createMarkdownRenderer } from '../markdown-renderer.js';

// ---- parseSpecialCommand tests ----

describe('parseSpecialCommand', () => {
  it('parses /exit', () => {
    expect(parseSpecialCommand('/exit')).toEqual({ command: 'exit', args: '' });
  });

  it('parses /quit', () => {
    expect(parseSpecialCommand('/quit')).toEqual({ command: 'quit', args: '' });
  });

  it('parses /help', () => {
    expect(parseSpecialCommand('/help')).toEqual({ command: 'help', args: '' });
  });

  it('parses /sessions', () => {
    expect(parseSpecialCommand('/sessions')).toEqual({ command: 'sessions', args: '' });
  });

  it('parses /new', () => {
    expect(parseSpecialCommand('/new')).toEqual({ command: 'new', args: '' });
  });

  it('parses /switch with session id', () => {
    expect(parseSpecialCommand('/switch abc-123')).toEqual({ command: 'switch', args: 'abc-123' });
  });

  it('returns null for non-command input', () => {
    expect(parseSpecialCommand('hello')).toBeNull();
  });

  it('returns null for unknown commands', () => {
    expect(parseSpecialCommand('/unknown')).toBeNull();
  });

  it('handles /EXIT case-insensitively', () => {
    expect(parseSpecialCommand('/EXIT')).toEqual({ command: 'exit', args: '' });
  });

  it('returns null for text not starting with /', () => {
    expect(parseSpecialCommand('not a command')).toBeNull();
  });
});

// ---- printStreamChunk tests ----

describe('printStreamChunk', () => {
  let output: string[];
  let mockOutputStream: NodeJS.WritableStream;

  beforeEach(() => {
    output = [];
    mockOutputStream = {
      write: (data: string) => { output.push(data); return true; },
    } as any;
  });

  it('renders text chunk with Markdown renderer', () => {
    const mdRenderer = createMarkdownRenderer();
    printStreamChunk(
      { type: 'text', content: '**bold**' },
      { output: mockOutputStream, mdRenderer, jsonMode: false },
    );
    const combined = output.join('');
    expect(combined).toContain('\x1b[1m'); // ANSI bold
  });

  it('renders text chunk without renderer as plain text', () => {
    printStreamChunk(
      { type: 'text', content: 'hello' },
      { output: mockOutputStream, mdRenderer: null, jsonMode: false },
    );
    expect(output.join('')).toBe('hello');
  });

  it('renders tool_call chunk', () => {
    printStreamChunk(
      { type: 'tool_call', id: '1', name: 'file_read', arguments: { path: './src/index.ts' } },
      { output: mockOutputStream, mdRenderer: null, jsonMode: false },
    );
    const combined = output.join('');
    expect(combined).toContain('Calling file_read');
    expect(combined).toContain('./src/index.ts');
  });

  it('renders tool_result chunk with truncation', () => {
    const longContent = 'x'.repeat(1000);
    printStreamChunk(
      { type: 'tool_result', toolCallId: '1', content: longContent },
      { output: mockOutputStream, mdRenderer: null, jsonMode: false },
    );
    const combined = output.join('');
    expect(combined.length).toBeLessThan(longContent.length + 100);
    expect(combined).toContain('...');
  });

  it('renders error chunk in red', () => {
    printStreamChunk(
      { type: 'error', code: 'NETWORK_ERROR', message: 'Connection failed' },
      { output: mockOutputStream, mdRenderer: null, jsonMode: false },
    );
    const combined = output.join('');
    expect(combined).toContain('\x1b[31m');
    expect(combined).toContain('Connection failed');
  });

  it('renders done chunk with no output', () => {
    printStreamChunk(
      { type: 'done', finishReason: 'stop' },
      { output: mockOutputStream, mdRenderer: null, jsonMode: false },
    );
    expect(output).toEqual([]);
  });

  // NDJSON mode tests
  it('outputs NDJSON for text chunk in json mode', () => {
    printStreamChunk(
      { type: 'text', content: 'hello' },
      { output: mockOutputStream, mdRenderer: null, jsonMode: true },
    );
    const parsed = JSON.parse(output[0]!);
    expect(parsed).toEqual({ type: 'text', content: 'hello' });
  });

  it('outputs NDJSON for error chunk in json mode', () => {
    printStreamChunk(
      { type: 'error', code: 'ERR', message: 'fail' },
      { output: mockOutputStream, mdRenderer: null, jsonMode: true },
    );
    const parsed = JSON.parse(output[0]!);
    expect(parsed).toEqual({ type: 'error', code: 'ERR', message: 'fail' });
  });

  it('each NDJSON output is a single line', () => {
    printStreamChunk(
      { type: 'text', content: 'multi\nline' },
      { output: mockOutputStream, mdRenderer: null, jsonMode: true },
    );
    const line = output[0]!;
    expect(line.endsWith('\n')).toBe(true);
    // The JSON itself should be a single line
    const jsonPart = line.trim();
    expect(jsonPart).not.toContain('\n');
  });
});
