// @zaivim/tui — Session list panel
// Displays all active sessions with status icons. Keyboard-navigable.
// Independent scroll via scrollOffset prop (Phase D, AC8).

import React, { useState, useEffect, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import type { TuiClient } from '../client.js';
import type { TuiStore, SessionState, StoreAction } from '../store.js';

interface SessionListProps {
  focus: 'sessions' | 'chat';
  sessions: Map<string, SessionState>;
  activeSessionId: string | null;
  dispatch: (action: StoreAction) => void;
  client: TuiClient;
  scrollOffset: number;
  onScrollChange: (offset: number) => void;
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

export function SessionList({
  focus,
  sessions,
  activeSessionId,
  dispatch,
  client,
  scrollOffset,
  onScrollChange,
}: SessionListProps): React.JSX.Element {
  const sessionList = useMemo(() => Array.from(sessions.values()), [sessions]);
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

  // Keep scrollOffset within bounds
  useEffect(() => {
    const max = Math.max(0, sessionList.length - 1);
    if (scrollOffset > max) onScrollChange(max);
  }, [sessionList.length, scrollOffset, onScrollChange]);

  // Keyboard navigation (B2.6) — only active when this panel is focused
  useInput((_input, key) => {
    if (key.upArrow) {
      const next = Math.max(0, selectedIndex - 1);
      setSelectedIndex(next);
      if (next < scrollOffset) onScrollChange(next);
    } else if (key.downArrow) {
      const next = Math.min(sessionList.length - 1, selectedIndex + 1);
      setSelectedIndex(next);
      // Auto-scroll the list when selection moves below current view
      // (each item is 1 line; approximate visible window by simple offset)
      if (next > scrollOffset) onScrollChange(next);
    } else if (key.return && sessionList[selectedIndex]) {
      // Enter to switch session
      dispatch({ type: 'SESSION_ACTIVATED', payload: { id: sessionList[selectedIndex]!.id } });
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

  // Render only items at or beyond scrollOffset (each item is 1 line)
  const visibleSessions = sessionList.slice(scrollOffset);

  return (
    <Box flexDirection="column" paddingX={1} minWidth={10} height="100%" overflowY="hidden">
      <Text bold>Sessions</Text>
      <Box flexDirection="column" marginTop={1}>
        {visibleSessions.map((session, idx) => {
          const actualIdx = idx + scrollOffset;
          const isActive = session.id === activeSessionId;
          const isSelected = actualIdx === selectedIndex;
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
        <Text dimColor>:s n/p 切换 · :h 帮助</Text>
      </Box>
    </Box>
  );
}

// Re-export store type for prop typing convenience
export type { TuiStore };
