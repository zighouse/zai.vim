// @zaivim/engine — Pipeline chat() main function
// End-to-end streaming pipeline: context assembly → provider call → retry → fallback → tool execution loop → streaming response.

import type {
  Session,
  Message,
  ResponseChunk,
  IProvider,
  ISecurityProvider,
  ISessionStore,
  PersonaConfig,
  PipelineConfig,
  ChatResult,
  ProjectContext,
} from '@zaivim/core';
import { ZaiNetworkError, NullSecurityProvider } from '@zaivim/core';
import { ToolRegistry } from '@zaivim/tools';
import { assembleContext, trimContext, PIPELINE_DEFAULTS } from './context-assembler.js';
import { formatAttachments } from './file-attachment.js';
import { executeToolCalls, validateToolCalls } from './tool-executor.js';
import type { ToolCallRequest } from './tool-executor.js';
import { classifyProviderError } from './error-classifier.js';
import { retryWithBackoff, DEFAULT_RETRY_CONFIG } from './retry.js';
import type { RetryConfig } from './retry.js';
import type { ProviderRegistry } from '../provider/index.js';
import { getBadge } from '../security/badge-display.js';
export interface ChatDeps {
  readonly sessionStore: ISessionStore;
  readonly provider: IProvider;
  /** Story 3.3: tool dispatch source-of-truth (was tools: ToolDefinition[]). */
  readonly registry: ToolRegistry;
  readonly security?: ISecurityProvider;
  readonly config?: PipelineConfig;
  readonly persona?: PersonaConfig;
  readonly emit?: (event: string, data: Record<string, unknown>) => void;
  readonly onMessagePushed?: (sessionId: string) => void;
  readonly projectContext?: ProjectContext;
  readonly providerRegistry?: ProviderRegistry;
  readonly sessionId?: string;
}

type EmitFn = (event: string, data: Record<string, unknown>) => void;

