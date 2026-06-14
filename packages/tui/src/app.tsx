// @zaivim/tui — Main App component
// Wires the store to ink/React rendering.

import React, { useState, useEffect, useCallback } from 'react';
import { render, Box, Text } from 'ink';
import type { EngineAPI } from '@zaivim/core';
import type { TuiClient } from './client.js';
import type { TuiStore } from './store.js';
import { Layout } from './components/layout.js';
import { SessionList } from './components/session-list.js';
import { ChatArea } from './components/chat-area.js';

// ---- App component ---------------------------------------------------------

interface AppProps {
  store: TuiStore;
  client: TuiClient;
  engine: EngineAPI;
}

function App({ store, client, engine }: AppProps) {
  const [state, setState] = useState(store.getState());

  useEffect(() => {
    return store.subscribe(() => setState(store.getState()));
  }, [store]);

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
    <Layout>
      <SessionList
        sessions={state.sessions}
        activeSessionId={state.activeSessionId}
        dispatch={store.dispatch}
        client={client}
      />
      <ChatArea
        sessions={state.sessions}
        activeSessionId={state.activeSessionId}
        dispatch={store.dispatch}
        client={client}
        engine={engine}
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
  engine: EngineAPI,
): RenderResult {
  const { waitUntilExit } = render(
    <App store={store} client={client} engine={engine} />,
  );
  return { waitUntilExit };
}
