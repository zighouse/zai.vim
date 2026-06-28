// @zaivim/tui — Chat area: message list + input
// Displays messages for the active session and handles user input.
// Command mode (: prefix) and message scrolling added in Phase D (AC7/AC8).

import React, { useState, useCallback } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import type { TuiClient, ChatChunk } from '../client.js';
import type { SessionState, MessageState, StoreAction } from '../store.js';
import type { CommandResult } from '../command.js';
import { sanitizeForTerminal } from '../sanitize.js';

/** Chunk batching window — collect chunks for this many ms before re-rendering. */
const CHUNK_FLUSH_MS = 100;
/**
 * Lines consumed by ChatArea chrome (header border, input border, hint,
 * paddings). Used to compute an explicit message-area height so streaming
 * content can never push the layout beyond the terminal viewport.
 */
const CHAT_CHROME_LINES = 8;
/** Lines consumed outside ChatArea (status bar + outer panel border). */
const OUTER_CHROME_LINES = 3;

// ---- Visible-window computation --------------------------------------------
// Ink clips Box content at the bottom when it overflows the explicit height.
// Rendering all messages therefore hides the newest output — the opposite of
// what a chat UI needs. We flatten all messages into wrapped lines, then pick
// a `height`-line window ending `scrollOffset` lines from the bottom. This
// lets `:sc up` walk through a long assistant response line-by-line instead
// of jumping past it to the user message above.

/** Effective text width inside the chat panel.
 * Right panel is 70% of terminal; subtract border (2) + paddingX (2) + AI/user prefix (~4). */
function chatContentWidth(columns: number): number {
  return Math.max(10, Math.floor(columns * 0.7) - 8);
}

/** Estimate terminal lines a message occupies after wrapping. */
function estimateMessageLines(message: MessageState, columns: number): number {
  const usable = chatContentWidth(columns);
  const content = message.content || '';
  let lines = 0;
  for (const para of content.split('\n')) {
    lines += para.length === 0 ? 1 : Math.ceil(para.length / usable);
  }
  return Math.max(1, lines);
}

/** One wrapped line of a message, tracked back to its source message. */
interface FlatLine {
  msgIdx: number;
  text: string;
}

/** Flatten all messages into wrapped lines, preserving message ownership. */
function flattenMessages(messages: MessageState[], columns: number): FlatLine[] {
  const usable = chatContentWidth(columns);
  const out: FlatLine[] = [];
  messages.forEach((msg, msgIdx) => {
    const content = msg.content || '';
    for (const para of content.split('\n')) {
      if (para.length === 0) {
        out.push({ msgIdx, text: '' });
      } else {
        for (let i = 0; i < para.length; i += usable) {
          out.push({ msgIdx, text: para.slice(i, i + usable) });
        }
      }
    }
  });
  return out;
}

/**
 * Pick the lines that fit in `height`, ending `scrollOffset` lines from the
 * bottom. scrollOffset is in LINES (0 = stick to newest; >0 = scrolled back).
 * Returns messages whose content has been truncated to just the visible lines.
 */
function computeVisibleMessages(
  messages: MessageState[],
  height: number,
  scrollOffset: number,
  columns: number,
): MessageState[] {
  if (messages.length === 0 || height < 1) return [];

  const flat = flattenMessages(messages, columns);
  if (flat.length === 0) return [];

  const endLineIdx = Math.max(0, flat.length - 1 - scrollOffset);
  const startLineIdx = Math.max(0, endLineIdx - height + 1);

  const visibleByMsg = new Map<number, string[]>();
  for (let i = startLineIdx; i <= endLineIdx; i++) {
    const line = flat[i]!;
    if (!visibleByMsg.has(line.msgIdx)) visibleByMsg.set(line.msgIdx, []);
    visibleByMsg.get(line.msgIdx)!.push(line.text);
  }

  const result: MessageState[] = [];
  for (let m = 0; m < messages.length; m++) {
    if (visibleByMsg.has(m)) {
      result.push({ ...messages[m]!, content: visibleByMsg.get(m)!.join('\n') });
    }
  }
  return result;
}

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

const phaseIcons: Record<string, string> = {
  request: '📤', thinking: '🤔', tool: '🔧', response: '💬', done: '✅', error: '❌',
};

/** Story 4.2.1: Format stats info bar string. Returns '' when no data. */
function formatStats(session: SessionState): string {
  const { tokensIn, tokensOut, elapsedMs, speed } = session;
  if (!tokensIn && !tokensOut) return '';
  const inK = tokensIn ? (tokensIn / 1000).toFixed(1) : '?';
  const outK = tokensOut ? (tokensOut / 1000).toFixed(1) : '?';
  const el = elapsedMs ? (elapsedMs / 1000).toFixed(1) : '?';
  const spd = speed ? Math.round(speed).toString() : '?';
  return `📊 ↑${inK}k · ↓${outK}k · ${el}s · ${spd}t/s`;
}

// ---- ChatMessage component -------------------------------------------------

interface ChatMessageProps {
  message: MessageState;
}

