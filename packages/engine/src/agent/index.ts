// @zaivim/engine — Agent system
// AsyncGeneratorAgent: in-process agent using AsyncGenerator for streaming.
// Each agent.send() checks AbortSignal before yielding.
//
// Story 2.4: Agent cancel cascade termination (Task 1)
// - PID tracking for spawned child processes
// - Process group cascade termination on cancel
// - Timeout auto-cancel (3600s, NFR24)
// - Cancel idempotency and audit chain

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type {
  AgentHandle,
  AgentStatus,
  Message,
  ResponseChunk,
  PersonaConfig,
  ForkOptions,
  ToolContext,
  IAuditor,
} from '@zaivim/core';
import type { ISecurityProvider } from '@zaivim/core';
import { ToolRegistry } from '@zaivim/tools';
import type { ProviderRegistry } from '../provider/index.js';
import type { ISessionStore } from '@zaivim/core';

// ---- Agent lifecycle state machine (inline, separate from EngineStateMachine) ----

type AgentLifecycleState = 'idle' | 'running' | 'waiting_tool' | 'done' | 'error' | 'cancelled';
type AgentLifecycleEvent = 'start' | 'tool_call' | 'tool_result' | 'finish' | 'error' | 'cancel';

const AGENT_TRANSITIONS: ReadonlyMap<AgentLifecycleState, ReadonlyMap<AgentLifecycleEvent, AgentLifecycleState>> = new Map([
  ['idle', new Map([['start', 'running'], ['cancel', 'cancelled']])],
  ['running', new Map([['tool_call', 'waiting_tool'], ['finish', 'done'], ['error', 'error'], ['cancel', 'cancelled']])],
  ['waiting_tool', new Map([['tool_result', 'running'], ['error', 'error'], ['cancel', 'cancelled']])],
  ['done', new Map()],
  ['error', new Map()],
  ['cancelled', new Map()],
]);

