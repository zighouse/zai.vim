// @zaivim/engine — sanitizeForVim unit tests
// Covers: ANSI escape stripping, control character replacement,
// Vim command injection neutralization, edge cases.

import { describe, it, expect } from 'vitest';
import { sanitizeForVim, sanitizeForTerminal } from '../sanitize-terminal.js';

describe('sanitizeForVim', () => {
  // ---- ANSI escape sequences ----

  it('strips ANSI color codes (CSI SGR)', () => {
    expect(sanitizeForVim('\x1b[31mred\x1b[0m')).toBe('red');
  });

  it('strips ANSI cursor movement', () => {
    expect(sanitizeForVim('\x1b[2J\x1b[Aclear')).toBe('clear');
  });

  it('strips ANSI erase-in-line', () => {
    expect(sanitizeForVim('hello\x1b[K')).toBe('hello');
  });

  it('strips ANSI OSC title sequences', () => {
    expect(sanitizeForVim('\x1b]0;My Title\x07content')).toBe('content');
  });

  it('strips multiple adjacent escape sequences', () => {
    expect(sanitizeForVim('\x1b[1m\x1b[31m\x1b[44mbold red on blue\x1b[0m')).toBe('bold red on blue');
  });

  // ---- Control characters ----

  it('replaces null byte with ?', () => {
    expect(sanitizeForVim('a\x00b')).toBe('a?b');
  });

  it('replaces bell character with ?', () => {
    expect(sanitizeForVim('alert\x07!')).toBe('alert?!');
  });

  it('replaces tab as-is', () => {
    expect(sanitizeForVim('a\tb')).toBe('a\tb');
  });

  it('preserves newline', () => {
    expect(sanitizeForVim('line1\nline2')).toBe('line1\nline2');
  });

  it('replaces carriage return with ?', () => {
    expect(sanitizeForVim('a\rb')).toBe('a?b');
  });

  it('replaces form feed with ?', () => {
    expect(sanitizeForVim('a\x0cb')).toBe('a?b');
  });

  it('replaces escape (\\x1b) when not part of valid sequence', () => {
    expect(sanitizeForVim('hello\x1bworld')).toBe('hello?world');
  });

  it('replaces all control characters (0x00-0x1F minus \\n, \\t)', () => {
    const input = '\x01\x02\x03\x04\x05\x06\x07\x08\x0b\x0c\x0d\x0e\x0f\x10\x11\x12\x13\x14\x15\x16\x17\x18\x19\x1a\x1b\x1c\x1d\x1e\x1f';
    const expected = '?????????????????????????????';
    expect(sanitizeForVim(input)).toBe(expected);
  });

  // ---- Vim command injection protection ----

  it('strips leading colon from line start', () => {
    expect(sanitizeForVim(':!rm -rf /')).toBe('!rm -rf /');
  });

  it('strips multiple leading colons', () => {
    expect(sanitizeForVim(':::!rm -rf /')).toBe('!rm -rf /');
  });

  it('strips leading colon on subsequent lines', () => {
    const input = 'normal text\n:!rm -rf /\nanother line';
    expect(sanitizeForVim(input)).toBe('normal text\n!rm -rf /\nanother line');
  });

  it('preserves inline colon', () => {
    expect(sanitizeForVim('label: value')).toBe('label: value');
  });

  it('preserves colon in middle of line', () => {
    expect(sanitizeForVim('The result is: done')).toBe('The result is: done');
  });

  // ---- Real-world AI output patterns ----

  it('handles code blocks with backticks', () => {
    const input = '```python\nprint("hello")\n```';
    expect(sanitizeForVim(input)).toBe(input);
  });

  it('handles markdown formatting', () => {
    const input = '# Heading\n**bold** *italic*';
    expect(sanitizeForVim(input)).toBe(input);
  });

  // ---- Edge cases ----

  it('handles empty string', () => {
    expect(sanitizeForVim('')).toBe('');
  });

  it('handles pure ASCII', () => {
    const input = 'Hello, World! 123';
    expect(sanitizeForVim(input)).toBe(input);
  });

  it('handles emoji and 4-byte UTF-8', () => {
    const input = '🔥 🚀 中文 日本語';
    expect(sanitizeForVim(input)).toBe(input);
  });

  it('handles mixed emoji, ANSI, and control chars', () => {
    const input = '\x1b[32m✅ Success\x1b[0m\x00';
    expect(sanitizeForVim(input)).toBe('✅ Success?');
  });

  it('handles string with only escape sequences', () => {
    expect(sanitizeForVim('\x1b[1m\x1b[32m\x1b[44m')).toBe('');
  });

  it('handles string with only control chars', () => {
    expect(sanitizeForVim('\x01\x02\x03')).toBe('???');
  });

  it('handles null/undefined gracefully', () => {
    expect(sanitizeForVim('undefined')).toBe('undefined');
    expect(sanitizeForVim('null')).toBe('null');
  });

  // ---- Complex injection scenarios ----

  it('strips ANSI sequences embedded in text', () => {
    const input = 'normal\x1b[31mred\x1b[0mnormal';
    expect(sanitizeForVim(input)).toBe('normalrednormal');
  });

  it('neutralizes :q command at line start', () => {
    expect(sanitizeForVim(':q')).toBe('q');
  });

  it('neutralizes :!bash at line start', () => {
    expect(sanitizeForVim(':!bash')).toBe('!bash');
  });

  it('handles \\r\\n (Windows line endings)', () => {
    // \r gets replaced with ?, \n preserved
    expect(sanitizeForVim('line1\r\nline2')).toBe('line1?\nline2');
  });
});

