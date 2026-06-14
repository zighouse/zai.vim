// @zaivim/tui — JSON-RPC-like client wrapping EngineAPI
// Provides send/subscribe/chat interface consumed by the TUI store and UI layer.
// Runs in-process with the engine, directly calling EngineAPI methods.

import type { EngineAPI, Message, Session } from '@zaivim/core';
import { randomUUID } from 'node:crypto';

/** Connection status for UI display. */
export type ConnectionStatus = 'connected' | 'disconnected' | 'reconnecting';

/** Chat chunk with open-ended type dispatch (C4.1). */
export interface ChatChunk {
  type: string;
  [key: string]: unknown;
}

/** TuiClient interface consumed by the TUI store and components. */
export interface TuiClient {
  /** Send a JSON-RPC-style request to the engine. Returns the result. */
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;

  /** Subscribe to client events. Returns disposer. */
  subscribe(event: string, handler: (data: unknown) => void): () => void;

  /** Send a chat message, returns an async iterable of streaming chunks. */
  chat(sessionId: string, text: string, signal?: AbortSignal): AsyncIterable<ChatChunk>;

  /** Get connection status (always 'connected' for in-process). */
  connectionStatus: ConnectionStatus;

  /** Clean up all subscriptions. */
  close(): Promise<void>;
}

/**
 * Create a TUI client wrapping an in-process engine.
 *
 * API methods are dispatched through send() → EngineAPI.
 * Streaming chat chunks are yielded directly to the consumer.
 * Custom events (chunk events, session lifecycle) use a simple pub/sub built into the client.
 */
export function createTuiClient(engine: EngineAPI): TuiClient {
  const subscriptions = new Map<string, Set<(data: unknown) => void>>();

  const client: TuiClient = {
    connectionStatus: 'connected',

    async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
      switch (method) {
        case 'session.create': {
          const session = await engine.createSession();
          return { sessionId: session.id, status: session.status };
        }
        case 'session.list': {
          const sessions = engine.listSessions();
          return {
            activeSessions: sessions.filter((s: Session) => s.status === 'active' || s.status === 'paused').length,
            sessions: sessions.map((s: Session) => ({
              sessionId: s.id,
              status: s.status,
              createdAt: s.createdAt,
            })),
          };
        }
        case 'session.get': {
          const id = params?.sessionId as string | undefined;
          if (!id) throw new Error('Missing sessionId');
          const s = engine.getSession(id);
          if (!s) throw new Error(`Session not found: ${id}`);
          return {
            sessionId: s.id,
            status: s.status,
            createdAt: s.createdAt,
            messageCount: s.messages.length,
          };
        }
        case 'session.close': {
          const closeId = params?.sessionId as string | undefined;
          if (closeId) {
            await engine.closeSession(closeId);
          }
          return { status: 'closed' };
        }
        case 'engine.ping':
          return { status: 'ok', uptime: engine.uptime };
        default:
          throw new Error(`Method not found: ${method}`);
      }
    },

    subscribe(event: string, handler: (data: unknown) => void): () => void {
      if (!subscriptions.has(event)) {
        subscriptions.set(event, new Set());
      }
      subscriptions.get(event)!.add(handler);
      return () => {
        subscriptions.get(event)?.delete(handler);
      };
    },

    async *chat(sessionId: string, text: string, signal?: AbortSignal): AsyncIterable<ChatChunk> {
      const message: Message = {
        id: randomUUID(),
        role: 'user',
        content: text,
        createdAt: Date.now(),
      };

      const stream = engine.chat(sessionId, message, signal);
      for await (const chunk of stream) {
        const raw = chunk as unknown as ChatChunk;
        yield raw;
        // Dispatch to subscribers (store watches for stream chunk events)
        const handlers = subscriptions.get('$/chat/chunk');
        if (handlers) {
          for (const handler of handlers) {
            try { handler(raw); } catch { /* isolated */ }
          }
        }
      }
    },

    close(): Promise<void> {
      subscriptions.clear();
      return Promise.resolve();
    },
  };

  return client;
}
