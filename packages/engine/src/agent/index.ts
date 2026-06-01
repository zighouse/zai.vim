// @zaivim/engine — Agent system
// AsyncGeneratorAgent: in-process agent using AsyncGenerator for streaming.
// Each agent.send() checks AbortSignal before yielding.

import type {
  AgentHandle,
  AgentStatus,
  Message,
  ResponseChunk,
  PersonaConfig,
  ForkOptions,
  ToolContext,
  ToolDefinition,
} from '@zaivim/core';
import type { ISecurityProvider } from '@zaivim/core';
import { randomUUID } from 'node:crypto';
import { LifecycleStateMachine } from '../lifecycle/index.js';
import type { ProviderRegistry } from '../provider/index.js';
import type { SessionStore } from '../session/index.js';

export interface AgentDeps {
  providerRegistry: ProviderRegistry;
  sessionStore: SessionStore;
  securityProvider: ISecurityProvider;
  tools?: ToolDefinition[];
  signal?: AbortSignal;
}

export class AsyncGeneratorAgent implements AgentHandle {
  readonly id: string;
  readonly persona: PersonaConfig;

  #providerRegistry: ProviderRegistry;
  #sessionStore: SessionStore;
  #securityProvider: ISecurityProvider;
  #tools: ToolDefinition[];
  #stateMachine: LifecycleStateMachine;
  #externalSignal?: AbortSignal;

  constructor(
    persona: PersonaConfig,
    deps: AgentDeps,
    options?: ForkOptions,
  ) {
    this.id = randomUUID();
    this.persona = persona;
    this.#providerRegistry = deps.providerRegistry;
    this.#sessionStore = deps.sessionStore;
    this.#securityProvider = deps.securityProvider;
    this.#tools = options?.tools
      ? deps.tools?.filter(t => options.tools!.includes(t.name)) ?? deps.tools ?? []
      : deps.tools ?? [];
    this.#stateMachine = new LifecycleStateMachine('idle');
    this.#externalSignal = deps.signal;
  }

  status(): AgentStatus {
    return this.#stateMachine.state;
  }

  async *send(
    message: Message,
    signal?: AbortSignal,
  ): AsyncIterable<ResponseChunk> {
    const effectiveSignal = signal ?? this.#externalSignal;

    try {
      this.#stateMachine.transition('start');

      // Register message in session
      const sessionId = message.id ? message.id : 'default';
      const session = this.#sessionStore.get(sessionId);
      if (!session) {
        // Auto-create session if not found
        this.#sessionStore.create({
          language: 'en',
          sandbox: { enabled: false, type: 'none', workDir: '/tmp', timeout: 30000 },
          providers: {},
          defaults: { provider: '', model: '', temperature: 0.7, maxTokens: 4096 },
        });
      }

      this.#sessionStore.appendMessage(sessionId, {
        ...message,
        id: message.id || randomUUID(),
        createdAt: Date.now(),
      });

      // Get provider
      const provider = this.#providerRegistry.get(this.persona.model
        ? undefined  // use model name to find provider
        : undefined
      );

      const providerReq = {
        messages: [message],
        sessionId,
        model: this.persona.model,
        temperature: this.persona.temperature,
        maxTokens: this.persona.maxTokens,
      };

      // Stream response
      for await (const chunk of provider.chat(providerReq, effectiveSignal)) {
        // Check AbortSignal before each yield
        if (effectiveSignal?.aborted) {
          if (effectiveSignal.throwIfAborted) {
            effectiveSignal.throwIfAborted();
          }
          break;
        }

        // If tool call, transition and execute
        if (chunk.type === 'tool_call') {
          this.#stateMachine.transition('tool_call');

          const tool = this.#tools.find(t => t.name === chunk.name);
          if (tool) {
            const ctx: ToolContext = {
              sessionId,
              sandbox: this.#securityProvider.isSandboxAvailable() ? 'bwrap' : 'none',
              signal: effectiveSignal ?? new AbortController().signal, // EC3: signal never undefined
              security: this.#securityProvider,
              audit: (_action, _detail) => {
                // Growth: write to auditor
              },
            };

            try {
              const result = await tool.execute(chunk.arguments, ctx);
              yield { type: 'tool_result', toolCallId: chunk.name, content: JSON.stringify(result) };
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              yield { type: 'error', code: 'TOOLS_EXECUTION_FAILED', message: msg };
            }

            this.#stateMachine.transition('tool_result');
          } else {
            yield { type: 'error', code: 'TOOLS_NOT_FOUND', message: `Tool not found: ${chunk.name}` };
          }
          continue;
        }

        yield chunk;
      }

      this.#stateMachine.transition('finish');
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        this.#stateMachine.transition('cancel');
        throw err; // Re-throw so caller knows it was aborted
      }
      this.#stateMachine.transition('error');
      yield {
        type: 'error',
        code: err instanceof Error
          ? (err as { code?: string }).code ?? 'ENGINE_PROVIDER_ERROR'
          : 'ENGINE_PROVIDER_ERROR',
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  cancel(reason?: string): void {
    this.#stateMachine.transition('cancel');
  }
}
