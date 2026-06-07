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
    const url = `${this.#config.baseURL}/v1/chat/completions`;
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
      throw new ZaiNetworkError(
        `Provider ${this.name} returned ${response.status}: ${text}`,
        'ENGINE_PROVIDER_ERROR',
        response.status,
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

export class ProviderRegistry {
  #providers: Map<string, IProvider> = new Map();
  #providerStatus: Map<string, ProviderStatus> = new Map();
  #providerErrors: Map<string, string> = new Map();
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

  /** Returns names of providers with status 'available' or 'untested' */
  listAvailableProviders(): string[] {
    return [...this.#providerStatus.entries()]
      .filter(([, status]) => status === 'available' || status === 'untested')
      .map(([name]) => name);
  }

  /** Get next available provider as fallback (excludes the given provider) */
  getFallback(excludeName: string): IProvider | undefined {
    for (const name of this.listAvailableProviders()) {
      if (name !== excludeName) {
        return this.#providers.get(name);
      }
    }
    return undefined;
  }

  /** Mark provider as unavailable with a reason */
  markUnavailable(name: string, reason: string): void {
    this.#providerStatus.set(name, 'unavailable');
    this.#providerErrors.set(name, reason);
  }

  /** Mark provider as available after successful lazy validation */
  markAvailable(name: string): void {
    this.#providerStatus.set(name, 'available');
    this.#providerErrors.delete(name);
  }
}

export function createProviderRegistry(
  configs: Record<string, ProviderConfig>,
  defaultName: string,
): ProviderRegistry {
  return new ProviderRegistry(new Map(Object.entries(configs)), defaultName);
}
