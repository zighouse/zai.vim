// @zaivim/gateway — Forward-compat chunk dispatcher tests (AC10/AC11)
// Exercises the actual streamChatResponse() dispatcher end-to-end with a mock
// engine + spy stdout. Verifies that known chunk types are routed as
// $/chat/chunk, unknown chunk types pass through as forward:unknown_chunk
// (sanitized), phase chunks become phase notifications, and illegal phase
// values produce only a stderr warning.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { streamChatResponse } from '../server.js';
import { decodeLine } from '../../stdio/jsonrpc-codec.js';
import type { EngineAPI, ResponseChunk, Message } from '@zaivim/core';

/** Build a mock engine whose chat() yields the provided chunks. */
function mockEngine(chunks: ResponseChunk[]): EngineAPI {
  return {
    chat: async function* (_sid: string, _msg: Message, _signal?: AbortSignal): AsyncIterable<ResponseChunk> {
      for (const c of chunks) yield c;
    },
  } as unknown as EngineAPI;
}

/** Spy Writable that captures every write() call as a string. */
function spyStream(): { stream: { write: ReturnType<typeof vi.fn> }; collected: string[] } {
  const collected: string[] = [];
  const write = vi.fn((s: string) => {
    collected.push(s);
    return true;
  });
  return { stream: { write }, collected };
}

/** Decode all JSON-RPC frames captured on the spy stream. */
function decodeFrames(lines: string[]): any[] {
  return lines
    .flatMap((l) => l.split('\n'))
    .filter((l) => l.trim().length > 0)
    .map((l) => decodeLine(l));
}

describe('streamChatResponse dispatcher — known chunk types (AC10.1)', () => {
  const knownCases: Array<[string, Record<string, unknown>]> = [
    ['text', { type: 'text', content: 'hello world' }],
    ['tool_call', { type: 'tool_call', id: 't1', name: 'read_file', arguments: { path: '/tmp' } }],
    ['tool_result', { type: 'tool_result', toolCallId: 't1', content: 'data' }],
    ['error', { type: 'error', code: 'ERR', message: 'boom' }],
  ];

  for (const [label, chunk] of knownCases) {
    it(`routes ${label} chunk as $/chat/chunk`, async () => {
      const engine = mockEngine([chunk as ResponseChunk]);
      const out = spyStream();
      await streamChatResponse(engine, 's1', { id: 'm1', role: 'user', content: 'hi', createdAt: 0 } as Message, new AbortController().signal, out.stream as any);

      const frames = decodeFrames(out.collected);
      const chunkFrames = frames.filter((f) => f.method === '$/chat/chunk');
      expect(chunkFrames.length).toBeGreaterThanOrEqual(1);
      // First chunk frame carries the dispatched chunk
      expect(chunkFrames[0].params.type).toBe(label);
      // Stream terminates with a 'done' chunk
      const done = frames.find((f) => f.params?.type === 'done');
      expect(done).toBeDefined();
    });
  }

  it('does NOT emit forward:unknown_chunk for known types', async () => {
    const engine = mockEngine([{ type: 'text', content: 'hi' } as unknown as ResponseChunk]);
    const out = spyStream();
    await streamChatResponse(engine, 's1', { id: 'm1', role: 'user', content: 'hi', createdAt: 0 } as Message, new AbortController().signal, out.stream as any);

    const frames = decodeFrames(out.collected);
    const unknown = frames.find((f) => f.params?.type === 'forward:unknown_chunk');
    expect(unknown).toBeUndefined();
  });
});

