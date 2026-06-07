// @zaivim/gateway — Markdown renderer tests (AC7)

import { describe, it, expect } from 'vitest';
import { createMarkdownRenderer, renderMarkdownToTerminal } from '../markdown-renderer.js';

// Strip ANSI escape codes for easier assertion
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('createMarkdownRenderer', () => {
  it('passes plain text through unchanged', () => {
    const r = createMarkdownRenderer();
    const out = r.push('Hello world');
    expect(stripAnsi(out)).toBe('Hello world');
  });

  it('renders bold **text** with ANSI bold', () => {
    const r = createMarkdownRenderer();
    const out = r.push('This is **bold** text');
    expect(out).toContain('\x1b[1m');
    expect(out).toContain('\x1b[0m');
    expect(stripAnsi(out)).toBe('This is bold text');
  });

  it('renders italic *text* with ANSI italic', () => {
    const r = createMarkdownRenderer();
    const out = r.push('This is *italic* text');
    expect(out).toContain('\x1b[3m');
    expect(stripAnsi(out)).toBe('This is italic text');
  });

  it('renders inline code with ANSI background', () => {
    const r = createMarkdownRenderer();
    const out = r.push('Use `console.log` here');
    expect(out).toContain('\x1b[43m');
    expect(stripAnsi(out)).toBe('Use  console.log  here');
  });

  it('renders code block with ANSI cyan', () => {
    const r = createMarkdownRenderer();
    const out = r.push('```js\nconst x = 1;\n```\n');
    expect(out).toContain('\x1b[36m');
    expect(out).toContain('\x1b[0m');
    expect(stripAnsi(out)).toContain('js');
    expect(stripAnsi(out)).toContain('const x = 1;');
  });

  it('starts in NORMAL state', () => {
    const r = createMarkdownRenderer();
    expect(r.state).toBe('NORMAL');
  });

  it('transitions to IN_CODE_BLOCK on ```', () => {
    const r = createMarkdownRenderer();
    r.push('```js\n');
    expect(r.state).toBe('IN_CODE_BLOCK');
  });

  it('returns to NORMAL on closing ```', () => {
    const r = createMarkdownRenderer();
    r.push('```\ncode\n```\n');
    expect(r.state).toBe('NORMAL');
  });
});

describe('streaming state machine', () => {
  it('handles code block spanning multiple chunks', () => {
    const r = createMarkdownRenderer();
    const chunk1 = r.push('```ts\n');
    expect(r.state).toBe('IN_CODE_BLOCK');

    const chunk2 = r.push('const x = 1;\n');
    expect(r.state).toBe('IN_CODE_BLOCK');

    const chunk3 = r.push('```\n');
    expect(r.state).toBe('NORMAL');

    const combined = stripAnsi(chunk1 + chunk2 + chunk3);
    expect(combined).toContain('ts');
    expect(combined).toContain('const x = 1;');
  });

  it('handles partial ``` across chunk boundary', () => {
    const r = createMarkdownRenderer();
    // Send `` in one chunk, then ` in the next
    const chunk1 = r.push('text``');
    expect(r.state).toBe('NORMAL');

    const chunk2 = r.push('`\ncode\n');
    expect(r.state).toBe('IN_CODE_BLOCK');
  });

  it('resets state correctly', () => {
    const r = createMarkdownRenderer();
    r.push('```\ncode');
    expect(r.state).toBe('IN_CODE_BLOCK');
    r.reset();
    expect(r.state).toBe('NORMAL');
  });
});

describe('renderMarkdownToTerminal (convenience)', () => {
  it('renders a complete markdown document', () => {
    const md = 'Hello **world**\n```js\nfoo()\n```\nDone';
    const out = renderMarkdownToTerminal(md);
    expect(stripAnsi(out)).toContain('Hello world');
    expect(stripAnsi(out)).toContain('foo()');
    expect(stripAnsi(out)).toContain('Done');
  });
});

describe('edge cases', () => {
  it('handles empty string', () => {
    const r = createMarkdownRenderer();
    expect(r.push('')).toBe('');
  });

  it('handles code block with no language tag', () => {
    const r = createMarkdownRenderer();
    const out = r.push('```\ncode\n```\n');
    expect(r.state).toBe('NORMAL');
    expect(stripAnsi(out)).toContain('code');
  });

  it('handles list items (plain text passthrough)', () => {
    const r = createMarkdownRenderer();
    const out = r.push('- item 1\n- item 2\n');
    expect(stripAnsi(out)).toBe('- item 1\n- item 2\n');
  });

  it('handles numbered list', () => {
    const r = createMarkdownRenderer();
    const out = r.push('1. first\n2. second\n');
    expect(stripAnsi(out)).toBe('1. first\n2. second\n');
  });

  it('does not confuse single * with bold **', () => {
    const r = createMarkdownRenderer();
    const out = r.push('*italic* not **bold**');
    expect(out).toContain('\x1b[3m'); // italic
    expect(out).toContain('\x1b[1m'); // bold
  });
});