class AgentLifecycleSM {
  #state: AgentLifecycleState;
  constructor(initial?: AgentLifecycleState) { this.#state = initial ?? 'idle'; }
  transition(event: AgentLifecycleEvent): AgentLifecycleState {
    const validEvents = AGENT_TRANSITIONS.get(this.#state);
    if (!validEvents) throw new Error(`Agent state corrupted: "${this.#state}"`);
    const next = validEvents.get(event);
    if (!next) throw new Error(`Invalid agent transition: "${this.#state}" + "${event}"`);
    this.#state = next;
    return this.#state;
  }
  get state(): AgentLifecycleState { return this.#state; }
  get isTerminal(): boolean { return this.#state === 'done' || this.#state === 'error' || this.#state === 'cancelled'; }
}

export interface AgentDeps {
  providerRegistry: ProviderRegistry;
  sessionStore: ISessionStore;
  securityProvider: ISecurityProvider;
  auditor: Pick<IAuditor, 'write'>;
  /** Story 3.3: registry is the tool dispatch source-of-truth (was tools?: ToolDefinition[]). */
  registry?: ToolRegistry;
  signal?: AbortSignal;
}

export class AsyncGeneratorAgent implements AgentHandle {
  readonly id: string;
  readonly persona: PersonaConfig;

  #providerRegistry: ProviderRegistry;
  #sessionStore: ISessionStore;
  #securityProvider: ISecurityProvider;
  #auditor: Pick<IAuditor, 'write'>;
  #registry: ToolRegistry;
  /** Optional allow-list derived from ForkOptions.tools; undefined means all registry tools. */
  #allowedTools: ReadonlySet<string> | undefined;
  #stateMachine: AgentLifecycleSM;
  #externalSignal?: AbortSignal;

  // Story 2.4, Task 1.1: Track spawned PIDs for cascade termination
  #spawnedPids: Set<number> = new Set();
  // Story 2.4, Task 1.4: Timeout timer (3600s, NFR24)
  #timeoutTimer?: NodeJS.Timeout;
  // Story 2.4: Internal abort controller for cancel propagation
  #abortController = new AbortController();
  // Story 2.4, Task 1.7: Idempotency guard
  #cancelled = false;
  // Story 2.4, Task 1.10: Active tool call tracking for audit chain
  #activeToolCalls: Map<string, { operation: string; startTime: number }> = new Map();
  // Story 2.4, Task 1.13: Cleanup scan retry index
  #cleanupScanIndex = 0;

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
    this.#auditor = deps.auditor;
    this.#registry = deps.registry ?? new ToolRegistry();
    this.#allowedTools = options?.tools ? new Set(options.tools) : undefined;
    this.#stateMachine = new AgentLifecycleSM('idle');
    this.#externalSignal = deps.signal;

    // Story 2.4, Task 1.4: Agent timeout timer (3600s by default, NFR24)
    const timeoutMs = (options?.timeout ?? 3600) * 1000;
    this.#timeoutTimer = setTimeout(() => {
      this.cancel('timeout: 3600s exceeded');
    }, timeoutMs);
    this.#timeoutTimer.unref();
  }

  status(): AgentStatus {
    return this.#stateMachine.state;
  }

  // ---- Story 2.4: PID tracking (Task 1.1, 1.2) ----

  /** Track spawned process PID for cascade termination. */
  trackProcess(pid: number): void {
    if (pid <= 0) return;
    this.#spawnedPids.add(pid);
  }

  /** Untrack process on normal completion. */
  untrackProcess(pid: number): void {
    this.#spawnedPids.delete(pid);
  }

  // ---- Story 2.4: Tool call audit chain (Task 1.10) ----

  /** Register a tool call for cancel audit chain. */
  registerToolCall(toolCallId: string, operation: string): void {
    this.#activeToolCalls.set(toolCallId, { operation, startTime: Date.now() });
  }

  /** Unregister a tool call on normal completion. */
  unregisterToolCall(toolCallId: string): void {
    this.#activeToolCalls.delete(toolCallId);
  }

  // ---- Story 2.4: Controlled spawn wrapper (ToolContext.spawn) ----

  #createSpawnWrapper(): ToolContext['spawn'] {
    return (command, args, options) => {
      const proc = spawn(command, args ?? [], {
        ...options,
        detached: true,
      });
      if (proc.pid && proc.pid > 0) {
        this.#spawnedPids.add(proc.pid);
        proc.on('exit', () => {
          if (proc.pid) this.#spawnedPids.delete(proc.pid);
        });
      }
      return proc;
    };
  }

  // ---- Story 2.4: Process group cleanup (Task 1.9) ----

