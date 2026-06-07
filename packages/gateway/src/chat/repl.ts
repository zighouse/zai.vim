// @zaivim/gateway — Interactive REPL for CLI chat
// Readline-based input loop with streaming AI output, command handling, and multiline support.

import * as readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import type { EngineAPI, ResponseChunk, Message } from '@zaivim/core';
import { createMarkdownRenderer } from './markdown-renderer.js';
import type { MarkdownRenderer } from './markdown-renderer.js';

export interface ReplOptions {
  /** Engine API instance. */
  engine: EngineAPI;
  /** Session ID for this chat. */
  sessionId: string;
  /** Output stream (default: process.stdout). */
  output?: NodeJS.WritableStream;
  /** Input stream (default: process.stdin). */
  input?: NodeJS.ReadableStream;
  /** Whether to render Markdown with ANSI formatting. */
  renderMarkdown?: boolean;
}

export interface ReplResult {
  /** How the REPL exited. */
  reason: 'exit' | 'eof';
  /** Final session ID (may have changed via /switch or /new). */
  sessionId: string;
}

const TOOL_RESULT_MAX_CHARS = 500;

type SpecialCommand = 'exit' | 'quit' | 'help' | 'sessions' | 'new' | 'switch';

interface ParsedCommand {
  command: SpecialCommand;
  args: string;
}

/**
 * Create and run an interactive chat REPL.
 * Returns when the user exits (via /exit, /quit, or Ctrl+C twice).
 */
export async function createChatRepl(opts: ReplOptions): Promise<ReplResult> {
  const {
    engine,
    sessionId: initialSessionId,
    output = process.stdout,
    input = process.stdin,
    renderMarkdown = true,
  } = opts;

  let currentSessionId = initialSessionId;
  const mdRenderer: MarkdownRenderer | null = renderMarkdown ? createMarkdownRenderer() : null;
  let abortController: AbortController | null = null;
  let isStreaming = false;
  let collectingMultiline = false;

  const rl = readline.createInterface({
    input,
    output,
    prompt: '> ',
    historySize: 1000,
  });

  rl.prompt();

  return new Promise<ReplResult>((resolve) => {
    let sigintCount = 0;
    let sigintTimer: ReturnType<typeof setTimeout> | null = null;

    const handleSigint = () => {
      sigintCount++;
      if (sigintCount === 1) {
        // First Ctrl+C: cancel current AI request
        if (isStreaming && abortController) {
          abortController.abort();
          output.write('\n[Request cancelled]\n');
        } else {
          // No active request — treat as exit intent
          cleanup('exit');
          return;
        }
        // Reset counter after 1s
        sigintTimer = setTimeout(() => { sigintCount = 0; }, 1000);
      } else {
        // Second Ctrl+C: force exit
        cleanup('exit');
      }
    };

    const cleanup = (reason: 'exit' | 'eof') => {
      if (sigintTimer) clearTimeout(sigintTimer);
      process.removeListener('SIGINT', handleSigint);
      rl.close();
      resolve({ reason, sessionId: currentSessionId });
    };

    process.on('SIGINT', handleSigint);

    rl.on('close', () => {
      cleanup('eof');
    });

    rl.on('line', async (rawLine: string) => {
      // During multiline collection, defer to the collect handler
      if (collectingMultiline) return;

      const line = rawLine.trim();

      // Empty line — re-prompt
      if (!line) {
        rl.prompt();
        return;
      }

      // Check for special commands
      const parsed = parseSpecialCommand(line);
      if (parsed) {
        const handled = await handleSpecialCommand(parsed, {
          engine,
          output,
          rl,
          currentSessionId,
          setCurrentSession: (id: string) => { currentSessionId = id; },
          cleanup: (reason: 'exit' | 'eof') => cleanup(reason),
        });
        if (handled === 'exit') return;
        rl.prompt();
        return;
      }

      // Check for line continuation (trailing \)
      let fullMessage = line;
      if (line.endsWith('\\')) {
        fullMessage = await collectMultiline(
          rl,
          output,
          () => collectingMultiline,
          (v) => { collectingMultiline = v; },
          line,
        );
      }

      // Send message and stream response
      abortController = new AbortController();
      isStreaming = true;

      try {
        const message: Message = { id: randomUUID(), role: 'user', content: fullMessage, createdAt: Date.now() };
        const stream = engine.chat(currentSessionId, message, abortController.signal);

        for await (const chunk of stream) {
          printStreamChunk(chunk, { output, mdRenderer, jsonMode: false });
        }
        output.write('\n');
      } catch (err: unknown) {
        if ((err as Error).name === 'AbortError') {
          // Already handled by SIGINT handler
        } else {
          output.write(`\n\x1b[31mError: ${(err as Error).message}\x1b[0m\n`);
        }
      } finally {
        isStreaming = false;
        abortController = null;
        mdRenderer?.reset();
      }

      rl.prompt();
    });
  });
}

/**
 * Print a single ResponseChunk to the output stream.
 * Exported for reuse in JSON pipe mode.
 */
