// @zaivim/engine — Provider registry
// OpenAI-protocol compatible providers (DeepSeek, GLM, etc.)
// Growth: adapter pattern for @anthropic-ai/sdk.

import type {
  IProvider,
  ProviderChatRequest,
  ResponseChunk,
  ProviderCapabilities,
  ProviderStatus,
  Message,
} from '@zaivim/core';
import { ZaiNetworkError } from '@zaivim/core';
import { validateProviderConfig, validateProviderCompatibility } from './validation.js';

// ---- Provider Capabilities (declarative) ----------------------------------

const PROVIDER_CAPABILITIES: Record<string, ProviderCapabilities> = {
  deepseek: {
    streaming: true,
    toolUse: true,
    caching: false,
    thinking: false,
    vision: false,
    maxContextTokens: 128_000,
  },
  glm: {
    streaming: true,
    toolUse: true,
    caching: false,
    thinking: true,
    vision: true,
    maxContextTokens: 128_000,
  },
  openai: {
    streaming: true,
    toolUse: true,
    caching: true,
    thinking: true,
    vision: true,
    maxContextTokens: 128_000,
  },
};

// ---- Provider implementation (OpenAI-compatible) --------------------------

export interface ProviderConfig {
  name: string;
  type: string;
  apiKey: string;
  baseURL: string;
  models: readonly string[];
  defaultModel: string;
  status?: ProviderStatus;
  protocol?: 'openai-compatible' | 'anthropic-native';
  lastChecked?: number;
  /** Allow HTTP connections (default: only HTTPS). AC13 Red Team requirement. */
  allowHttp?: boolean;
}

/** Callbacks for lazy validation results (first chat() call) */
export interface ValidationCallbacks {
  onValid: () => void;
  onInvalid: (reason: string) => void;
}

export class OpenAICompatibleProvider implements IProvider {
  readonly name: string;
  readonly models: readonly string[];
  readonly capabilities: ProviderCapabilities;

  #config: ProviderConfig;
  #validated = false;
  #validationCallbacks?: ValidationCallbacks;
  #fetch: typeof globalThis.fetch;

  constructor(config: ProviderConfig, validationCallbacks?: ValidationCallbacks, fetchFn?: typeof globalThis.fetch) {
    this.name = config.name;
    this.models = config.models;
    this.#config = config;
    this.#validationCallbacks = validationCallbacks;
    this.#fetch = fetchFn ?? globalThis.fetch.bind(globalThis);

    const caps = PROVIDER_CAPABILITIES[config.name] ?? PROVIDER_CAPABILITIES[config.type] ?? PROVIDER_CAPABILITIES['openai']!;
    this.capabilities = caps;
  }