  #getChildPids(pid: number): number[] {
    if (process.platform === 'linux') {
      try {
        const content = readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf-8');
        return content.trim().split(/\s+/).map(Number).filter(n => n > 0);
      } catch { /* fallthrough */ }
    }
    try {
      const result = execSync(`ps --ppid ${pid} -o pid=`, {
        timeout: 5000,
        encoding: 'utf-8',
      });
      return result.trim().split('\n').map(s => Number(s.trim())).filter(n => n > 0);
    } catch {
      return [];
    }
  }

  #cleanupOrphans(): number {
    let surviving = 0;
    for (const pid of this.#spawnedPids) {
      try {
        process.kill(pid, 0);
        surviving++;
      } catch {
        this.#spawnedPids.delete(pid);
      }
    }
    if (surviving === 0) return 0;

    for (const pid of [...this.#spawnedPids]) {
      const children = this.#getChildPids(pid);
      for (const childPid of children) {
        try { process.kill(-childPid, 'SIGKILL'); } catch { /* best effort */ }
      }
    }

    this.#auditor.write({
      timestamp: new Date().toISOString(),
      operation: 'agent.cancel.cleanup',
      level: 'A',
      sessionId: '',
      result: 'rejected',
      reason: 'orphan cleanup scan',
      metadata: { survivingPids: surviving, terminated: true },
    });

    return surviving;
  }

  // ---- Story 2.4: Cancel with cascade termination (Task 1.3-1.14) ----

  #scheduleCleanupScans(): void {
    const scanDelays = [30_000, 60_000, 120_000];
    this.#cleanupScanIndex = 0;

    const scan = () => {
      if (this.#cleanupScanIndex >= scanDelays.length) return;
      const idx = this.#cleanupScanIndex++;

      setTimeout(() => {
        const survivors = this.#cleanupOrphans();
        if (survivors === 0) return;

        if (idx === 2 && survivors > 0) {
          this.#auditor.write({
            timestamp: new Date().toISOString(),
            operation: 'security.orphan_processes_detected',
            level: 'A',
            sessionId: '',
            result: 'rejected',
            reason: `${survivors} orphan processes remaining after 3 cleanup scans`,
            metadata: { survivingCount: survivors },
          });
        }

        scan();
      }, scanDelays[idx]);
    };

    scan();
  }

  cancel(reason?: string): void {
    // Task 1.7: Idempotency guard — only execute once
    if (this.#cancelled) return;
    this.#cancelled = true;

    const cancelSteps: Array<{ name: string; success: boolean }> = [];

    // Task 1.14: Each step in independent try/catch
    // Step 1: Abort signal propagation
    try {
      this.#abortController.abort(reason);
      this.#stateMachine.transition('cancel');
      cancelSteps.push({ name: 'abort_signal', success: true });
    } catch {
      cancelSteps.push({ name: 'abort_signal', success: false });
    }

    // Step 2: Clear timeout timer
    try {
      if (this.#timeoutTimer) {
        clearTimeout(this.#timeoutTimer);
        this.#timeoutTimer = undefined;
      }
      cancelSteps.push({ name: 'timeout_clear', success: true });
    } catch {
      cancelSteps.push({ name: 'timeout_clear', success: false });
    }

    // Step 3 (Task 1.10): Record all active tool calls as cancelled
    try {
      const now = Date.now();
      for (const [toolCallId, { operation, startTime }] of this.#activeToolCalls) {
        this.#auditor.write({
          timestamp: new Date().toISOString(),
          operation,
          level: 'B',
          sessionId: '',
          result: 'rejected',
          reason: `agent cancelled: ${reason}`,
          metadata: {
            toolCallId,
            elapsed: now - startTime,
            cancelledBy: reason,
          },
        });
      }
      this.#activeToolCalls.clear();
      cancelSteps.push({ name: 'audit_active_calls', success: true });
    } catch {
      cancelSteps.push({ name: 'audit_active_calls', success: false });
    }

    // Step 4 (Task 1.3, 1.8, 1.11): SIGTERM process groups
    try {
      for (const pid of this.#spawnedPids) {
        let pidAlive = true;
        try {
          // Task 1.8: Verify PID existence before killing
          if (pid > 0) process.kill(pid, 0);
        } catch (e: unknown) {
          const err = e as NodeJS.ErrnoException;
          if (err.code === 'ESRCH') {
            // PID already terminated or recycled
            this.#spawnedPids.delete(pid);
            pidAlive = false;
          }
          // Task 1.11: EPERM — PID exists but can't verify, still attempt kill
        }
        if (pidAlive) {
          try { process.kill(-pid, 'SIGTERM'); } catch { /* best effort */ }
        }
      }
      cancelSteps.push({ name: 'sigterm', success: true });
    } catch {
      cancelSteps.push({ name: 'sigterm', success: false });
    }

    // Step 5 (Task 1.6, NFR25): SIGKILL survivors after 5s
    try {
      const survivorPids = new Set(this.#spawnedPids);
      if (survivorPids.size > 0) {
        setTimeout(() => {
          for (const pid of survivorPids) {
            let pidAlive = true;
            try {
              if (pid > 0) process.kill(pid, 0);
            } catch (e: unknown) {
              const err = e as NodeJS.ErrnoException;
              if (err.code === 'ESRCH') {
                pidAlive = false; // PID recycled
              }
              // Task 1.11: EPERM — still attempt SIGKILL
            }
            if (pidAlive) {
              try { process.kill(-pid, 'SIGKILL'); } catch {
                this.#spawnedPids.delete(pid);
              }
            } else {
              this.#spawnedPids.delete(pid);
            }
          }
        }, 5000);
      }
      cancelSteps.push({ name: 'sigkill_timer', success: true });
    } catch {
      cancelSteps.push({ name: 'sigkill_timer', success: false });
    }

    // Step 6 (Task 1.5, 1.12 L1): Audit log the cancel event
    try {
      this.#auditor.write({
        timestamp: new Date().toISOString(),
        operation: 'agent.cancel',
        level: 'B',
        sessionId: '',
        result: 'rejected',
        reason: reason ?? 'cancelled',
        metadata: {
          spawnedPids: [...this.#spawnedPids],
          activeToolCalls: [...this.#activeToolCalls.keys()],
          cancelSteps: cancelSteps.length,
        },
      });
      cancelSteps.push({ name: 'audit_write', success: true });
    } catch {
      // Task 1.12 L2: Console fallback
      try {
        console.error('[cancel] audit write failed:', reason);
        cancelSteps.push({ name: 'audit_write_fallback_console', success: true });
      } catch {
        cancelSteps.push({ name: 'audit_write_fallback_console', success: false });
      }
      // Task 1.12 L3: In-memory ring buffer (Growth)
    }

    // Step 7 (Task 1.9, 1.13): Schedule cleanup scans
    try {
      this.#scheduleCleanupScans();
      cancelSteps.push({ name: 'cleanup_scans', success: true });
    } catch {
      cancelSteps.push({ name: 'cleanup_scans', success: false });
    }

    // Task 1.14: Log step outcomes if any step failed
    const failedSteps = cancelSteps.filter(s => !s.success).map(s => s.name);
    if (failedSteps.length > 0) {
      try {
        this.#auditor.write({
          timestamp: new Date().toISOString(),
          operation: 'agent.cancel.steps',
          level: 'B',
          sessionId: '',
          result: 'rejected',
          reason: 'partial cancel',
          metadata: {
            totalSteps: cancelSteps.length,
            succeeded: cancelSteps.filter(s => s.success).length,
            failed: failedSteps,
          },
        });
      } catch { /* last resort — swallow */ }
    }
  }

  // ---- ToolContext factory (Story 2.4: includes spawn wrapper) ----

  createToolContext(sessionId: string): ToolContext {
    return {
      sessionId,
      sandbox: this.#securityProvider.isSandboxAvailable() ? 'bwrap' : 'none',
      signal: this.#abortController.signal,
      security: this.#securityProvider,
      audit: (_action, _detail) => {},
      spawn: this.#createSpawnWrapper(),
    };
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

      this.#sessionStore.pushMessage(sessionId, {
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
        tools: this.#registry.toOpenAITools(),
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

          const tool = this.#registry.get(chunk.name);
          const allowed = !this.#allowedTools || this.#allowedTools.has(chunk.name);
          if (tool && allowed) {
            const ctx = this.createToolContext(sessionId);

            try {
              this.registerToolCall(chunk.id ?? chunk.name, chunk.name);
              const result = await tool.execute(chunk.arguments, ctx);
              yield { type: 'tool_result', toolCallId: chunk.name, content: JSON.stringify(result) };
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              yield { type: 'error', code: 'TOOLS_EXECUTION_FAILED', message: msg };
            } finally {
              this.unregisterToolCall(chunk.id ?? chunk.name);
            }

            this.#stateMachine.transition('tool_result');
          } else if (!tool) {
            yield { type: 'error', code: 'TOOLS_NOT_FOUND', message: `Tool not found: ${chunk.name}` };
          } else {
            // Tool exists in registry but is not in this agent's allow-list.
            yield { type: 'error', code: 'TOOLS_NOT_FOUND', message: `Tool not allowed for this agent: ${chunk.name}` };
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
}
