// @zaivim/tui — Multi-session state management store
// Drives UI re-renders through a subscribe/notify pattern compatible with ink/React.

import type { ChatChunk, ConnectionStatus } from './client.js';
import type { SessionPhase } from '@zaivim/core';

// ---- Types -------------------------------------------------------------------

export interface MessageState {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
  isStreaming: boolean;
}

export type SessionStatus = 'active' | 'streaming' | 'thinking' | 'tool' | 'idle' | 'error' | 'done';

export interface SessionState {
  id: string;
  name: string;
  status: SessionStatus;
  messages: MessageState[];
  elapsed: number;
  tokensOut: number;
  /** Reserved for Story 4.2.1. */
  thinkingRing?: string;
  tokensIn?: number;
  elapsedMs?: number;
  speed?: number;
  /** Story 5.5: tightened from string? to SessionPhase literal union. */
  phase?: SessionPhase;
}

export interface TuiState {
  sessions: Map<string, SessionState>;
  activeSessionId: string | null;
  connectionStatus: ConnectionStatus;
}

// ---- Actions ----------------------------------------------------------------

export type StoreAction =
  | { type: 'SESSION_CREATED'; payload: { id: string; name: string } }
  | { type: 'SESSION_REMOVED'; payload: { id: string } }
  | { type: 'SESSION_ACTIVATED'; payload: { id: string } }
  | { type: 'MESSAGE_ADDED'; payload: { sessionId: string; message: MessageState } }
  | { type: 'CHUNK_APPENDED'; payload: { sessionId: string; chunk: ChatChunk } }
  | { type: 'CHUNKS_APPENDED'; payload: { sessionId: string; chunks: ChatChunk[] } }
  | { type: 'STREAM_START'; payload: { sessionId: string } }
  | { type: 'STREAM_END'; payload: { sessionId: string } }
  | { type: 'STREAM_ERROR'; payload: { sessionId: string; error: string } }
  | { type: 'CONNECTION_CHANGED'; payload: { status: ConnectionStatus } }
  | { type: 'SESSION_STATUS'; payload: { sessionId: string; status: SessionStatus } };

// ---- Reducer ----------------------------------------------------------------

function createInitialState(): TuiState {
  return {
    sessions: new Map(),
    activeSessionId: null,
    connectionStatus: 'connected',
  };
}

