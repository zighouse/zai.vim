// @zaivim/engine — Pipeline chat() main function
// End-to-end streaming pipeline: context assembly → provider call → tool execution loop → streaming response.

import type {
  Session,
  Message,
  ResponseChunk,
  IProvider,
  ToolDefinition,
  ISecurityProvider,
  ISessionStore,
  PersonaConfig,
  PipelineConfig,
  ChatResult,
} from '@zaivim/core';
import { ZaiNetworkError } from '@zaivim/core';
import { assembleContext, PIPELINE_DEFAULTS } from './context-assembler.js';
import { executeToolCalls, validateToolCalls } from './tool-executor.js';
import type { ToolCallRequest } from './tool-executor.js';
import { classifyProviderError } from './error-classifier.js';
import { NullSecurityProvider } from './null-security.js';

export interface ChatDeps {
  readonly sessionStore: ISessionStore;
  readonly provider: IProvider;
  readonly tools: ToolDefinition[];
  readonly security?: ISecurityProvider;
  readonly config?: PipelineConfig;
  readonly persona?: PersonaConfig;
  readonly emit?: (event: string, data: Record<string, unknown>) => void;
}

type EmitFn = (event: string, data: Record<string, unknown>) => void;

/**
 * Main pipeline chat function.
 * Yields ResponseChunks as they arrive from the provider, with tool call loop support.
 */
