// @zaivim/tui — Chat area: message list + input
// Displays messages for the active session and handles user input.

import React, { useState, useRef, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import type { EngineAPI } from '@zaivim/core';
import type { TuiClient } from '../client.js';
import type { SessionState, MessageState, StoreAction } from '../store.js';
import { sanitizeForTerminal } from '../sanitize.js';

interface ChatAreaProps {
  focus: 'sessions' | 'chat';
  sessions: Map<string, SessionState>;
  activeSessionId: string | null;
  dispatch: (action: StoreAction) => void;
  client: TuiClient;
  engine: EngineAPI;
  onExit: () => void;
}

// ---- ChatMessage component -------------------------------------------------

interface ChatMessageProps {
  message: MessageState;
}

function ChatMessage({ message }: ChatMessageProps): React.JSX.Element {
  const safeContent = sanitizeForTerminal(message.content, {
    stripAnsi: true,
    stripControl: true,
  });

  if (message.role === 'user') {
    return (
      <Box>
        <Text color="green">&gt; </Text>
        <Text>{safeContent}</Text>
        {message.isStreaming && <Text color="yellow">▌</Text>}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="blue">AI </Text>
        <Text>{safeContent}</Text>
        {message.isStreaming && <Text color="yellow">▌</Text>}
      </Box>
    </Box>
  );
}

// ---- ChatArea component ----------------------------------------------------

export function ChatArea({
  focus,
  sessions,
  activeSessionId,
  dispatch,
  client,
  onExit,
}: ChatAreaProps): React.JSX.Element {
  const activeSession = activeSessionId ? sessions.get(activeSessionId) : undefined;
  const messages = activeSession?.messages ?? [];
  const [input, setInput] = useState('');
  const [isSending, setIsSending] = useState(false);

  // Send a chat message
  const sendMessage = useCallback(async (text: string): Promise<void> => {
    if (!activeSessionId || !text.trim() || isSending) return;

    const sessionId = activeSessionId;
    const trimmed = text.trim();
    setInput('');
    setIsSending(true);

    dispatch({
      type: 'MESSAGE_ADDED',
      payload: {
        sessionId,
        message: {
          id: `user-${Date.now()}`,
          role: 'user',
          content: trimmed,
          createdAt: Date.now(),
          isStreaming: false,
        },
      },
    });

    dispatch({ type: 'STREAM_START', payload: { sessionId } });

    try {
      const stream = client.chat(sessionId, trimmed);
      for await (const chunk of stream) {
        dispatch({ type: 'CHUNK_APPENDED', payload: { sessionId, chunk } });
      }
      dispatch({ type: 'STREAM_END', payload: { sessionId } });
    } catch (err) {
      dispatch({
        type: 'STREAM_ERROR',
        payload: { sessionId, error: (err as Error).message },
      });
    } finally {
      setIsSending(false);
    }
  }, [activeSessionId, isSending, dispatch, client]);

  // All keyboard input goes through one hook — only when this panel is focused
  useInput((inputChar, key) => {
    if (focus !== 'chat') return;

    if (key.ctrl && inputChar === 'c') {
      // Ctrl+C — let ink handle default behavior
      return;
    }

    if (key.return) {
      if (input === ':q') {
        setInput('');
        onExit();
        input.handled = true;
        return;
      }
      if (input.trim() && !isSending) {
        sendMessage(input);
      }
      input.handled = true;
      return;
    }

    if (key.backspace || key.delete) {
      setInput(prev => prev.slice(0, -1));
      input.handled = true;
      return;
    }

    // Printable character
    if (inputChar && inputChar.length === 1 && inputChar.charCodeAt(0) >= 0x20) {
      setInput(prev => prev + inputChar);
      input.handled = true;
    }
  });

  // No session selected
  if (!activeSessionId) {
    return (
      <Box flexDirection="column" alignItems="center" justifyContent="center" height="100%">
        <Text>No active session</Text>
        <Text dimColor>Ctrl+N 创建新会话</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" height="100%">
      {/* Header */}
      <Box borderStyle="single" borderColor="gray" paddingX={1}>
        <Text bold>{activeSession?.name ?? activeSessionId}</Text>
        {activeSession?.status === 'streaming' && <Text color="yellow"> (streaming...)</Text>}
      </Box>

      {/* Messages area */}
      <Box flexGrow={1} flexDirection="column" overflowY="hidden" paddingX={1} paddingY={1}>
        {messages.length === 0 ? (
          <Box alignItems="center" justifyContent="center" height="100%">
            <Text dimColor>输入消息开始对话</Text>
          </Box>
        ) : (
          messages.map((msg) => (
            <ChatMessage key={msg.id} message={msg} />
          ))
        )}
      </Box>

      {/* Input area */}
      <Box borderStyle="single" borderColor="gray" paddingX={1}>
        <Text color="green">&gt; </Text>
        <Text>{input || <Text dimColor>输入消息...</Text>}</Text>
        {!isSending && <Text color="cyan">▌</Text>}
        {isSending && <Text color="yellow"> (sending...)</Text>}
      </Box>

      {/* Status bar */}
      <Box>
        <Text dimColor>
          {activeSession
            ? `tokens: ${activeSession.tokensOut} ↓`
            : ''
          }
          {' · Enter 发送 · :q 退出'}
        </Text>
      </Box>
    </Box>
  );
}