function reducer(state: TuiState, action: StoreAction): TuiState {
  const sessions = new Map(state.sessions);

  switch (action.type) {
    case 'SESSION_CREATED': {
      const { id, name } = action.payload;
      if (sessions.has(id)) return state;
      sessions.set(id, {
        id, name, status: 'active',
        messages: [], elapsed: 0, tokensOut: 0,
      });
      return { ...state, sessions, activeSessionId: state.activeSessionId ?? id };
    }

    case 'SESSION_REMOVED': {
      sessions.delete(action.payload.id);
      const activeSessionId =
        state.activeSessionId === action.payload.id
          ? sessions.size > 0 ? sessions.keys().next().value ?? null : null
          : state.activeSessionId;
      return { ...state, sessions, activeSessionId };
    }

    case 'SESSION_ACTIVATED': {
      return { ...state, activeSessionId: action.payload.id };
    }

    case 'MESSAGE_ADDED': {
      const { sessionId, message } = action.payload;
      const session = sessions.get(sessionId);
      if (!session) return state;
      sessions.set(sessionId, {
        ...session,
        messages: [...session.messages, message],
        status: message.role === 'user' ? 'streaming' : session.status,
      });
      return { ...state, sessions };
    }

    case 'STREAM_START': {
      const session = sessions.get(action.payload.sessionId);
      if (!session) return state;
      sessions.set(action.payload.sessionId, { ...session, status: 'streaming' });
      return { ...state, sessions };
    }

    case 'STREAM_END': {
      const session = sessions.get(action.payload.sessionId);
      if (!session) return state;
      const msgs = finalizeMessage(session.messages);
      sessions.set(action.payload.sessionId, {
        ...session, messages: msgs, status: 'idle', elapsed: 0,
      });
      return { ...state, sessions };
    }

    case 'STREAM_ERROR': {
      const session = sessions.get(action.payload.sessionId);
      if (!session) return state;
      const msgs = finalizeMessage(session.messages);
      sessions.set(action.payload.sessionId, { ...session, messages: msgs, status: 'error' });
      return { ...state, sessions };
    }

    case 'CHUNK_APPENDED': {
      const { sessionId, chunk } = action.payload;
      const session = sessions.get(sessionId);
      if (!session) return state;
      const result = applyChunkToMessages(session.messages, chunk);

      // `done` chunk finalizes without mutating messages further
      if (chunk.type === 'done') {
        const msgs = finalizeMessage(session.messages);
        sessions.set(sessionId, { ...session, messages: msgs });
        return { ...state, sessions };
      }

      // Story 5.5 (AC9): fill reserved fields for thinking/stats/phase chunks
      let extraTokensOut = 0;
      const extras: Partial<Pick<SessionState, 'thinkingRing' | 'tokensIn' | 'elapsedMs' | 'speed' | 'phase'>> = {};
      if (chunk.type === 'thinking') {
        extras.thinkingRing = (session.thinkingRing ?? '') + ((chunk.content as string) ?? '');
      } else if (chunk.type === 'stats') {
        extras.tokensIn = (chunk.tokensIn as number);
        extraTokensOut = (chunk.tokensOut as number) || 0;
        extras.elapsedMs = (chunk.elapsedMs as number);
        extras.speed = (chunk.speed as number);
      } else if (chunk.type === 'phase') {
        extras.phase = chunk.phase as SessionPhase;
      }

      sessions.set(sessionId, {
        ...session,
        messages: result.messages,
        tokensOut: session.tokensOut + result.tokenDelta + extraTokensOut,
        ...extras,
      });
      return { ...state, sessions };
    }

    case 'CHUNKS_APPENDED': {
      const { sessionId, chunks } = action.payload;
      const session = sessions.get(sessionId);
      if (!session || chunks.length === 0) return state;

      let messages = session.messages;
      let tokensOut = session.tokensOut;
      let lastWasDone = false;
      const extras: Partial<Pick<SessionState, 'thinkingRing' | 'tokensIn' | 'elapsedMs' | 'speed' | 'phase'>> = {};
      for (const chunk of chunks) {
        if (chunk.type === 'done') {
          lastWasDone = true;
          continue;
        }
        // Story 5.5 (AC9): accumulate thinking/stats/phase session state
        if (chunk.type === 'thinking') {
          extras.thinkingRing = (extras.thinkingRing ?? session.thinkingRing ?? '') + ((chunk.content as string) ?? '');
          continue;
        }
        if (chunk.type === 'stats') {
          extras.tokensIn = (chunk.tokensIn as number);
          const addedOut = (chunk.tokensOut as number) || 0;
          tokensOut += addedOut;
          extras.elapsedMs = (chunk.elapsedMs as number);
          extras.speed = (chunk.speed as number);
          continue;
        }
        if (chunk.type === 'phase') {
          extras.phase = chunk.phase as SessionPhase;
          continue;
        }
        const r = applyChunkToMessages(messages, chunk);
        messages = r.messages;
        tokensOut += r.tokenDelta;
      }
      if (lastWasDone) {
        messages = finalizeMessage(messages);
      }
      sessions.set(sessionId, { ...session, messages, tokensOut, ...extras });
      return { ...state, sessions };
    }

    case 'CONNECTION_CHANGED': {
      return { ...state, connectionStatus: action.payload.status };
    }

    case 'SESSION_STATUS': {
      const session = sessions.get(action.payload.sessionId);
      if (!session) return state;
      sessions.set(action.payload.sessionId, { ...session, status: action.payload.status });
      return { ...state, sessions };
    }

    default:
      return state;
  }
}