/**
 * Main pipeline chat function.
 * Yields ResponseChunks as they arrive from the provider, with retry, fallback, and tool call loop support.
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
    registry,
    security = new NullSecurityProvider(),
    config = {},
    persona,
    emit = (() => {}),
    onMessagePushed,
    providerRegistry,
    sessionId = session.id,
  } = deps;

  const maxToolCallRounds = config.maxToolCallRounds ?? PIPELINE_DEFAULTS.maxToolCallRounds;
  const toolCallTimeout = config.toolCallTimeout ?? PIPELINE_DEFAULTS.toolCallTimeout;

  const retryConfig: RetryConfig = {
    maxRetries: config.maxRetries ?? PIPELINE_DEFAULTS.maxRetries,
    baseDelayMs: config.baseDelayMs ?? PIPELINE_DEFAULTS.baseDelayMs,
    maxDelayMs: config.maxDelayMs ?? PIPELINE_DEFAULTS.maxDelayMs,
    backoffFactor: config.backoffFactor ?? PIPELINE_DEFAULTS.backoffFactor,
  };

  // 1. Append user message to session
  sessionStore.pushMessage(session.id, message);
  onMessagePushed?.(session.id);

  // 2. Assemble context (history + system prompt + project context + token trimming)
  const { messages: contextMessages } = assembleContext(session, persona, {
    maxContextTokens: config.maxContextTokens ?? PIPELINE_DEFAULTS.maxContextTokens,
    sessionId: session.id,
    emit,
    formatAttachments,
    projectContext: deps.projectContext,
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
  let completed = false;
  // Track tool calls from the final provider round for mixed text+tool_call responses (M5)
  let finalRoundToolCalls: ToolCallRequest[] = [];

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

      // 5. Call provider with retry + fallback
      try {
        const chunks = callProviderWithRetryAndFallback(
          provider,
          request,
          retryConfig,
          signal,
          emit,
          providerRegistry,
          sessionId,
        );

        for await (const chunk of chunks) {
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

          // Accumulate text content for persistence
          if (chunk.type === 'text') {
            fullContent += chunk.content;
          }

          // Track done reason
          if (chunk.type === 'done') {
            finishReason = chunk.finishReason;
          }

          // Security enrichment: pre-check harm level for tool_call chunks (Story 2.2, Task 3.3)
          if (chunk.type === 'tool_call') {
            let harmLevel: import('@zaivim/core').HarmLevel | undefined;
            try {
              const decision = await security.preExecute(chunk.name, chunk.arguments);
              harmLevel = decision.harmLevel;
            } catch {
              // Security check failure should not block the pipeline
            }

            if (harmLevel) {
              const badge = getBadge(harmLevel);
              const enriched = { ...chunk, harmLevel, badge };
              toolCalls.push({
                id: enriched.id,
                name: enriched.name,
                arguments: enriched.arguments,
              });
              yield enriched;
              continue;
            }
          }

          // Collect tool calls for execution
          if (chunk.type === 'tool_call') {
            toolCalls.push({
              id: chunk.id,
              name: chunk.name,
              arguments: chunk.arguments,
            });
          }

          yield chunk;
          totalChunks++;
          chunksDelivered++;
        }

        // Provider succeeded — mark available (AC8)
        providerRegistry?.markAvailable(provider.name);
      } catch (err) {
        // AbortError: propagate (user cancelled)
        if (err instanceof Error && (err.name === 'AbortError' || err.message.includes('aborted'))) {
          const propagationMs = Math.round(performance.now() - startTime);
          if (propagationMs > 100) {
            emit('perf.abort_propagation', {
              sessionId: session.id,
              propagationMs,
            });
          }
          return;
        }

        // Provider error after retry exhaustion + fallback failure
        if (err instanceof ZaiNetworkError) {
          const classified = classifyProviderError(err);

          // Stream interrupted notification (AC9)
          if (chunksDelivered > 0) {
            emit('chat.interrupted', {
              sessionId: session.id,
              chunksDelivered,
              reason: err.message,
            });
          }

          // Auth/model error notifications (AC2)
          if (classified.code === 'ENGINE_PROVIDER_AUTH_FAILED') {
            emit('provider.auth_failed', {
              provider: provider.name,
              hint: `API key may have expired. Run 'zaivim config set provider.${provider.name}.apiKey <new-key>' to update without restart.`,
            });
          } else if (classified.code === 'ENGINE_PROVIDER_MODEL_NOT_FOUND') {
            emit('provider.model_not_found', { provider: provider.name });
          } else if (classified.recoverable) {
            // Mark degraded after all retries exhausted
            providerRegistry?.markDegraded(provider.name, classified.message);
            emit('provider.status', {
              status: 'degraded',
              provider: provider.name,
              ...(providerRegistry ? { availableProviders: providerRegistry.listAvailableProviders().filter(n => n !== provider.name) } : {}),
            });
          }

          // context_length_exceeded auto-trim retry (AC10)
          if (classified.code === 'PIPELINE_CONTEXT_LENGTH_EXCEEDED') {
            const trimResult = await handleContextLengthExceeded(
              workingMessages,
              provider,
              request,
              session.id,
              signal,
              emit,
            );
            if (trimResult) {
              for (const chunk of trimResult.chunks) {
                if (chunk.type === 'text') {
                  fullContent += chunk.content;
                }
                if (chunk.type === 'tool_call') {
                  toolCalls.push({
                    id: chunk.id,
                    name: chunk.name,
                    arguments: chunk.arguments,
                  });
                }
                if (chunk.type === 'done') {
                  finishReason = chunk.finishReason;
                }
                yield chunk;
                totalChunks++;
                chunksDelivered++;
              }
              providerRegistry?.markAvailable(provider.name);
            } else {
              yield { type: 'error', code: 'PIPELINE_CONTEXT_LENGTH_EXCEEDED', message: classified.message };
              return;
            }
          } else {
            yield { type: 'error', code: classified.code, message: classified.message };
            return;
          }
        } else {
          // Unknown error: yield generic error chunk
          yield {
            type: 'error',
            code: 'ENGINE_PROVIDER_ERROR',
            message: err instanceof Error ? err.message : String(err),
          };
          return;
        }
      }

      // 6. Save tool calls from this round for final message metadata
      if (toolCalls.length > 0) {
        finalRoundToolCalls = toolCalls;
      }

      // 7. No tool calls: done
      if (toolCalls.length === 0) break;

      // 7. Validate tool calls (AC13: SSE injection protection)
      const { valid, errors } = validateToolCalls(toolCalls, registry);
      for (const errChunk of errors) {
        yield errChunk;
        totalChunks++;
      }

      if (valid.length === 0) {
        // All tool calls invalid, let AI decide next step
        break;
      }

      // 8. Execute valid tool calls
      const toolResults = await executeToolCalls(valid, registry, {
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
    if (fullContent && completed) {
      const assistantMessage: Message = {
        id: `resp-${Date.now()}`,
        role: 'assistant',
        content: fullContent,
        ...(finalRoundToolCalls.length > 0
          ? { toolCalls: finalRoundToolCalls.map(tc => ({ id: tc.id, name: tc.name, arguments: tc.arguments })) }
          : {}),
      };
      sessionStore.pushMessage(session.id, assistantMessage);
    }
  }
}

/**
 * Call provider with retry and fallback logic.
 * Wraps provider.chat() in retryWithBackoff, then tries fallback providers on exhaustion.
 */