  async *chat(
    request: ProviderChatRequest,
    signal?: AbortSignal,
  ): AsyncIterable<ResponseChunk> {
    const model = request.model ?? this.#config.defaultModel;

    // HTTPS enforcement (AC13: Red Team — SSE 注入防护)
    const baseURL = this.#config.baseURL;
    if (!baseURL.startsWith('https://') && !baseURL.startsWith('http://')) {
      throw new ZaiNetworkError(
        `Provider ${this.name}: baseURL must start with https:// or http://`,
        'ENGINE_PROVIDER_ERROR',
        400,
      );
    }
    if (baseURL.startsWith('http://') && !this.#config.allowHttp) {
      throw new ZaiNetworkError(
        `HTTPS required for provider ${this.name}. Set allowHttp: true to allow HTTP connections.`,
        'ENGINE_PROVIDER_ERROR',
        403,
      );
    }

    const url = `${baseURL}/v1/chat/completions`;
    const temperature = request.temperature ?? 0.7;
    const maxTokens = request.maxTokens ?? 4096;

    const body: Record<string, unknown> = {
      model,
      messages: request.messages.map(toOpenAIMessage),
      temperature,
      max_tokens: maxTokens,
      stream: true,
    };

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.#config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      throw new ZaiNetworkError(
        `Failed to connect to ${this.name}: ${String(err)}`,
        'ENGINE_PROVIDER_ERROR',
        502,
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const detail: Record<string, unknown> = {};
      // Extract Retry-After header for 429 responses
      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After');
        if (retryAfter) {
          const parsed = Number(retryAfter);
          if (!Number.isNaN(parsed) && parsed > 0) {
            detail.retryAfterMs = parsed * 1000; // seconds → ms
          }
        }
      }
      throw new ZaiNetworkError(
        `Provider ${this.name} returned ${response.status}: ${text}`,
        'ENGINE_PROVIDER_ERROR',
        response.status,
        Object.keys(detail).length > 0 ? detail : undefined,
      );
    }

    const reader = response.body?.getReader();
    if (!reader) {
      // Non-streaming fallback
      const data = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content ?? '';
      yield { type: 'text', content };
      yield { type: 'done', finishReason: 'stop' };
      return;
    }

    // SSE stream parsing
    const decoder = new TextDecoder();
    let buffer = '';
    let finishReason = 'stop';

    try {
      while (true) {
        if (signal?.aborted) {
          reader.cancel();
          return;
        }

        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          const data = trimmed.slice(6).trim();
          if (data === '[DONE]') continue;

          const chunk = safeParseJsonLine(data);
          if (!chunk) continue;

          // Lazy validation on first SSE chunk (AC7)
          if (!this.#validated) {
            this.#validated = true;
            const valResult = validateProviderCompatibility(chunk as Record<string, unknown>);
            if (!valResult.valid) {
              this.#validationCallbacks?.onInvalid(valResult.reason ?? 'unknown format error');
              throw new ZaiNetworkError(
                `Provider ${this.name} format incompatible: ${valResult.reason}`,
                'ENGINE_PROVIDER_ERROR',
                502,
              );
            }
            this.#validationCallbacks?.onValid();
          }

          const choices = chunk.choices as Record<string, unknown>[] | undefined;
          const choice = choices?.[0] as Record<string, unknown> | undefined;
          if (!choice) continue;

          // Check finish_reason
          if (choice.finish_reason) {
            finishReason = String(choice.finish_reason);
          }

          const delta = choice.delta as Record<string, unknown> | undefined;
          if (!delta) continue;

          // Text content
          if (delta.content) {
            yield { type: 'text', content: String(delta.content) };
          }

          // Tool calls
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls as Array<Record<string, unknown>>) {
              if (tc.function) {
                const fn = tc.function as Record<string, unknown>;
                let args: Record<string, unknown> = {};
                if (typeof fn.arguments === 'string') {
                  try { args = JSON.parse(fn.arguments) as Record<string, unknown>; } catch { /* partial args */ }
                }
                yield {
                  type: 'tool_call',
                  id: String(tc.id ?? ''),
                  name: String(fn.name ?? ''),
                  arguments: args,
                };
              }
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    yield { type: 'done', finishReason };
  }
}

// ---- Helpers --------------------------------------------------------------

function toOpenAIMessage(msg: Message): Record<string, unknown> {
  const m: Record<string, unknown> = {
    role: msg.role === 'tool' ? 'tool' : msg.role,
    content: msg.content,
  };
  if (msg.toolCalls && msg.role === 'assistant') {
    m.tool_calls = msg.toolCalls.map(tc => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
    }));
  }
  return m;
}

