// @zaivim/tui — Command registry unit tests
// Phase D (AC7): parsing, dispatching, alias resolution, error handling.

import { describe, it, expect, vi } from 'vitest';
import { existsSync, readFileSync, unlinkSync, mkdtempSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseCommandLine,
  findCommand,
  listCommands,
  executeCommandLine,
  type CommandContext,
} from '../command.js';
import type { SessionState } from '../store.js';

function makeSession(id: string, name: string): SessionState {
  return {
    id,
    name,
    status: 'active',
    messages: [],
    elapsed: 0,
    tokensOut: 0,
  };
}

function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  const dispatch = vi.fn();
  const scrollMessages = vi.fn();
  const scrollSessionList = vi.fn();
  const onExit = vi.fn();
  return {
    sessions: new Map(),
    activeSessionId: null,
    dispatch,
    scrollMessages,
    scrollSessionList,
    onExit,
    ...overrides,
  };
}

describe('parseCommandLine', () => {
  it('parses :session next', () => {
    expect(parseCommandLine(':session next')).toEqual({
      command: 'session',
      args: ['next'],
    });
  });

  it('parses :s n alias', () => {
    expect(parseCommandLine(':s n')).toEqual({
      command: 's',
      args: ['n'],
    });
  });

  it('parses multi-word args', () => {
    expect(parseCommandLine(':session next please')).toEqual({
      command: 'session',
      args: ['next', 'please'],
    });
  });

  it('lowercases the command name', () => {
    expect(parseCommandLine(':SESSION next')).toEqual({
      command: 'session',
      args: ['next'],
    });
  });

  it('returns null for non-command lines', () => {
    expect(parseCommandLine('hello world')).toBeNull();
  });

  it('returns null when only : is typed', () => {
    expect(parseCommandLine(':')).toBeNull();
    expect(parseCommandLine(':   ')).toBeNull();
  });
});

describe('findCommand', () => {
  it('finds by name', () => {
    const cmd = findCommand('session');
    expect(cmd?.name).toBe('session');
  });

  it('finds by alias', () => {
    expect(findCommand('s')?.name).toBe('session');
    expect(findCommand('sc')?.name).toBe('scroll');
    expect(findCommand('h')?.name).toBe('help');
    expect(findCommand('quit')?.name).toBe('q');
  });

  it('returns undefined for unknown', () => {
    expect(findCommand('xyz')).toBeUndefined();
  });
});

describe('listCommands', () => {
  it('returns the P0 command set', () => {
    const names = listCommands().map((c) => c.name);
    expect(names).toContain('session');
    expect(names).toContain('scroll');
    expect(names).toContain('help');
    expect(names).toContain('export');
    expect(names).toContain('q');
  });
});

describe('executeCommandLine — session switching', () => {
  it('next wraps around when at the end', () => {
    const ctx = makeCtx({
      sessions: new Map([
        ['s1', makeSession('s1', 'A')],
        ['s2', makeSession('s2', 'B')],
        ['s3', makeSession('s3', 'C')],
      ]),
      activeSessionId: 's3',
    });
    const result = executeCommandLine(':session next', ctx);
    expect(result.ok).toBe(true);
    expect(ctx.dispatch).toHaveBeenCalledWith({
      type: 'SESSION_ACTIVATED',
      payload: { id: 's1' },
    });
  });

  it('prev wraps around when at the start', () => {
    const ctx = makeCtx({
      sessions: new Map([
        ['s1', makeSession('s1', 'A')],
        ['s2', makeSession('s2', 'B')],
      ]),
      activeSessionId: 's1',
    });
    const result = executeCommandLine(':s p', ctx);
    expect(result.ok).toBe(true);
    expect(ctx.dispatch).toHaveBeenCalledWith({
      type: 'SESSION_ACTIVATED',
      payload: { id: 's2' },
    });
  });

  it('jumps to numeric index (1-based)', () => {
    const ctx = makeCtx({
      sessions: new Map([
        ['s1', makeSession('s1', 'A')],
        ['s2', makeSession('s2', 'B')],
        ['s3', makeSession('s3', 'C')],
      ]),
      activeSessionId: 's1',
    });
    const result = executeCommandLine(':s 2', ctx);
    expect(result.ok).toBe(true);
    expect(ctx.dispatch).toHaveBeenCalledWith({
      type: 'SESSION_ACTIVATED',
      payload: { id: 's2' },
    });
  });

  it('rejects out-of-range index', () => {
    const ctx = makeCtx({
      sessions: new Map([
        ['s1', makeSession('s1', 'A')],
        ['s2', makeSession('s2', 'B')],
      ]),
      activeSessionId: 's1',
    });
    const result = executeCommandLine(':s 5', ctx);
    expect(result.ok).toBe(true); // command ran; failure surfaced as message
    expect(result.message).toMatch(/Invalid session index/);
    expect(ctx.dispatch).not.toHaveBeenCalled();
  });

  it('reports when there are no sessions', () => {
    const ctx = makeCtx();
    const result = executeCommandLine(':session next', ctx);
    expect(result.message).toMatch(/No sessions/);
    expect(ctx.dispatch).not.toHaveBeenCalled();
  });

  it('defaults to session 0 when no active session is set', () => {
    const ctx = makeCtx({
      sessions: new Map([
        ['s1', makeSession('s1', 'A')],
        ['s2', makeSession('s2', 'B')],
      ]),
      activeSessionId: null,
    });
    executeCommandLine(':session next', ctx);
    expect(ctx.dispatch).toHaveBeenCalledWith({
      type: 'SESSION_ACTIVATED',
      payload: { id: 's1' },
    });
  });
});

