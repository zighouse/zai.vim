// @zaivim/tui — Store unit tests
// Covers: session CRUD, switching, state updates, streaming chunks.

import { describe, it, expect } from 'vitest';
import { createTuiStore } from '../store.js';
import type { TuiClient, ChatChunk } from '../client.js';

/** Create a minimal mock client for store testing. */
function createMockClient(): TuiClient {
  return {
    connectionStatus: 'connected',
    send: async () => ({}),
    subscribe: () => (() => {}),
    chat: function* () { return; } as unknown as TuiClient['chat'],
    close: async () => {},
  };
}

describe('TuiStore', () => {
  // ---- Session CRUD (C1.2) ----

  it('creates a session and sets it as active when none exists', () => {
    const store = createTuiStore(createMockClient());
    store.dispatch({ type: 'SESSION_CREATED', payload: { id: 's1', name: 'Session 1' } });
    const state = store.getState();
    expect(state.sessions.has('s1')).toBe(true);
    expect(state.activeSessionId).toBe('s1');
    expect(state.sessions.get('s1')!.name).toBe('Session 1');
    expect(state.sessions.get('s1')!.status).toBe('active');
  });

  it('keeps existing active session when creating another session', () => {
    const store = createTuiStore(createMockClient());
    store.dispatch({ type: 'SESSION_CREATED', payload: { id: 's1', name: 'S1' } });
    store.dispatch({ type: 'SESSION_CREATED', payload: { id: 's2', name: 'S2' } });
    // Active stays on s1 since it was first
    expect(store.getState().activeSessionId).toBe('s1');
  });

  it('switches active session', () => {
    const store = createTuiStore(createMockClient());
    store.dispatch({ type: 'SESSION_CREATED', payload: { id: 's1', name: 'S1' } });
    store.dispatch({ type: 'SESSION_CREATED', payload: { id: 's2', name: 'S2' } });
    store.dispatch({ type: 'SESSION_ACTIVATED', payload: { id: 's2' } });
    expect(store.getState().activeSessionId).toBe('s2');
  });

  it('removes a session and falls back to next available', () => {
    const store = createTuiStore(createMockClient());
    store.dispatch({ type: 'SESSION_CREATED', payload: { id: 's1', name: 'S1' } });
    store.dispatch({ type: 'SESSION_CREATED', payload: { id: 's2', name: 'S2' } });
    store.dispatch({ type: 'SESSION_ACTIVATED', payload: { id: 's1' } });
    store.dispatch({ type: 'SESSION_REMOVED', payload: { id: 's1' } });
    expect(store.getState().sessions.has('s1')).toBe(false);
    expect(store.getState().activeSessionId).toBe('s2');
  });

  it('removing last session sets activeSessionId to null', () => {
    const store = createTuiStore(createMockClient());
    store.dispatch({ type: 'SESSION_CREATED', payload: { id: 's1', name: 'S1' } });
    store.dispatch({ type: 'SESSION_REMOVED', payload: { id: 's1' } });
    expect(store.getState().activeSessionId).toBe(null);
  });

  // ---- State updates (C1.2) ----

  it('updates connection status', () => {
    const store = createTuiStore(createMockClient());
    store.dispatch({ type: 'CONNECTION_CHANGED', payload: { status: 'reconnecting' } });
    expect(store.getState().connectionStatus).toBe('reconnecting');
  });

  it('updates session status', () => {
    const store = createTuiStore(createMockClient());
    store.dispatch({ type: 'SESSION_CREATED', payload: { id: 's1', name: 'S1' } });
    store.dispatch({ type: 'SESSION_STATUS', payload: { sessionId: 's1', status: 'error' } });
    expect(store.getState().sessions.get('s1')!.status).toBe('error');
  });

  // ---- Streaming (C1.2) ----

  it('adds user message and sets session to streaming', () => {
    const store = createTuiStore(createMockClient());
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
    const store = createTuiStore(createMockClient());
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
    const store = createTuiStore(createMockClient());
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
    const store = createTuiStore(createMockClient());
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
    const store = createTuiStore(createMockClient());
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
    const store = createTuiStore(createMockClient());
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

  it('open-ended passthrough for unknown chunk types (C4.1)', () => {
    const store = createTuiStore(createMockClient());
    store.dispatch({ type: 'SESSION_CREATED', payload: { id: 's1', name: 'S1' } });
    // Unknown chunk should not throw
    expect(() => {
      store.dispatch({
        type: 'CHUNK_APPENDED',
        payload: { sessionId: 's1', chunk: { type: 'thinking', content: 'thinking...' } },
      });
    }).not.toThrow();
    // Session should still be in initial state
    expect(store.getState().sessions.get('s1')!.status).toBe('active');
  });

  // ---- Subscribe / notify ----

  it('notifies subscribers on dispatch', () => {
    const store = createTuiStore(createMockClient());
    let notified = false;
    store.subscribe(() => { notified = true; });
    store.dispatch({ type: 'CONNECTION_CHANGED', payload: { status: 'disconnected' } });
    expect(notified).toBe(true);
  });

  it('unsubscribes correctly', () => {
    const store = createTuiStore(createMockClient());
    let count = 0;
    const unsub = store.subscribe(() => { count++; });
    unsub();
    store.dispatch({ type: 'CONNECTION_CHANGED', payload: { status: 'disconnected' } });
    expect(count).toBe(0);
  });
});