describe('streamChatResponse dispatcher — unknown chunk types (AC10.2)', () => {
  beforeEach(() => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forwards unknown chunk as forward:unknown_chunk notification', async () => {
    const engine = mockEngine([{ type: 'future_unknown', data: 'payload' } as unknown as ResponseChunk]);
    const out = spyStream();
    await streamChatResponse(engine, 's1', { id: 'm1', role: 'user', content: 'hi', createdAt: 0 } as Message, new AbortController().signal, out.stream as any);

    const combined = out.collected.join('');
    // The original chunk type appears in the forwarded frame's data payload
    expect(combined).toContain('"type":"forward:unknown_chunk"');
    expect(combined).toContain('future_unknown');
  });

  it('writes debug log to stderr for unknown chunk', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const engine = mockEngine([{ type: 'weird_chunk', data: 'x' } as unknown as ResponseChunk]);
    const out = spyStream();
    await streamChatResponse(engine, 's1', { id: 'm1', role: 'user', content: 'hi', createdAt: 0 } as Message, new AbortController().signal, out.stream as any);

    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('unknown chunk type: weird_chunk'));
  });

  it('sanitizes ANSI escape sequences in unknown chunk before forwarding (AC7)', async () => {
    const engine = mockEngine([{ type: 'evil\x1b[31m', data: 'red' } as unknown as ResponseChunk]);
    const out = spyStream();
    await streamChatResponse(engine, 's1', { id: 'm1', role: 'user', content: 'hi', createdAt: 0 } as Message, new AbortController().signal, out.stream as any);

    // Combined stdout text must NOT contain raw ANSI escape
    const combined = out.collected.join('');
    expect(combined).not.toContain('\x1b[31m');
  });

  it('does not throw on stats/thinking chunk types', async () => {
    const engine = mockEngine([
      { type: 'stats', tokensIn: 1, tokensOut: 2 } as unknown as ResponseChunk,
      { type: 'thinking', content: 'hmm' } as unknown as ResponseChunk,
    ]);
    const out = spyStream();
    await expect(
      streamChatResponse(engine, 's1', { id: 'm1', role: 'user', content: 'hi', createdAt: 0 } as Message, new AbortController().signal, out.stream as any),
    ).resolves.toBeUndefined();
  });
});

describe('streamChatResponse dispatcher — phase chunks (AC11)', () => {
  beforeEach(() => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const VALID_PHASES = ['request', 'thinking', 'tool', 'response', 'done', 'error'] as const;
  for (const phase of VALID_PHASES) {
    it(`extracts phase '${phase}' into $/notification with phase data`, async () => {
      const engine = mockEngine([
        { type: 'phase', phase, elapsed: 1500, tokens: 30, toolName: 'read_file' } as unknown as ResponseChunk,
      ]);
      const out = spyStream();
      await streamChatResponse(engine, 's1', { id: 'm1', role: 'user', content: 'hi', createdAt: 0 } as Message, new AbortController().signal, out.stream as any);

      const frames = decodeFrames(out.collected);
      const phaseNotif = frames.find((f) => f.method === '$/notification' && f.params?.type === 'phase');
      expect(phaseNotif).toBeDefined();
      expect(phaseNotif.params.data.phase).toBe(phase);
      expect(phaseNotif.params.data.elapsed).toBe(1500);
      expect(phaseNotif.params.data.tokens).toBe(30);
    });
  }

  it('skips illegal phase value with stderr warning only (no stdout notification)', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const engine = mockEngine([{ type: 'phase', phase: 'not_a_real_phase' } as unknown as ResponseChunk]);
    const out = spyStream();
    await streamChatResponse(engine, 's1', { id: 'm1', role: 'user', content: 'hi', createdAt: 0 } as Message, new AbortController().signal, out.stream as any);

    const frames = decodeFrames(out.collected);
    const phaseNotif = frames.find((f) => f.params?.type === 'phase');
    expect(phaseNotif).toBeUndefined();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('illegal phase value'));
  });
});

describe('streamChatResponse dispatcher — stream lifecycle', () => {
  it('appends a done chunk at the end of a successful stream', async () => {
    const engine = mockEngine([{ type: 'text', content: 'hello' } as unknown as ResponseChunk]);
    const out = spyStream();
    await streamChatResponse(engine, 's1', { id: 'm1', role: 'user', content: 'hi', createdAt: 0 } as Message, new AbortController().signal, out.stream as any);

    const frames = decodeFrames(out.collected);
    const lastChunk = frames.filter((f) => f.method === '$/chat/chunk').at(-1);
    expect(lastChunk.params.type).toBe('done');
  });

  it('emits error chunk when engine.chat throws', async () => {
    const engine = {
      chat: async function* (): AsyncIterable<ResponseChunk> {
        throw new Error('boom');
      },
    } as unknown as EngineAPI;
    const out = spyStream();
    await streamChatResponse(engine, 's1', { id: 'm1', role: 'user', content: 'hi', createdAt: 0 } as Message, new AbortController().signal, out.stream as any);

    const frames = decodeFrames(out.collected);
    const errChunk = frames.find((f) => f.params?.type === 'error');
    expect(errChunk).toBeDefined();
    expect(errChunk.params.message).toBe('boom');
  });
});