async function* callProviderWithRetryAndFallback(
  primaryProvider: IProvider,
  request: { messages: Message[]; sessionId: string; temperature: number; maxTokens: number },
  retryConfig: RetryConfig,
  signal: AbortSignal | undefined,
  emit: EmitFn,
  providerRegistry: ProviderRegistry | undefined,
  sessionId: string,
): AsyncIterable<ResponseChunk> {
  try {
    // Rate limit coordination — check before calling provider
    if (providerRegistry) {
      await providerRegistry.acquireRateSlot(primaryProvider.name, sessionId);
    }

    yield* retryWithBackoff(
      () => primaryProvider.chat(request, signal),
      retryConfig,
      signal,
      {
        onRetry: (attempt, maxAttempts, delayMs) => {
          emit('provider.retry', {
            provider: primaryProvider.name,
            attempt,
            maxAttempts,
            delayMs,
          });
        },
        onRateLimited: (retryAfterMs) => {
          providerRegistry?.reportRateLimit(primaryProvider.name, retryAfterMs);
        },
      },
    );

    // Success — emit recovered if provider was previously degraded
    if (providerRegistry?.getProviderStatus(primaryProvider.name) === 'degraded') {
      emit('provider.recovered', { provider: primaryProvider.name });
    }
  } catch (primaryErr) {
    // Retry exhausted — try fallback providers recursively (AC5)
    if (!providerRegistry) throw primaryErr;

    const excluded = [primaryProvider.name];
    let lastError = primaryErr;
    let foundWorkingFallback = false;

    while (!foundWorkingFallback) {
      const fallback = providerRegistry.getFallback(excluded);
      if (!fallback) break;

      excluded.push(fallback.name);
      emit('provider.fallback', { from: primaryProvider.name, to: fallback.name });

      try {
        yield* retryWithBackoff(
          () => fallback.chat(request, signal),
          retryConfig,
          signal,
          {
            onRetry: (attempt, maxAttempts, delayMs) => {
              emit('provider.retry', {
                provider: fallback.name,
                attempt,
                maxAttempts,
                delayMs,
              });
            },
            onRateLimited: (retryAfterMs) => {
              providerRegistry?.reportRateLimit(fallback.name, retryAfterMs);
            },
          },
        );

        providerRegistry.markAvailable(fallback.name);
        foundWorkingFallback = true;
      } catch (fallbackErr) {
        providerRegistry.markDegraded(fallback.name, 'Fallback retries exhausted');
        emit('provider.status', {
          status: 'degraded',
          provider: fallback.name,
          availableProviders: providerRegistry.listAvailableProviders().filter(n => n !== fallback.name),
        });
        lastError = fallbackErr;
      }
    }

    if (!foundWorkingFallback) {
      emit('provider.status', {
        status: 'degraded',
        provider: primaryProvider.name,
        availableProviders: providerRegistry.listAvailableProviders().filter(n => n !== primaryProvider.name),
      });
      throw lastError;
    }
  } finally {
    if (providerRegistry) {
      providerRegistry.releaseRateSlot(primaryProvider.name, sessionId);
    }
  }
}

/**
 * Handle context_length_exceeded by trimming context and retrying once.
 * Returns chunks + removed count, or null if trim retry also fails.
 */
async function handleContextLengthExceeded(
  workingMessages: Message[],
  provider: IProvider,
  request: { messages: Message[]; sessionId: string; temperature: number; maxTokens: number },
  sessionId: string,
  signal: AbortSignal | undefined,
  emit: EmitFn,
): Promise<{ chunks: ResponseChunk[]; removedCount: number } | null> {

  // Trim 50% of token budget from middle history (AC10)
  const tokenBudget = Math.floor(workingMessages.length * 0.5);
  const { messages: trimmed, removed } = trimContext(workingMessages, tokenBudget);

  if (removed === 0) return null;

  const trimmedRequest = { ...request, messages: trimmed };

  try {
    const chunks: ResponseChunk[] = [];
    for await (const chunk of provider.chat(trimmedRequest, signal)) {
      chunks.push(chunk);
    }

    emit('context.auto_trimmed', { sessionId, removedCount: removed });
    return { chunks, removedCount: removed };
  } catch {
    return null;
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