/** Finalize last streaming message. */
function finalizeMessage(messages: MessageState[]): MessageState[] {
  const last = messages[messages.length - 1];
  if (last?.isStreaming) {
    const copy = [...messages];
    copy[copy.length - 1] = { ...last, isStreaming: false };
    return copy;
  }
  return messages;
}

/**
 * Apply a single chunk to a messages array. Returns the new array and the
 * token delta to accumulate. Used by both CHUNK_APPENDED and CHUNKS_APPENDED.
 *
 * Note: `done` chunks are handled by the caller via finalizeMessage() because
 * they don't mutate the array, they only flip the last message's isStreaming.
 */
function applyChunkToMessages(
  messages: MessageState[],
  chunk: ChatChunk,
): { messages: MessageState[]; tokenDelta: number } {
  const next = [...messages];

  switch (chunk.type) {
    case 'text': {
      const textContent = (chunk.content as string) ?? '';
      const last = next[next.length - 1];
      if (last?.role === 'assistant' && last.isStreaming) {
        next[next.length - 1] = { ...last, content: last.content + textContent };
      } else {
        next.push({
          id: `chunk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          role: 'assistant',
          content: textContent,
          createdAt: Date.now(),
          isStreaming: true,
        });
      }
      return { messages: next, tokenDelta: textContent.length };
    }
    case 'tool_call': {
      const toolName = (chunk.name as string) ?? 'unknown';
      next.push({
        id: `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        role: 'assistant',
        content: `📎 使用了 ${toolName} 工具`,
        createdAt: Date.now(),
        isStreaming: false,
      });
      return { messages: next, tokenDelta: 0 };
    }
    case 'tool_result': {
      const resultStatus = (chunk.status as string) ?? 'ok';
      next.push({
        id: `result-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        role: 'assistant',
        content: `📥 ${resultStatus}`,
        createdAt: Date.now(),
        isStreaming: false,
      });
      return { messages: next, tokenDelta: 0 };
    }
    case 'error': {
      const errMsg = (chunk.message as string) ?? 'Unknown error';
      next.push({
        id: `error-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        role: 'assistant',
        content: `❌ ${errMsg}`,
        createdAt: Date.now(),
        isStreaming: false,
      });
      return { messages: next, tokenDelta: 0 };
    }
    case 'thinking': {
      // Story 4.2.1: thinking content stored in extras.thinkingRing in reducer.
      // If this path is hit via CHUNK_APPENDED (single chunk), create a message
      // entry so the content is visible in the message list.
      const thinkContent = (chunk.content as string) ?? '';
      if (!thinkContent) return { messages: next, tokenDelta: 0 };
      const last = next[next.length - 1];
      if (last?.role === 'assistant' && last.isStreaming && last.content.startsWith('> 🤔')) {
        next[next.length - 1] = { ...last, content: last.content + thinkContent };
      } else {
        next.push({
          id: `think-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          role: 'assistant',
          content: `> 🤔 ${thinkContent}`,
          createdAt: Date.now(),
          isStreaming: true,
        });
      }
      return { messages: next, tokenDelta: 0 };
    }
    case 'stats': {
      // Story 4.2.1: stats stored in extras in reducer — no message entry needed.
      return { messages: next, tokenDelta: 0 };
    }
    case 'phase': {
      // Story 4.2.1: phase stored in extras.phase in reducer — no message entry needed.
      return { messages: next, tokenDelta: 0 };
    }
    default: {
      // C4.1: Open-ended passthrough — unknown chunk types pass through
      // Reserved for Story 4.2.1: thinking, stats, phase chunks
      return { messages: next, tokenDelta: 0 };
    }
  }
}

// ---- Store ----------------------------------------------------------------

export interface TuiStore {
  getState(): TuiState;
  dispatch(action: StoreAction): void;
  subscribe(listener: () => void): () => void;
}

export function createTuiStore(): TuiStore {
  let state = createInitialState();
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const listener of listeners) {
      try { listener(); } catch { /* isolated */ }
    }
  }

  return {
    getState(): TuiState { return state; },

    dispatch(action: StoreAction): void {
      state = reducer(state, action);
      notify();
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