export function printStreamChunk(
  chunk: ResponseChunk,
  opts: {
    output: NodeJS.WritableStream;
    mdRenderer: MarkdownRenderer | null;
    jsonMode: boolean;
  },
): void {
  const { output, mdRenderer, jsonMode } = opts;

  if (jsonMode) {
    // NDJSON mode: each chunk on its own line
    output.write(JSON.stringify(chunk) + '\n');
    return;
  }

  switch (chunk.type) {
    case 'text':
      if (mdRenderer) {
        output.write(mdRenderer.push(chunk.content));
      } else {
        output.write(chunk.content);
      }
      break;

    case 'tool_call':
      output.write(`\n\x1b[2m[Calling ${chunk.name}: ${truncate(JSON.stringify(chunk.arguments), 80)}]\x1b[0m\n`);
      break;

    case 'tool_result':
      output.write(`\n\x1b[2m[Result: ${truncate(chunk.content, TOOL_RESULT_MAX_CHARS)}]\x1b[0m\n`);
      break;

    case 'error':
      output.write(`\n\x1b[31mError: ${chunk.message}\x1b[0m\n`);
      break;

    case 'done':
      // No output needed for done chunk
      break;
  }
}

/** Collect multiline input (lines ending with \). Shows continuation prompt. */
async function collectMultiline(
  rl: readline.Interface,
  output: NodeJS.WritableStream,
  getCollectingFlag: () => boolean,
  setCollectingFlag: (v: boolean) => void,
  firstLine: string,
): Promise<string> {
  const lines: string[] = [firstLine.slice(0, -1)]; // Remove trailing \
  setCollectingFlag(true);
  output.write('> '); // AC6: continuation prompt

  return new Promise((resolve) => {
    const collect = (line: string) => {
      if (line.trimEnd().endsWith('\\')) {
        lines.push(line.trimEnd().slice(0, -1));
        output.write('> '); // AC6: continuation prompt for each \ line
      } else {
        lines.push(line);
        rl.removeListener('line', collect);
        setCollectingFlag(false);
        resolve(lines.join('\n'));
      }
    };
    rl.on('line', collect);
  });
}

/** Parse a special command from user input. Returns null if not a command. */
export function parseSpecialCommand(input: string): ParsedCommand | null {
  if (!input.startsWith('/')) return null;

  const parts = input.slice(1).split(/\s+/);
  const cmd = parts[0]?.toLowerCase() as SpecialCommand;
  const args = parts.slice(1).join(' ');

  const validCommands: SpecialCommand[] = ['exit', 'quit', 'help', 'sessions', 'new', 'switch'];
  if (!validCommands.includes(cmd)) return null;

  return { command: cmd, args };
}

/** Handle a parsed special command. Returns 'exit' if REPL should stop. */
async function handleSpecialCommand(
  parsed: ParsedCommand,
  ctx: {
    engine: EngineAPI;
    output: NodeJS.WritableStream;
    rl: readline.Interface;
    currentSessionId: string;
    setCurrentSession: (id: string) => void;
    cleanup: (reason: 'exit' | 'eof') => void;
  },
): Promise<'exit' | 'continue'> {
  const { command, args } = parsed;
  const { engine, output, rl, currentSessionId, setCurrentSession, cleanup } = ctx;

  switch (command) {
    case 'exit':
    case 'quit': {
      // Save session and exit
      try {
        await engine.closeSession(currentSessionId);
      } catch {
        // Best-effort save
      }
      cleanup('exit');
      return 'exit';
    }

    case 'help': {
      output.write(
        '\nAvailable commands:\n' +
        '  /help       Show this help\n' +
        '  /exit       Exit chat\n' +
        '  /quit       Exit chat\n' +
        '  /sessions   List active sessions\n' +
        '  /new        Create a new session\n' +
        '  /switch <id> Switch to a session\n' +
        '  \\ at EOL    Continue on next line\n' +
        '\n',
      );
      return 'continue';
    }

    case 'sessions': {
      const sessions = engine.listSessions();
      if (sessions.length === 0) {
        output.write('No active sessions.\n');
      } else {
        output.write('\nActive sessions:\n');
        for (const s of sessions) {
          output.write(`  ${s.id}  (messages: ${s.messageCount ?? '?'})\n`);
        }
        output.write('\n');
      }
      return 'continue';
    }

    case 'new': {
      const session = await engine.createSession();
      setCurrentSession(session.id);
      output.write(`New session created: ${session.id}\n`);
      return 'continue';
    }

    case 'switch': {
      if (!args) {
        output.write('Usage: /switch <session-id>\n');
        return 'continue';
      }
      const existing = engine.getSession(args);
      if (!existing) {
        output.write(`Session not found: ${args}\n`);
        // List available sessions
        const sessions = engine.listSessions();
        if (sessions.length > 0) {
          output.write('Available sessions:\n');
          for (const s of sessions) {
            output.write(`  ${s.id}\n`);
          }
        }
      } else {
        setCurrentSession(existing.id);
        output.write(`Switched to session: ${existing.id}\n`);
      }
      return 'continue';
    }

    default:
      return 'continue';
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + '...';
}