const ChatMessage = React.memo(function ChatMessage({ message }: ChatMessageProps): React.JSX.Element {
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

  // Story 4.2.1: thinking messages rendered with dim style and 🤔 prefix
  if (message.content.startsWith('> 🤔')) {
    return (
      <Box>
        <Text dimColor>{safeContent}</Text>
        {message.isStreaming && <Text color="yellow" dimColor>▌</Text>}
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
});

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
  const { stdout } = useStdout();
  const totalRows = stdout?.rows ?? 24;
  const totalColumns = stdout?.columns ?? 80;
  const panelHeight = Math.max(3, totalRows - OUTER_CHROME_LINES);
  const messagesHeight = Math.max(1, panelHeight - CHAT_CHROME_LINES);

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

    // Batch chunks to reduce re-render frequency during streaming.
    // Without this, every chunk triggers a full tree reconcile + screen redraw,
    // which causes visible flicker on long responses.
    const pending: ChatChunk[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flushNow = (): void => {
      flushTimer = null;
      if (pending.length === 0) return;
      const batch = pending.splice(0, pending.length);
      dispatch({ type: 'CHUNKS_APPENDED', payload: { sessionId, chunks: batch } });
    };
    const scheduleFlush = (): void => {
      if (flushTimer === null) {
        flushTimer = setTimeout(flushNow, CHUNK_FLUSH_MS);
      }
    };

    try {
      const stream = client.chat(sessionId, trimmed);
      for await (const chunk of stream) {
        pending.push(chunk);
        scheduleFlush();
      }
      // Final flush so the last batch isn't delayed.
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (pending.length > 0) {
        const batch = pending.splice(0, pending.length);
        dispatch({ type: 'CHUNKS_APPENDED', payload: { sessionId, chunks: batch } });
      }
      dispatch({ type: 'STREAM_END', payload: { sessionId } });
    } catch (err) {
      // Flush pending before surfacing the error so no content is lost.
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (pending.length > 0) {
        const batch = pending.splice(0, pending.length);
        dispatch({ type: 'CHUNKS_APPENDED', payload: { sessionId, chunks: batch } });
      }
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
      <Box flexDirection="column" alignItems="center" justifyContent="center" height={panelHeight}>
        <Text>No active session</Text>
        <Text dimColor>Ctrl+N 创建新会话</Text>
      </Box>
    );
  }

  // Compute visible messages: walk backwards from newest so streaming output
  // stays pinned to the bottom of the viewport. scrollOffset hides N trailing
  // LINES (0 = follow newest; >0 = scroll back through history).
  // Subtract 2 from messagesHeight to account for the paddingY={1} on the
  // messages Box (1 line top + 1 line bottom).
  const effectiveHeight = Math.max(1, messagesHeight - 2);
  const totalLines = messages.reduce((sum, m) => sum + estimateMessageLines(m, totalColumns), 0);
  const clampedOffset = Math.min(scrollOffset, Math.max(0, totalLines - effectiveHeight));
  const visibleMessages = computeVisibleMessages(
    messages,
    effectiveHeight,
    clampedOffset,
    totalColumns,
  );

  // Story 4.2.1: compute stats info bar string
  const statsInfo = (activeSession && activeSession.status !== 'streaming' && activeSession.status !== 'thinking' && activeSession.status !== 'tool')
    ? formatStats(activeSession) : '';

  return (
    <Box flexDirection="column" height={panelHeight}>
      {/* Header */}
      <Box borderStyle="single" borderColor="gray" paddingX={1}>
        <Text bold>{activeSession?.name ?? activeSessionId}</Text>
        {activeSession?.phase && activeSession.phase !== 'done' && activeSession.phase !== 'request' && (
          <Text> {phaseIcons[activeSession.phase] ?? ''}</Text>
        )}
        {activeSession?.status === 'streaming' && <Text color="yellow"> (streaming...)</Text>}
        {clampedOffset > 0 && <Text color="magenta"> ↑{clampedOffset}</Text>}
      </Box>

      {/* Messages area — explicit height so content cannot push the layout */}
      <Box flexDirection="column" height={messagesHeight} overflowY="hidden" paddingX={1} paddingY={1}>
        {/* Story 4.2.1: thinking area — show latest thinking snippet during stream */}
        {activeSession?.thinkingRing && activeSession.status !== 'idle' && activeSession.status !== 'done' && (
          <Box>
            <Text dimColor>&gt; 🤔 {activeSession.thinkingRing.slice(-120)}</Text>
          </Box>
        )}
        {visibleMessages.length === 0 && !activeSession?.thinkingRing ? (
          <Box alignItems="center" justifyContent="center" height="100%">
            <Text dimColor>输入消息开始对话</Text>
          </Box>
        ) : (
          visibleMessages.map((msg) => (
            <ChatMessage key={msg.id} message={msg} />
          ))
        )}
      </Box>

      {/* Story 4.2.1: stats info bar */}
      {statsInfo && (
        <Box paddingX={1}><Text dimColor>{statsInfo}</Text></Box>
      )}

      {/* Command feedback (transient) */}
      {commandFeedback && (
        <Box paddingX={1}>
          <Text color={isCommandMode ? 'cyan' : 'yellow'} wrap="truncate">
            {isCommandMode && commandFeedback.length > 1000
              ? commandFeedback.slice(0, 1000) + '…'
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
