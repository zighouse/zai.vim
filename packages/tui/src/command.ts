// @zaivim/tui — Command registry and dispatcher
// Implements the command-mode architecture (Phase D, Story 4.2 AC7).
// Input starting with `:` is parsed as a command; otherwise it's a chat message.

import type { SessionState, StoreAction } from './store.js';

// ---- Types -----------------------------------------------------------------

export interface CommandContext {
  sessions: Map<string, SessionState>;
  activeSessionId: string | null;
  dispatch: (action: StoreAction) => void;
  scrollMessages: (direction: 'up' | 'down') => void;
  scrollSessionList: (direction: 'up' | 'down') => void;
  onExit: () => void;
}

export interface Command {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly description: string;
  execute: (args: readonly string[], ctx: CommandContext) => string | void;
}

export interface CommandResult {
  ok: boolean;
  message?: string;
}

// ---- Parsing ---------------------------------------------------------------

export function parseCommandLine(
  line: string,
): { command: string; args: string[] } | null {
  if (!line.startsWith(':')) return null;
  const trimmed = line.slice(1).trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/\s+/);
  return { command: parts[0]!.toLowerCase(), args: parts.slice(1) };
}

// ---- Command registry ------------------------------------------------------

const commands: Command[] = [
  {
    name: 'session',
    aliases: ['s'],
    description: 'Switch session — :session next|prev|<n>  (alias :s)',
    execute(args, ctx) {
      const list = Array.from(ctx.sessions.values());
      if (list.length === 0) return 'No sessions available';
      const target = args[0]?.toLowerCase();
      const currentIdx = list.findIndex(s => s.id === ctx.activeSessionId);

      let nextIdx: number;
      if (target === 'next' || target === 'n') {
        nextIdx = currentIdx < 0 ? 0 : (currentIdx + 1) % list.length;
      } else if (target === 'prev' || target === 'p') {
        nextIdx =
          currentIdx < 0 ? 0 : (currentIdx - 1 + list.length) % list.length;
      } else if (target !== undefined && /^\d+$/.test(target)) {
        const n = parseInt(target, 10);
        if (n < 1 || n > list.length) {
          return `Invalid session index: ${n} (valid 1-${list.length})`;
        }
        nextIdx = n - 1;
      } else {
        return 'Usage: :session next|prev|<n>';
      }

      ctx.dispatch({ type: 'SESSION_ACTIVATED', payload: { id: list[nextIdx]!.id } });
    },
  },
  {
    name: 'scroll',
    aliases: ['sc'],
    description: 'Scroll chat messages — :scroll up|down  (alias :sc)',
    execute(args, ctx) {
      const dir = args[0]?.toLowerCase();
      if (dir === 'up') {
        ctx.scrollMessages('up');
      } else if (dir === 'down') {
        ctx.scrollMessages('down');
      } else {
        return 'Usage: :scroll up|down';
      }
    },
  },
  {
    name: 'help',
    aliases: ['h'],
    description: 'Show available commands',
    execute(_args, _ctx) {
      return commands
        .map(c => `:${c.name}${c.aliases.length ? ` (:${c.aliases.join('|')})` : ''} — ${c.description}`)
        .join('\n');
    },
  },
  {
    name: 'q',
    aliases: ['quit', 'exit'],
    description: 'Quit TUI',
    execute(_args, ctx) {
      ctx.onExit();
    },
  },
];

export function findCommand(name: string): Command | undefined {
  return commands.find(c => c.name === name || c.aliases.includes(name));
}

export function listCommands(): readonly Command[] {
  return commands;
}

// ---- Execution -------------------------------------------------------------

export function executeCommandLine(
  line: string,
  ctx: CommandContext,
): CommandResult {
  const parsed = parseCommandLine(line);
  if (!parsed) return { ok: false, message: 'Not a command' };
  const cmd = findCommand(parsed.command);
  if (!cmd) {
    return { ok: false, message: `Unknown command: :${parsed.command}` };
  }
  try {
    const out = cmd.execute(parsed.args, ctx);
    return { ok: true, message: typeof out === 'string' ? out : undefined };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}