function safeParseJsonLine(line: string): Record<string, unknown> | null {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ---- Provider Registry -----------------------------------------------------

export interface RateLimitState {
  limited: boolean;
  retryAfterMs: number;
  queuedSessions: Set<string>;
  resumedAt: number;
}

export class ProviderRegistry {
  #providers: Map<string, IProvider> = new Map();
  #providerStatus: Map<string, ProviderStatus> = new Map();
  #providerErrors: Map<string, string> = new Map();
  #rateLimitCounter: Map<string, RateLimitState> = new Map();
  #defaultName: string;

  constructor(providers: Map<string, ProviderConfig>, defaultName: string) {
    this.#defaultName = defaultName;

    for (const [name, cfg] of providers) {
      const result = validateProviderConfig(cfg);
      if (result.valid) {
        this.#providers.set(name, new OpenAICompatibleProvider(
          cfg,
          {
            onValid: () => {
              this.#providerStatus.set(name, 'available');
              this.#providerErrors.delete(name);
            },
            onInvalid: (reason) => {
              this.#providerStatus.set(name, 'unavailable');
              this.#providerErrors.set(name, reason);
            },
          },
        ));
        this.#providerStatus.set(name, 'untested');
      } else {
        this.#providerStatus.set(name, 'unavailable');
        if (result.reason) {
          this.#providerErrors.set(name, result.reason);
        }
      }
    }
  }

  get(name?: string): IProvider {
    const key = name ?? this.#defaultName;
    const provider = this.#providers.get(key);
    if (!provider) {
      throw new ZaiNetworkError(
        `Provider "${key}" not found. Available: [${[...this.#providers.keys()].join(', ')}]`,
        'ENGINE_PROVIDER_ERROR',
        404,
      );
    }
    return provider;
  }

  get defaultProvider(): IProvider {
    return this.get(this.#defaultName);
  }

  listNames(): string[] {
    return [...this.#providers.keys()];
  }

  getProviderStatus(name: string): ProviderStatus {
    const status = this.#providerStatus.get(name);
    if (status === undefined) {
      throw new ZaiNetworkError(
        `Provider "${name}" not found`,
        'ENGINE_PROVIDER_ERROR',
        404,
      );
    }
    return status;
  }

  /** E9 stub — runtime provider switching (returns false until E9 implementation) */
  switchProvider(_name: string): boolean {
    return false;
  }

  /** Get the error reason for an unavailable provider, or undefined if none */
  getProviderError(name: string): string | undefined {
    return this.#providerErrors.get(name);
  }

  /** Returns names of providers with status 'available', 'untested', or 'degraded' */
  listAvailableProviders(): string[] {
    return [...this.#providerStatus.entries()]
      .filter(([, status]) => status === 'available' || status === 'untested' || status === 'degraded')
      .map(([name]) => name);
  }

  /** Get next available provider as fallback (excludes the given providers and rate-limited ones) */
  getFallback(excludeNames: string | string[]): IProvider | undefined {
    const excludes = Array.isArray(excludeNames) ? excludeNames : [excludeNames];
    for (const name of this.listAvailableProviders()) {
      if (excludes.includes(name)) continue;
      // Skip rate-limited providers to avoid immediate failure
      const rateState = this.#rateLimitCounter.get(name);
      if (rateState?.limited && Date.now() < rateState.resumedAt) continue;
      return this.#providers.get(name);
    }
    return undefined;
  }

  /** Mark provider as unavailable with a reason */
  markUnavailable(name: string, reason: string): void {
    this.#providerStatus.set(name, 'unavailable');
    this.#providerErrors.set(name, reason);
  }

  /** Mark provider as available after successful lazy validation or successful response */
  markAvailable(name: string): void {
    this.#providerStatus.set(name, 'available');
    this.#providerErrors.delete(name);
  }

  /** Mark provider as degraded (transient failure, auto-recoverable) */
  markDegraded(name: string, reason: string): void {
    this.#providerStatus.set(name, 'degraded');
    this.#providerErrors.set(name, reason);
  }

  // ---- Rate limit coordination (Story 1b.5 Task 4) -------------------------

  /** Check if provider is currently rate-limited. Returns current state or undefined. */
  getRateLimitState(providerName: string): RateLimitState | undefined {
    return this.#rateLimitCounter.get(providerName);
  }

  /** Mark provider as rate-limited after receiving 429 */
  reportRateLimit(providerName: string, retryAfterMs: number): void {
    const existing = this.#rateLimitCounter.get(providerName);
    if (existing) {
      existing.limited = true;
      existing.retryAfterMs = retryAfterMs;
      existing.resumedAt = Date.now() + retryAfterMs;
    } else {
      this.#rateLimitCounter.set(providerName, {
        limited: true,
        retryAfterMs,
        queuedSessions: new Set(),
        resumedAt: Date.now() + retryAfterMs,
      });
    }
  }

  /** Acquire a rate slot for a session. Queues if provider is rate-limited. */
  async acquireRateSlot(providerName: string, sessionId: string): Promise<void> {
    const state = this.#rateLimitCounter.get(providerName);
    if (!state || !state.limited) return;

    const now = Date.now();
    if (now >= state.resumedAt) {
      state.limited = false;
      state.queuedSessions.clear();
      return;
    }

    // Still limited — queue this session
    state.queuedSessions.add(sessionId);
    const waitMs = state.resumedAt - now;
    await new Promise(resolve => setTimeout(resolve, waitMs));
    state.queuedSessions.delete(sessionId);

    // If no more queued sessions and time has passed, clear limit
    if (state.queuedSessions.size === 0 && Date.now() >= state.resumedAt) {
      state.limited = false;
    }
  }

  /** Release a rate slot after request completes */
  releaseRateSlot(providerName: string, sessionId: string): void {
    const state = this.#rateLimitCounter.get(providerName);
    if (!state) return;
    state.queuedSessions.delete(sessionId);
    if (state.queuedSessions.size === 0 && Date.now() >= state.resumedAt) {
      state.limited = false;
    }
  }
}

export function createProviderRegistry(
  configs: Record<string, ProviderConfig>,
  defaultName: string,
): ProviderRegistry {
  return new ProviderRegistry(new Map(Object.entries(configs)), defaultName);
}