describe('executeCommandLine — scroll', () => {
  it('scroll up invokes the messages callback with default step', () => {
    const ctx = makeCtx();
    executeCommandLine(':scroll up', ctx);
    expect(ctx.scrollMessages).toHaveBeenCalledWith('up', 10);
  });

  it('scroll down via alias', () => {
    const ctx = makeCtx();
    executeCommandLine(':sc down', ctx);
    expect(ctx.scrollMessages).toHaveBeenCalledWith('down', 10);
  });

  it('scroll accepts explicit step', () => {
    const ctx = makeCtx();
    executeCommandLine(':sc up 5', ctx);
    expect(ctx.scrollMessages).toHaveBeenCalledWith('up', 5);
  });

  it('scroll clamps invalid step to 1', () => {
    const ctx = makeCtx();
    executeCommandLine(':sc up abc', ctx);
    expect(ctx.scrollMessages).toHaveBeenCalledWith('up', 1);
  });

  it('scroll top jumps to beginning', () => {
    const ctx = makeCtx();
    executeCommandLine(':sc top', ctx);
    expect(ctx.scrollMessages).toHaveBeenCalledWith('top');
  });

  it('scroll bottom jumps to newest', () => {
    const ctx = makeCtx();
    executeCommandLine(':sc bottom', ctx);
    expect(ctx.scrollMessages).toHaveBeenCalledWith('bottom');
  });

  it('rejects missing direction', () => {
    const ctx = makeCtx();
    const result = executeCommandLine(':sc', ctx);
    expect(result.message).toMatch(/Usage/);
    expect(ctx.scrollMessages).not.toHaveBeenCalled();
  });
});

describe('executeCommandLine — help', () => {
  it('lists all available commands', () => {
    const ctx = makeCtx();
    const result = executeCommandLine(':help', ctx);
    expect(result.ok).toBe(true);
    expect(result.message).toContain(':session');
    expect(result.message).toContain(':scroll');
    expect(result.message).toContain(':help');
  });
});

describe('executeCommandLine — export', () => {
  it('rejects missing file path', () => {
    const ctx = makeCtx({
      sessions: new Map([['s1', makeSession('s1', 'S1')]]),
      activeSessionId: 's1',
    });
    const result = executeCommandLine(':export', ctx);
    expect(result.message).toMatch(/Usage/);
  });

  it('rejects when no active session', () => {
    const ctx = makeCtx();
    const result = executeCommandLine(':export /tmp/x.txt', ctx);
    expect(result.message).toMatch(/No active session/);
  });

  it('rejects empty session', () => {
    const ctx = makeCtx({
      sessions: new Map([['s1', makeSession('s1', 'S1')]]),
      activeSessionId: 's1',
    });
    const result = executeCommandLine(':export /tmp/x.txt', ctx);
    expect(result.message).toMatch(/no messages/i);
  });

  it('writes messages to file via :e alias', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'zai-tui-test-'));
    const filePath = join(tmpDir, 'export-test.txt');

    const ctx = makeCtx({
      sessions: new Map([['s1', {
        ...makeSession('s1', 'Test Session'),
        messages: [
          { id: 'm1', role: 'user', content: 'hello', createdAt: 1000, isStreaming: false },
          { id: 'm2', role: 'assistant', content: 'world', createdAt: 2000, isStreaming: false },
        ],
      }]]),
      activeSessionId: 's1',
    });

    const result = executeCommandLine(`:e ${filePath}`, ctx);
    expect(result.ok).toBe(true);
    expect(result.message).toContain('Exported 2 messages');
    expect(existsSync(filePath)).toBe(true);

    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('Test Session');
    expect(content).toContain('[YOU —');
    expect(content).toContain('hello');
    expect(content).toContain('[AI —');
    expect(content).toContain('world');

    // Cleanup
    unlinkSync(filePath);
    rmdirSync(tmpDir);
  });
});

describe('executeCommandLine — exit', () => {
  it('triggers onExit via :q', () => {
    const ctx = makeCtx();
    executeCommandLine(':q', ctx);
    expect(ctx.onExit).toHaveBeenCalledTimes(1);
  });

  it('triggers onExit via :quit alias', () => {
    const ctx = makeCtx();
    executeCommandLine(':quit', ctx);
    expect(ctx.onExit).toHaveBeenCalledTimes(1);
  });
});

describe('executeCommandLine — errors', () => {
  it('returns error for unknown command', () => {
    const ctx = makeCtx();
    const result = executeCommandLine(':foobar', ctx);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Unknown command/);
  });

  it('returns error for non-command line', () => {
    const ctx = makeCtx();
    const result = executeCommandLine('hello', ctx);
    expect(result.ok).toBe(false);
  });
});
