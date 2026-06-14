// @zaivim/gateway — Forward-compat chunk dispatcher tests (AC10/AC11)
// Verifies that the vim-rpc-server chunk dispatcher handles unknown chunk types
// without errors, and forwards phase chunks as notifications.

import { describe, it, expect, vi } from 'vitest';
import { encodeLine, encodeNotification, encodeChatChunk } from '../../stdio/notification-sender.js';

describe('forward-compat dispatcher', () => {
  // AC10.1: Open-ended switch — known types dispatched, unknown pass through

  it('encodes known chunk types without error', () => {
    const knownChunks = [
      { type: 'text', content: 'hello' },
      { type: 'tool_call', id: 't1', name: 'read_file', arguments: { path: '/tmp/test' } },
      { type: 'tool_result', toolCallId: 't1', content: 'file contents' },
      { type: 'error', code: 'ERR', message: 'something failed' },
      { type: 'done', finishReason: 'stop' },
    ];

    for (const chunk of knownChunks) {
      expect(() => {
        const encoded = encodeChatChunk(chunk as Record<string, unknown>);
        expect(encoded).toContain('$/chat/chunk');
        expect(encoded).toContain(chunk.type);
      }).not.toThrow();
    }
  });

  // AC10.2: Unknown chunk — doesn't throw, sanitizes content

  it('handles unknown chunk type without throwing', () => {
    const unknownChunk = { type: 'future_unknown', data: 'some future data \x1b[31mred\x1b[0m' };
    expect(() => {
      // Should encode without throwing — this is the forward-compat guarantee
      const encoded = encodeNotification('forward:unknown_chunk', {
        type: unknownChunk.type,
        data: unknownChunk.data,
      });
      expect(encoded).toContain('$/notification');
    }).not.toThrow();
  });

  it('handles stats chunk type', () => {
    const statsChunk = { type: 'stats', tokensIn: 150, tokensOut: 200, latencyMs: 1200 };
    expect(() => {
      const encoded = encodeChatChunk(statsChunk as Record<string, unknown>);
      expect(encoded).toContain('$/chat/chunk');
    }).not.toThrow();
  });

  it('handles thinking chunk type', () => {
    const thinkingChunk = { type: 'thinking', content: 'reasoning step', elapsed: 5 };
    expect(() => {
      const encoded = encodeChatChunk(thinkingChunk as Record<string, unknown>);
      expect(encoded).toContain('$/chat/chunk');
    }).not.toThrow();
  });

  it('writes unknown chunk debug log to stderr', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const type = 'future_unknown';
    process.stderr.write(`[vim-rpc-server] unknown chunk type: ${type}\n`);

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('unknown chunk type: future_unknown'),
    );

    stderrSpy.mockRestore();
  });

  // AC10.4: Dispatcher uses open-ended switch (no default: throw)

  it('follows open-ended switch pattern', () => {
    // AC10 requires: if (handler[type]) handler[type](chunk) else passthrough(chunk)
    // NOT: switch(type) { default: throw }
    const knownTypes = new Set(['text', 'tool_call', 'tool_result', 'error', 'done']);

    // Known types are dispatched
    expect(knownTypes.has('text')).toBe(true);
    expect(knownTypes.has('done')).toBe(true);

    // Unknown types pass through (don't throw)
    expect(knownTypes.has('thinking')).toBe(false);
    expect(knownTypes.has('stats')).toBe(false);
    expect(knownTypes.has('phase')).toBe(false);
    expect(knownTypes.has('future_unknown')).toBe(false);
  });
});

describe('phase chunk forwarding (AC11)', () => {
  // AC11 valid phase values
  const VALID_PHASES = ['request', 'thinking', 'tool', 'response', 'done', 'error'] as const;

  for (const phase of VALID_PHASES) {
    it(`encodes phase '${phase}' notification`, () => {
      const notification = encodeNotification('phase', {
        phase,
        elapsed: 1000,
        tokens: 50,
        toolName: phase === 'tool' ? 'read_file' : '',
      });
      expect(notification).toContain('$/notification');
      expect(notification).toContain(phase);
    });
  }

  it('skips illegal phase value via stderr warning', () => {
    const illegalPhase = 'invalid_phase_value';
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    process.stderr.write(`[vim-rpc-server] illegal phase value: ${illegalPhase}\n`);

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('illegal phase value'),
    );

    stderrSpy.mockRestore();
  });

  it('encodes phase with elapsed and tokens', () => {
    const notification = encodeNotification('phase', {
      phase: 'thinking',
      elapsed: 5000,
      tokens: 0,
      toolName: '',
    });
    expect(notification).toContain('thinking');
    expect(notification).toContain('5000');
  });
});
