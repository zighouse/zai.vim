// @zaivim/tui — Main App component
// Wires the store to ink/React rendering.
// Phase D (AC7-9): command routing, independent scroll state, status bar text.

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { render, Box, Text, useInput } from 'ink';
import type { TuiClient } from './client.js';
import type { TuiStore } from './store.js';
import { Layout } from './components/layout.js';
import { SessionList } from './components/session-list.js';
import { ChatArea } from './components/chat-area.js';
import { executeCommandLine, type CommandContext, type CommandResult } from './command.js';

// ---- App component ---------------------------------------------------------

interface AppProps {
  store: TuiStore;
  client: TuiClient;
}

function App({ store, client }: AppProps) {
  const [state, setState] = useState(store.getState());
  const [focus, setFocus] = useState<'sessions' | 'chat'>('chat');
  const [chatScrollOffset, setChatScrollOffset] = useState(0);
  const [sessionListScrollOffset, setSessionListScrollOffset] = useState(0);
  const [commandFeedback, setCommandFeedback] = useState<string | null>(null);

  useEffect(() => {
    return store.subscribe(() => setState(store.getState()));
  }, [store]);

  const handleExit = useCallback(() => {
    // Trigger cleanup — will be caught by shutdown handlers in index.ts
    process.emit('SIGINT', 'SIGINT');
  }, []);

  // ---- Command context ----------------------------------------------------
  const commandContext: CommandContext = useMemo(
    () => ({
      sessions: state.sessions,
      activeSessionId: state.activeSessionId,
      dispatch: store.dispatch,
      scrollMessages: (dir, step = 1) => {
        setChatScrollOffset((prev) =>
          dir === 'up' ? prev + step
            : dir === 'down' ? Math.max(0, prev - step)
            : dir === 'top' ? Infinity
            : 0,  // bottom
        );
      },
      scrollSessionList: (dir, step = 1) => {
        setSessionListScrollOffset((prev) =>
          dir === 'up' ? Math.max(0, prev - step)
            : dir === 'down' ? prev + step
            : dir === 'top' ? 0
            : Infinity,  // bottom
        );
      },
      onExit: handleExit,
    }),
    [state.sessions, state.activeSessionId, store, handleExit],
  );

  const executeCommand = useCallback(
    (line: string): CommandResult => {
      const result = executeCommandLine(line, commandContext);
      setCommandFeedback(result.message ?? null);
      return result;
    },
    [commandContext],
  );

  // ---- Status bar text ----------------------------------------------------
  const sessionOrder = useMemo(
    () => Array.from(state.sessions.values()),
    [state.sessions],
  );
  const activeIdx = state.activeSessionId
    ? sessionOrder.findIndex((s) => s.id === state.activeSessionId)
    : -1;
  const activeSession = state.activeSessionId
    ? state.sessions.get(state.activeSessionId)
    : undefined;
  const statusText = activeSession
    ? `[${activeIdx + 1}/${sessionOrder.length}] ${activeSession.name} · ${activeSession.status} · ${activeSession.tokensOut}↓`
    : sessionOrder.length > 0
      ? `[0/${sessionOrder.length}] no active session`
      : '[0/0] Ctrl+N to create';

  // ---- Auto-scroll chat to bottom on new message -------------------------
  const msgCount = activeSession?.messages.length ?? 0;
  useEffect(() => {
    setChatScrollOffset(0);
  }, [msgCount, state.activeSessionId]);

  // Tab to cycle focus between panels; Ctrl+N always creates a new session
  useInput(async (_input, key) => {
    if (key.tab) {
      setFocus((f) => (f === 'sessions' ? 'chat' : 'sessions'));
    } else if (key.ctrl && _input === 'n') {
      try {
        const result = await client.send('session.create') as { sessionId: string };
        const name = `Session ${store.getState().sessions.size + 1}`;
        store.dispatch({ type: 'SESSION_CREATED', payload: { id: result.sessionId, name } });
        store.dispatch({ type: 'SESSION_ACTIVATED', payload: { id: result.sessionId } });
      } catch {
        // Session creation failed silently
      }
    }
  });

  if (state.connectionStatus === 'disconnected') {
    return (
      <Box>
        <Text color="red">Connection to engine lost. Exiting...</Text>
      </Box>
    );
  }

  return (
    <Layout focus={focus} statusText={statusText}>
      <SessionList
        focus={focus}
        sessions={state.sessions}
        activeSessionId={state.activeSessionId}
        dispatch={store.dispatch}
        client={client}
        scrollOffset={sessionListScrollOffset}
        onScrollChange={setSessionListScrollOffset}
      />
      <ChatArea
        focus={focus}
        sessions={state.sessions}
        activeSessionId={state.activeSessionId}
        dispatch={store.dispatch}
        client={client}
        onExit={handleExit}
        scrollOffset={chatScrollOffset}
        onScrollChange={setChatScrollOffset}
        onExecuteCommand={executeCommand}
        commandFeedback={commandFeedback}
      />
    </Layout>
  );
}

// ---- render helper --------------------------------------------------------

interface RenderResult {
  waitUntilExit: () => Promise<void>;
}

export function renderTuiApp(
  store: TuiStore,
  client: TuiClient,
): RenderResult {
  const { waitUntilExit } = render(
    <App store={store} client={client} />,
  );
  return { waitUntilExit };
}
