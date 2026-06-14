// @zaivim/tui — Main App component
// Wires the store to ink/React rendering.

import React, { useState, useEffect, useCallback } from 'react';
import { render, Box, Text, useInput } from 'ink';
import type { TuiClient } from './client.js';
import type { TuiStore } from './store.js';
import { Layout } from './components/layout.js';
import { SessionList } from './components/session-list.js';
import { ChatArea } from './components/chat-area.js';

// ---- App component ---------------------------------------------------------

interface AppProps {
  store: TuiStore;
  client: TuiClient;
}

function App({ store, client }: AppProps) {
  const [state, setState] = useState(store.getState());
  const [focus, setFocus] = useState<'sessions' | 'chat'>('chat');

  useEffect(() => {
    return store.subscribe(() => setState(store.getState()));
  }, [store]);

  // Tab to cycle focus between panels; Ctrl+N always creates a new session
  useInput(async (_input, key) => {
    if (key.tab) {
      setFocus(f => (f === 'sessions' ? 'chat' : 'sessions'));
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

  const handleExit = useCallback(() => {
    // Trigger cleanup — will be caught by shutdown handlers in index.ts
    process.emit('SIGINT', 'SIGINT');
  }, []);

  if (state.connectionStatus === 'disconnected') {
    return (
      <Box>
        <Text color="red">Connection to engine lost. Exiting...</Text>
      </Box>
    );
  }

  return (
    <Layout focus={focus}>
      <SessionList
        focus={focus}
        sessions={state.sessions}
        activeSessionId={state.activeSessionId}
        dispatch={store.dispatch}
        client={client}
      />
      <ChatArea
        focus={focus}
        sessions={state.sessions}
        activeSessionId={state.activeSessionId}
        dispatch={store.dispatch}
        client={client}
        onExit={handleExit}
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
