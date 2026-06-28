// @zaivim/tui — Chat area: message list + input
// Displays messages for the active session and handles user input.
// Command mode (: prefix) and message scrolling added in Phase D (AC7/AC8).

import React, { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import type { TuiClient } from '../client.js';
import type { SessionState, MessageState, StoreAction } from '../store.js';
import type { CommandResult } from '../command.js';
import { sanitizeForTerminal } from '../sanitize.js';

interface ChatAreaProps {
  focus: 'sessions' | 'chat';
  sessions: Map<string, SessionState>;
  activeSessionId: string | null;
  dispatch: (action: StoreAction) => void;
  client: TuiClient;
  onExit: () => void;
  scrollOffset: number;
  onScrollChange: (offset: number) => void;
  onExecuteCommand: (line: string) => CommandResult;
  commandFeedback: string | null;
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
  scrollOffset,
  onScrollChange,
  onExecuteCommand,
  commandFeedback,
}: ChatAreaProps): React.JSX.Element {
  const activeSession = activeSessionId ? sessions.get(activeSessionId) : undefined;
  const messages = activeSession?.messages ?? [];
  const [input, setInput] = useState('');
  const [isSending, setIsSending] = useState(false);

  const isCommandMode = input.startsWith(':');

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

  // All keyboard input goes through one hook — only active when this panel is focused
  useInput((inputChar, key) => {
    if (key.ctrl) {
      // Ctrl+letter combos (Ctrl+N, Ctrl+C) are handled at App level
      return;
    }

    if (key.return) {
      if (isCommandMode) {
        const result = onExecuteCommand(input);
        // Command failure still clears input so user can retry
        // (error message surfaces via commandFeedback)
        if (result.ok || result.message) setInput('');
        else setInput('');
        return;
      }
      if (input.trim() && !isSending) {
        sendMessage(input);
      }
      return;
    }

    if (key.backspace || key.delete) {
      setInput(prev => prev.slice(0, -1));
      return;
    }

    if (key.upArrow && isCommandMode) {
      onScrollChange(scrollOffset + 1);
      return;
    }
    if (key.downArrow && isCommandMode) {
      onScrollChange(Math.max(0, scrollOffset - 1));
      return;
    }

    // Printable character (including CJK multi-character IME composition)
    if (inputChar && inputChar.charCodeAt(0) >= 0x20) {
      setInput(prev => prev + inputChar);
    }
  }, { isActive: focus === 'chat' });

  // No session selected
  if (!activeSessionId) {
    return (
      <Box flexDirection="column" alignItems="center" justifyContent="center" height="100%">
        <Text>No active session</Text>
        <Text dimColor>Ctrl+N 创建新会话</Text>
      </Box>
    );
  }

  // Compute visible messages: scrollOffset hides N most-recent messages
  // (0 = all visible / newest at bottom; >0 = scroll back through history)
  const clampedOffset = Math.min(scrollOffset, Math.max(0, messages.length - 1));
  const visibleMessages = clampedOffset > 0
    ? messages.slice(0, Math.max(0, messages.length - clampedOffset))
    : messages;

  return (
    <Box flexDirection="column" height="100%">
      {/* Header */}
      <Box borderStyle="single" borderColor="gray" paddingX={1}>
        <Text bold>{activeSession?.name ?? activeSessionId}</Text>
        {activeSession?.status === 'streaming' && <Text color="yellow"> (streaming...)</Text>}
        {clampedOffset > 0 && <Text color="magenta"> ↑{clampedOffset}</Text>}
      </Box>

      {/* Messages area — independently scrollable */}
      <Box flexGrow={1} flexDirection="column" overflowY="hidden" paddingX={1} paddingY={1}>
        {visibleMessages.length === 0 ? (
          <Box alignItems="center" justifyContent="center" height="100%">
            <Text dimColor>输入消息开始对话</Text>
          </Box>
        ) : (
          visibleMessages.map((msg) => (
            <ChatMessage key={msg.id} message={msg} />
          ))
        )}
      </Box>

      {/* Command feedback (transient) */}
      {commandFeedback && (
        <Box paddingX={1}>
          <Text color={isCommandMode ? 'cyan' : 'yellow'} wrap="truncate">
            {commandFeedback.length > 200
              ? commandFeedback.slice(0, 200) + '…'
              : commandFeedback}
          </Text>
        </Box>
      )}

      {/* Input area — visual indicator distinguishes command mode */}
      <Box borderStyle="single" borderColor={isCommandMode ? 'cyan' : 'gray'} paddingX={1}>
        <Text color={isCommandMode ? 'cyan' : 'green'}>{isCommandMode ? ':' : '>'} </Text>
        <Text>{isCommandMode ? input.slice(1) : (input || <Text dimColor>输入消息或 :命令...</Text>)}</Text>
        {!isSending && <Text color="cyan">▌</Text>}
        {isSending && <Text color="yellow"> (sending...)</Text>}
      </Box>

      {/* Hint bar */}
      <Box>
        <Text dimColor>
          {isCommandMode
            ? 'Enter 执行 · ↑↓ 滚动 · :h 帮助'
            : 'Enter 发送 · : 进入命令模式'}
        </Text>
      </Box>
    </Box>
  );
}