// ---- sanitizeForTerminal (TUI) ----

describe('sanitizeForTerminal', () => {
  // Default options: stripAnsi=true, stripControl=true, stripLeadingColon=false

  it('strips ANSI CSI sequences by default', () => {
    expect(sanitizeForTerminal('\x1b[31mred\x1b[0m')).toBe('red');
  });

  it('strips ANSI OSC sequences by default', () => {
    expect(sanitizeForTerminal('\x1b]0;title\x07content')).toBe('content');
  });

  it('strips control characters (except \\n) by default', () => {
    expect(sanitizeForTerminal('a\x00b\r\nc')).toBe('ab\nc');
  });

  it('preserves tab by default', () => {
    expect(sanitizeForTerminal('a\tb')).toBe('a\tb');
  });

  it('preserves newline by default', () => {
    expect(sanitizeForTerminal('a\nb')).toBe('a\nb');
  });

  it('preserves leading colon (TUI has no Vim injection risk)', () => {
    expect(sanitizeForTerminal(':!rm -rf /')).toBe(':!rm -rf /');
  });

  it('strips nothing when all options are false', () => {
    const input = '\x1b[31mhello\x00world\x1b[0m';
    expect(sanitizeForTerminal(input, { stripAnsi: false, stripControl: false })).toBe(input);
  });

  it('can opt-in to leading colon stripping', () => {
    expect(sanitizeForTerminal(':q', { stripLeadingColon: true })).toBe('q');
  });

  it('handles empty string', () => {
    expect(sanitizeForTerminal('')).toBe('');
  });

  it('handles pure ASCII', () => {
    expect(sanitizeForTerminal('Hello, World!')).toBe('Hello, World!');
  });

  it('handles emoji and Unicode', () => {
    expect(sanitizeForTerminal('🔥 🚀 中文')).toBe('🔥 🚀 中文');
  });

  it('preserves inline colon', () => {
    expect(sanitizeForTerminal('label: value')).toBe('label: value');
  });

  it('strips multiple adjacent ANSI sequences', () => {
    expect(sanitizeForTerminal('\x1b[1m\x1b[31mbold red\x1b[0m')).toBe('bold red');
  });

  it('replaces form feed with empty string', () => {
    expect(sanitizeForTerminal('a\x0cb')).toBe('ab');
  });

  it('replaces carriage return with empty string', () => {
    expect(sanitizeForTerminal('a\rb')).toBe('ab');
  });

  it('does not throw on null-like string input', () => {
    expect(sanitizeForTerminal('null')).toBe('null');
    expect(sanitizeForTerminal('undefined')).toBe('undefined');
  });

  it('strips only ANSI when stripControl is false', () => {
    const input = '\x1b[31mhello\x00world';
    expect(sanitizeForTerminal(input, { stripAnsi: true, stripControl: false })).toBe('hello\x00world');
  });

  it('strips only control when stripAnsi is false', () => {
    // \x1b (ESC, 0x1B) is in control char range \x0e-\x1f, so it gets stripped
    // leaving the bare '[' from the ANSI sequence
    const input = '\x1b[31mhello\x00world';
    expect(sanitizeForTerminal(input, { stripAnsi: false, stripControl: true })).toBe('[31mhelloworld');
  });

  it('strips all control characters (0x00-0x1F minus \\n, \\t)', () => {
    const input = '\x01\x02\x03\x04\x05\x06\x07\x08\x0b\x0c\x0d\x0e\x0f';
    expect(sanitizeForTerminal(input)).toBe('');
  });

  it('handles mixed emoji, ANSI, and control chars', () => {
    expect(sanitizeForTerminal('\x1b[32m✅ Success\x1b[0m\x00')).toBe('✅ Success');
  });

  it('handles string with only escape sequences', () => {
    expect(sanitizeForTerminal('\x1b[1m\x1b[32m\x1b[44m')).toBe('');
  });
});
