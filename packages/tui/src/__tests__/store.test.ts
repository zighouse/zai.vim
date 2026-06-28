// @zaivim/tui — Store unit tests
// Covers: session CRUD, switching, state updates, streaming chunks.

import { describe, it, expect } from 'vitest';
import { createTuiStore } from '../store.js';

describe('TuiStore', () => {
  // ---- Session CRUD (C1.2) ----

  it('creates a session and sets it as active when none exists', () => {
    const store = createTuiStore();
    store.dispatch({ type: 'SESSION_CREATED', payload: { id: 's1', name: 'Session 1' } });
    const state = store.getState();
    expect(state.sessions.has('s1')).toBe(true);
    expect(state.activeSessionId).toBe('s1');
    expect(state.sessions.get('s1')!.name).toBe('Session 1');
    expect(state.sessions.get('s1')!.status).toBe('active');
  });

  it('keeps existing active session when creating another session', () => {
    const store = createTuiStore();
    store.dispatch({ type: 'SESSION_CREATED', payload: { id: 's1', name: 'S1' } });
    store.dispatch({ type: 'SESSION_CREATED', payload: { id: 's2', name: 'S2' } });
    // Active stays on s1 since it was first
    expect(store.getState().activeSessionId).toBe('s1');
  });

  it('switches active session', () => {
    const store = createTuiStore();
    store.dispatch({ type: 'SESSION_CREATED', payload: { id: 's1', name: 'S1' } });
    store.dispatch({ type: 'SESSION_CREATED', payload: { id: 's2', name: 'S2' } });
    store.dispatch({ type: 'SESSION_ACTIVATED', payload: { id: 's2' } });
    expect(store.getState().activeSessionId).toBe('s2');
  });

  it('removes a session and falls back to next available', () => {
    const store = createTuiStore();
    store.dispatch({ type: 'SESSION_CREATED', payload: { id: 's1', name: 'S1' } });
    store.dispatch({ type: 'SESSION_CREATED', payload: { id: 's2', name: 'S2' } });
    store.dispatch({ type: 'SESSION_ACTIVATED', payload: { id: 's1' } });
    store.dispatch({ type: 'SESSION_REMOVED', payload: { id: 's1' } });
    expect(store.getState().sessions.has('s1')).toBe(false);
    expect(store.getState().activeSessionId).toBe('s2');
  });

  it('removing last session sets activeSessionId to null', () => {
    const store = createTuiStore();
    store.dispatch({ type: 'SESSION_CREATED', payload: { id: 's1', name: 'S1' } });
    store.dispatch({ type: 'SESSION_REMOVED', payload: { id: 's1' } });
    expect(store.getState().activeSessionId).toBe(null);
  });

  // ---- State updates (C1.2) ----

  it('updates connection status', () => {
    const store = createTuiStore();
    store.dispatch({ type: 'CONNECTION_CHANGED', payload: { status: 'reconnecting' } });
    expect(store.getState().connectionStatus).toBe('reconnecting');
  });

  it('updates session status', () => {
    const store = createTuiStore();
    store.dispatch({ type: 'SESSION_CREATED', payload: { id: 's1', name: 'S1' } });
    store.dispatch({ type: 'SESSION_STATUS', payload: { sessionId: 's1', status: 'error' } });
    expect(store.getState().sessions.get('s1')!.status).toBe('error');
  });

  // ---- Streaming (C1.2) ----

  it('adds user message and sets session to streaming', () => {
    const store = createTuiStore();
    store.dispatch({ type: 'SESSION_CREATED', payload: { id: 's1', name: 'S1' } });
    store.dispatch({
      type: 'MESSAGE_ADDED',
      payload: {
        sessionId: 's1',
        message: { id: 'm1', role: 'user', content: 'hello', createdAt: 1, isStreaming: false },
      },
    });
    const session = store.getState().sessions.get('s1')!;
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0].content).toBe('hello');
    expect(session.status).toBe('streaming');
  });

  it('appends text chunks to streaming assistant message', () => {
    const store = createTuiStore();
    store.dispatch({ type: 'SESSION_CREATED', payload: { id: 's1', name: 'S1' } });
    store.dispatch({ type: 'STREAM_START', payload: { sessionId: 's1' } });
    store.dispatch({
      type: 'CHUNK_APPENDED',
      payload: {
        sessionId: 's1',
        chunk: { type: 'text', content: 'Hello' },
      },
    });
    store.dispatch({
      type: 'CHUNK_APPENDED',
      payload: {
        sessionId: 's1',
        chunk: { type: 'text', content: ' World' },
      },
    });
    const session = store.getState().sessions.get('s1')!;
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0].content).toBe('Hello World');
    expect(session.messages[0].isStreaming).toBe(true);
  });

  it('handles tool_call chunk', () => {
    const store = createTuiStore();
    store.dispatch({ type: 'SESSION_CREATED', payload: { id: 's1', name: 'S1' } });
    store.dispatch({
      type: 'CHUNK_APPENDED',
      payload: {
        sessionId: 's1',
        chunk: { type: 'tool_call', name: 'read_file' },
      },
    });
    const msgs = store.getState().sessions.get('s1')!.messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toContain('read_file');
  });

  it('handles tool_result chunk', () => {
    const store = createTuiStore();
    store.dispatch({ type: 'SESSION_CREATED', payload: { id: 's1', name: 'S1' } });
    store.dispatch({
      type: 'CHUNK_APPENDED',
      payload: {
        sessionId: 's1',
        chunk: { type: 'tool_result', status: 'ok' },
      },
    });
    const msgs = store.getState().sessions.get('s1')!.messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toContain('ok');
  });

  it('handles error chunk', () => {
    const store = createTuiStore();
    store.dispatch({ type: 'SESSION_CREATED', payload: { id: 's1', name: 'S1' } });
    store.dispatch({
      type: 'CHUNK_APPENDED',
      payload: {
        sessionId: 's1',
        chunk: { type: 'error', message: 'API error' },
      },
    });
    const msgs = store.getState().sessions.get('s1')!.messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toContain('error');
  });

  it('handles done chunk and finalizes streaming message', () => {
    const store = createTuiStore();
    store.dispatch({ type: 'SESSION_CREATED', payload: { id: 's1', name: 'S1' } });
    store.dispatch({ type: 'STREAM_START', payload: { sessionId: 's1' } });
    store.dispatch({
      type: 'CHUNK_APPENDED',
      payload: { sessionId: 's1', chunk: { type: 'text', content: 'done' } },
    });
    store.dispatch({
      type: 'CHUNK_APPENDED',
      payload: { sessionId: 's1', chunk: { type: 'done', finishReason: 'stop' } },
    });
    const msgs = store.getState().sessions.get('s1')!.messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].isStreaming).toBe(false);
  });

  it('CHUNKS_APPENDED applies a batch in one reducer pass', () => {
    const store = createTuiStore();
    store.dispatch({ type: 'SESSION_CREATED', payload: { id: 's1', name: 'S1' } });
    store.dispatch({ type: 'STREAM_START', payload: { sessionId: 's1' } });
    store.dispatch({
      type: 'CHUNKS_APPENDED',
      payload: {
        sessionId: 's1',
        chunks: [
          { type: 'text', content: 'Hello' },
          { type: 'text', content: ' ' },
          { type: 'text', content: 'World' },
        ],
      },
    });
    const session = store.getState().sessions.get('s1')!;
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0].content).toBe('Hello World');
    expect(session.messages[0].isStreaming).toBe(true);
    expect(session.tokensOut).toBe('Hello World'.length);
  });

  it('CHUNKS_APPENDED with done chunk finalizes the streaming message', () => {
    const store = createTuiStore();
    store.dispatch({ type: 'SESSION_CREATED', payload: { id: 's1', name: 'S1' } });
    store.dispatch({ type: 'STREAM_START', payload: { sessionId: 's1' } });
    store.dispatch({
      type: 'CHUNKS_APPENDED',
      payload: {
        sessionId: 's1',
        chunks: [
          { type: 'text', content: 'final' },
          { type: 'done', finishReason: 'stop' },
        ],
      },
    });
    const msgs = store.getState().sessions.get('s1')!.messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('final');
    expect(msgs[0].isStreaming).toBe(false);
  });

  it('CHUNKS_APPENDED with empty array is a no-op', () => {
    const store = createTuiStore();
    store.dispatch({ type: 'SESSION_CREATED', payload: { id: 's1', name: 'S1' } });
    const before = store.getState().sessions.get('s1')!;
    store.dispatch({ type: 'CHUNKS_APPENDED', payload: { sessionId: 's1', chunks: [] } });
    const after = store.getState().sessions.get('s1')!;
    expect(after.messages).toEqual(before.messages);
    expect(after.tokensOut).toBe(before.tokensOut);
  });

  // ---- Story 5.5: thinking/stats/phase chunks (AC9) ----

  it('thinking chunk updates thinkingRing on session', () => {
    const store = createTuiStore();
    store.dispatch({ type: 'SESSION_CREATED', payload: { id: 's1', name: 'S1' } });
    store.dispatch({
      type: 'CHUNK_APPENDED',
      payload: { sessionId: 's1', chunk: { type: 'thinking', content: 'step 1', phase: 'delta' } },
    });
    store.dispatch({
      type: 'CHUNK_APPENDED',
      payload: { sessionId: 's1', chunk: { type: 'thinking', content: ' step 2', phase: 'delta' } },
    });
    expect(store.getState().sessions.get('s1')!.thinkingRing).toBe('step 1 step 2');
  });

  it('stats chunk populates tokensIn/elapsedMs/speed', () => {
    const store = createTuiStore();
    store.dispatch({ type: 'SESSION_CREATED', payload: { id: 's1', name: 'S1' } });
    store.dispatch({
      type: 'CHUNK_APPENDED',
      payload: { sessionId: 's1', chunk: { type: 'stats', tokensIn: 100, tokensOut: 50, elapsedMs: 2000, speed: 25 } },
    });
    const s = store.getState().sessions.get('s1')!;
    expect(s.tokensIn).toBe(100);
    expect(s.elapsedMs).toBe(2000);
    expect(s.speed).toBe(25);
  });

  it('phase chunk updates session phase field', () => {
    const store = createTuiStore();
    store.dispatch({ type: 'SESSION_CREATED', payload: { id: 's1', name: 'S1' } });
    store.dispatch({
      type: 'CHUNK_APPENDED',
      payload: { sessionId: 's1', chunk: { type: 'phase', phase: 'thinking' } },
    });
    expect(store.getState().sessions.get('s1')!.phase).toBe('thinking');
  });

  it('open-ended passthrough for truly unknown chunk types (C4.1)', () => {
    const store = createTuiStore();
    store.dispatch({ type: 'SESSION_CREATED', payload: { id: 's1', name: 'S1' } });
    // Truly unknown chunk should not throw and not break store
    expect(() => {
      store.dispatch({
        type: 'CHUNK_APPENDED',
        payload: { sessionId: 's1', chunk: { type: 'future_unknown', data: 'x' } },
      });
    }).not.toThrow();
    expect(store.getState().sessions.get('s1')!.status).toBe('active');
  });

  // ---- Subscribe / notify ----

  it('notifies subscribers on dispatch', () => {
    const store = createTuiStore();
    let notified = false;
    store.subscribe(() => { notified = true; });
    store.dispatch({ type: 'CONNECTION_CHANGED', payload: { status: 'disconnected' } });
    expect(notified).toBe(true);
  });

  it('unsubscribes correctly', () => {
    const store = createTuiStore();
    let count = 0;
    const unsub = store.subscribe(() => { count++; });
    unsub();
    store.dispatch({ type: 'CONNECTION_CHANGED', payload: { status: 'disconnected' } });
    expect(count).toBe(0);
  });
});