export async function* chat(
  session: Session,
  message: Message,
  deps: ChatDeps,
  signal?: AbortSignal,
): AsyncIterable<ResponseChunk> {
  const {
    sessionStore,
    provider,
    tools,
    security = new NullSecurityProvider(),
    config = {},
    persona,
    emit = (() => {}),
  } = deps;

  const maxToolCallRounds = config.maxToolCallRounds ?? PIPELINE_DEFAULTS.maxToolCallRounds;
  const toolCallTimeout = config.toolCallTimeout ?? PIPELINE_DEFAULTS.toolCallTimeout;

  // 1. Append user message to session
  sessionStore.pushMessage(session.id, message);

  // 2. Assemble context (history + system prompt + token trimming)
  const { messages: contextMessages } = assembleContext(session, persona, {
    maxContextTokens: config.maxContextTokens ?? PIPELINE_DEFAULTS.maxContextTokens,
    sessionId: session.id,
    emit,
  });

  // 3. Check provider streaming capability
  if (!provider.capabilities.streaming) {
    yield {
      type: 'error',
      code: 'PIPELINE_PROVIDER_NOT_STREAMING',
      message: `Provider ${provider.name} does not support streaming`,
    };
    return;
  }

  // 4. Tool call loop
  let round = 0;
  const startTime = performance.now();
  let firstToken = false;
  let totalChunks = 0;
  let finishReason = 'stop';
  let fullContent = '';

  // Working copy of messages for this conversation turn
  const workingMessages = [...contextMessages];

  // Track whether the pipeline completed normally (not aborted/interrupted)
  // Used by the finally block to decide if the AI response should be persisted (AC11)
  let completed = false;

  try {
    while (round < maxToolCallRounds) {
      signal?.throwIfAborted();

      const request = {
        messages: workingMessages,
        sessionId: session.id,
        temperature: persona?.temperature ?? session.config?.defaults?.temperature ?? 0.7,
        maxTokens: persona?.maxTokens ?? session.config?.defaults?.maxTokens ?? 4096,
      };

      const toolCalls: ToolCallRequest[] = [];
      let chunksDelivered = 0;
      let prevChunkTime = 0;

      // 5. Call provider, yield chunks
      try {
        for await (const chunk of provider.chat(request, signal)) {
          signal?.throwIfAborted();

          // Chunk interval monitoring (AC3)
          const now = performance.now();
          if (prevChunkTime !== 0) {
            const chunkInterval = now - prevChunkTime;
            if (chunkInterval > 50) {
              emit('perf.chunk_interval', {
                sessionId: session.id,
                intervalMs: Math.round(chunkInterval),
              });
            }
          }
          prevChunkTime = now;

          // First token latency measurement (AC2)
          if (!firstToken && chunk.type === 'text') {
            firstToken = true;
            const latency = performance.now() - startTime;
            emit('perf.first_token', {
              sessionId: session.id,
              latencyMs: Math.round(latency),
            });
          }

          // Collect tool calls for execution
          if (chunk.type === 'tool_call') {
            toolCalls.push({
              id: chunk.id,
              name: chunk.name,
              arguments: chunk.arguments,
            });
          }

          // Accumulate text content for persistence
          if (chunk.type === 'text') {
            fullContent += chunk.content;
          }

          // Track done reason
          if (chunk.type === 'done') {
            finishReason = chunk.finishReason;
          }

          yield chunk;
          totalChunks++;
          chunksDelivered++;
        }
      } catch (err) {
        // AbortError: propagate (user cancelled)
        if (err instanceof Error && (err.name === 'AbortError' || err.message.includes('aborted'))) {
          // AC6: session remains active; don't persist partial response
          return;
        }

        // Provider error: classify and yield error chunk
        if (err instanceof ZaiNetworkError) {
          const classified = classifyProviderError(err);

          // Stream interrupted notification (AC7)
          if (chunksDelivered > 0) {
            emit('chat.interrupted', {
              sessionId: session.id,
              chunksDelivered,
              reason: err.message,
            });
          }

          // Provider status notification
          if (classified.recoverable) {
            emit('provider.status', { status: 'degraded', provider: provider.name });
          }

          yield { type: 'error', code: classified.code, message: classified.message };
          return;
        }

        // Unknown error: yield generic error chunk
        yield {
          type: 'error',
          code: 'ENGINE_PROVIDER_ERROR',
          message: err instanceof Error ? err.message : String(err),
        };
        return;
      }

      // 6. No tool calls: done
      if (toolCalls.length === 0) break;

      // 7. Validate tool calls (AC13: SSE injection protection)
      const { valid, errors } = validateToolCalls(toolCalls, tools);
      for (const errChunk of errors) {
        yield errChunk;
        totalChunks++;
      }

      if (valid.length === 0) {
        // All tool calls invalid, let AI decide next step
        break;
      }

      // 8. Execute valid tool calls
      const toolResults = await executeToolCalls(valid, tools, {
        sessionId: session.id,
        sandbox: session.config?.sandbox?.workDir ?? '/tmp',
        signal,
        security,
        audit: (action, detail) => emit('tool.audit', { action, ...detail }),
        timeout: toolCallTimeout,
        emit,
      });

      // 9. Yield tool_result chunks and add to working messages
      for (let i = 0; i < toolResults.length; i++) {
        const resultMsg = toolResults[i]!;
        const tc = valid[i]!;

        const toolResultChunk: ResponseChunk = {
          type: 'tool_result',
          toolCallId: tc.id,
          content: resultMsg.content,
        };
        yield toolResultChunk;
        totalChunks++;

        // Add assistant tool_call message to working context
        const assistantMsg: Message = {
          id: `tc-${tc.id}`,
          role: 'assistant',
          content: '',
          toolCalls: [{ id: tc.id, name: tc.name, arguments: tc.arguments }],
        };
        workingMessages.push(assistantMsg);
        workingMessages.push(resultMsg);

        // Persist to session (fire-and-forget)
        sessionStore.pushMessage(session.id, resultMsg);
      }

      round++;
    }

    // 10. Max rounds exceeded
    if (round >= maxToolCallRounds) {
      yield {
        type: 'error',
        code: 'PIPELINE_MAX_TOOL_ROUNDS_EXCEEDED',
        message: `Exceeded max tool call rounds: ${maxToolCallRounds}`,
      };
    }

    completed = true;
  } finally {
    // 11. Persist complete AI response (AC11: only complete responses persist)
    // The finally block ensures we don't leak partial responses:
    //   - Normal completion → completed=true → persist
    //   - Consumer break/return/cancel → completed=false → skip
    //   - AbortError/Provider error → return before completed=true → skip
    if (fullContent && completed) {
      const assistantMessage: Message = {
        id: `resp-${Date.now()}`,
        role: 'assistant',
        content: fullContent,
      };
      // Fire-and-forget persistence
      sessionStore.pushMessage(session.id, assistantMessage);
    }
  }
}

/**
 * Compute ChatResult from pipeline execution.
 */
export function computeChatResult(
  chunks: number,
  finishReason: string,
  startTime: number,
): ChatResult {
  return {
    chunks,
    finishReason,
    firstTokenLatencyMs: Math.round(performance.now() - startTime),
  };
}
