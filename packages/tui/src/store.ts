// @zaivim/tui — Multi-session state management store
// Drives UI re-renders through a subscribe/notify pattern compatible with ink/React.

import type { ChatChunk, ConnectionStatus } from './client.js';

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
  phase?: string;
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
      const messages = [...session.messages];

      switch (chunk.type) {
        case 'text': {
          const textContent = (chunk.content as string) ?? '';
          const last = messages[messages.length - 1];
          if (last?.role === 'assistant' && last.isStreaming) {
            messages[messages.length - 1] = { ...last, content: last.content + textContent };
          } else {
            messages.push({
              id: `chunk-${Date.now()}`,
              role: 'assistant',
              content: textContent,
              createdAt: Date.now(),
              isStreaming: true,
            });
          }
          break;
        }
        case 'tool_call': {
          const toolName = (chunk.name as string) ?? 'unknown';
          messages.push({
            id: `tool-${Date.now()}`,
            role: 'assistant',
            content: `📎 使用了 ${toolName} 工具`,
            createdAt: Date.now(),
            isStreaming: false,
          });
          break;
        }
        case 'tool_result': {
          const resultStatus = (chunk.status as string) ?? 'ok';
          messages.push({
            id: `result-${Date.now()}`,
            role: 'assistant',
            content: `📥 ${resultStatus}`,
            createdAt: Date.now(),
            isStreaming: false,
          });
          break;
        }
        case 'error': {
          const errMsg = (chunk.message as string) ?? 'Unknown error';
          messages.push({
            id: `error-${Date.now()}`,
            role: 'assistant',
            content: `❌ ${errMsg}`,
            createdAt: Date.now(),
            isStreaming: false,
          });
          break;
        }
        case 'done': {
          // Finalize last streaming message
          const msgs = finalizeMessage(session.messages);
          sessions.set(sessionId, { ...session, messages: msgs });
          return { ...state, sessions };
        }
        default: {
          // C4.1: Open-ended passthrough — unknown chunk types pass through
          // Reserved for Story 4.2.1: thinking, stats, phase chunks
          break;
        }
      }

      const tokenDelta = chunk.type === 'text' ? ((chunk.content as string) ?? '').length : 0;
      sessions.set(sessionId, {
        ...session,
        messages,
        tokensOut: session.tokensOut + tokenDelta,
      });
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
