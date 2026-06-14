// @zaivim/tui — Session list panel
// Displays all active sessions with status icons. Keyboard-navigable.

import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import type { TuiClient } from '../client.js';
import type { TuiStore, SessionState, StoreAction } from '../store.js';

interface SessionListProps {
  focus: 'sessions' | 'chat';
  sessions: Map<string, SessionState>;
  activeSessionId: string | null;
  dispatch: (action: StoreAction) => void;
  client: TuiClient;
}

/** Status icon mapping (B2.3). */
function statusIcon(status: SessionState['status']): string {
  switch (status) {
    case 'streaming': return '💬';
    case 'thinking':  return '🤔';
    case 'tool':      return '🔧';
    case 'idle':      return '⏸';
    case 'done':      return '✅';
    case 'error':     return '❌';
    default:          return '💬';
  }
}

export function SessionList({ focus, sessions, activeSessionId, dispatch, client }: SessionListProps): React.JSX.Element {
  const sessionList = Array.from(sessions.values());
  const [selectedIndex, setSelectedIndex] = useState(
    activeSessionId ? sessionList.findIndex(s => s.id === activeSessionId) : 0,
  );

  // Keep selectedIndex in sync when activeSessionId changes externally
  useEffect(() => {
    if (activeSessionId) {
      const idx = sessionList.findIndex(s => s.id === activeSessionId);
      if (idx >= 0) setSelectedIndex(idx);
    }
  }, [activeSessionId, sessionList]);

  // Keyboard navigation (B2.6) — only active when this panel is focused
  useInput((input, key) => {
    if (key.upArrow) {
      setSelectedIndex(Math.max(0, selectedIndex - 1));
    } else if (key.downArrow) {
      setSelectedIndex(Math.min(sessionList.length - 1, selectedIndex + 1));
    } else if (key.return && sessionList[selectedIndex]) {
      // Enter to switch session
      dispatch({ type: 'SESSION_ACTIVATED', payload: { id: sessionList[selectedIndex].id } });
    }
  }, { isActive: focus === 'sessions' });

  if (sessionList.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold>会话</Text>
        <Box marginTop={1}>
          <Text dimColor>Ctrl+N 创建新会话</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1} minWidth={10}>
      <Text bold>Sessions</Text>
      <Box flexDirection="column" marginTop={1}>
        {sessionList.map((session, idx) => {
          const isActive = session.id === activeSessionId;
          const isSelected = idx === selectedIndex;
          const icon = statusIcon(session.status);

          return (
            <Box
              key={session.id}
              backgroundColor={isActive ? 'blue' : isSelected ? 'gray' : undefined}
            >
              <Text>
                {icon}
                {' '}
                <Text bold={isActive}>{session.name}</Text>
                {' · '}
                {session.elapsed}s
                {' · '}
                {session.tokensOut}↓
              </Text>
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>↑↓ 切换 · Enter 选中 · Ctrl+N 新建</Text>
      </Box>
    </Box>
  );
}
