// @zaivim/engine — Terminal output sanitizer for Vim adapter
// Strips ANSI escape sequences, control characters, and Vim command injections.
// Shared between packages/vim-adapter (VimScript) and packages/gateway/src/vim-rpc (vim-rpc-server).

// ANSI escape: CSI sequences like \x1b[31m, \x1b[2J, \x1b[A
const ANSI_CSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;
// ANSI OSC sequences like \x1b]0;title\x07
const ANSI_OSC_RE = /\x1b\][^\x07]*\x07/g;
// Control characters to replace (0x00-0x1F except \n=0x0A, \t=0x09, includes \r=0x0D)
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0d\x0e-\x1f]/g;
// Bare colon at start of line — Vim command mode trigger
const LEADING_COLON_RE = /^:+/gm;

/**
 * Sanitize a string for safe display in Vim buffers.
 *
 * - Strips ANSI escape sequences (colors, cursor movement, OSC title sequences)
 * - Replaces control characters (except \n, \t) with '?'
 * - Neutralizes bare `:` at line start to prevent Vim command injection
 *
 * @param input - Raw string from AI response or engine output
 * @returns Sanitized string safe for Vim buffer display
 */
export function sanitizeForVim(input: string): string {
  let result = input;

  // Step 1: Strip ANSI CSI sequences: \x1b[...m, \x1b[K, \x1b[A, etc.
  result = result.replace(ANSI_CSI_RE, '');

  // Step 2: Strip ANSI OSC sequences: \x1b]...\x07 (title, clipboard, etc.)
  result = result.replace(ANSI_OSC_RE, '');

  // Step 3: Replace control characters (keep \n and \t)
  result = result.replace(CONTROL_RE, '?');

  // Step 4: Neutralize bare colon at line start — Vim command injection
  result = result.replace(LEADING_COLON_RE, '');

  return result;
}
