// @zaivim/engine — SubSandboxManager
// Story 3.4: lifecycle manager for isolated sub-sandboxes (AC5 concurrency cap,
// AC3 destroyAll on engine shutdown).
//
// Responsibilities:
//   - Track every active SubSandboxProvider by sandboxId
//   - Enforce maxConcurrency (default 5) — refuses when at capacity
//   - Provide destroyAll() for the engine ShutdownSequencer
//   - Plumb per-instance audit through a single callback

import type { SubSandboxConfig } from '@zaivim/core';
import { ZaiError } from '@zaivim/core';
import { SubSandboxProvider, DEFAULT_SUBSANDBOX_CONFIG } from './sub-sandbox.js';

export interface SubSandboxManagerOptions {
  readonly workspaceDir: string;
  readonly config?: Partial<SubSandboxConfig>;
  readonly onAudit?: (action: string, detail: Record<string, unknown>) => void;
}

/**
 * SubSandboxManager — owns the lifecycle of all active SubSandboxProvider
 * instances. The engine holds one manager and threads it into ToolExecutor
 * for high-risk dispatch (Story 3.4 Task 3 & 4).
 *
 * AC5: create() refuses with ISOLATED_CONCURRENCY_LIMIT when the active set
 *      reaches `config.maxConcurrency`.
 * AC3: destroyAll() iterates and waits for each provider's destroy() — used by
 *      the engine ShutdownSequencer on graceful termination.
 */
export class SubSandboxManager {
  readonly #sandboxes = new Map<string, SubSandboxProvider>();
  readonly #config: SubSandboxConfig;
  readonly #workspaceDir: string;
  readonly #audit?: (action: string, detail: Record<string, unknown>) => void;

  constructor(options: SubSandboxManagerOptions) {
    this.#workspaceDir = options.workspaceDir;
    this.#config = { ...DEFAULT_SUBSANDBOX_CONFIG, ...options.config };
    this.#audit = options.onAudit;
  }

  get activeCount(): number {
    return this.#sandboxes.size;
  }

  get maxConcurrency(): number {
    return this.#config.maxConcurrency;
  }

  get config(): Readonly<SubSandboxConfig> {
    return this.#config;
  }

  /**
   * Create a new SubSandboxProvider. Throws ISOLATED_CONCURRENCY_LIMIT when
   * the active set is already at capacity (AC5).
   *
   * Callers are expected to release the provider either by calling destroy()
   * directly or by binding it to a `using` declaration so [Symbol.dispose]
   * invokes destroy() at scope exit.
   */
  create(): SubSandboxProvider {
    if (this.#sandboxes.size >= this.#config.maxConcurrency) {
      this.#audit?.('isolated.concurrency_rejected', {
        activeCount: this.#sandboxes.size,
        maxConcurrency: this.#config.maxConcurrency,
      });
      throw new ZaiError(
        `maximum concurrent isolated executions reached (${this.#config.maxConcurrency})`,
        'ISOLATED_CONCURRENCY_LIMIT',
        429,
        { activeCount: this.#sandboxes.size, maxConcurrency: this.#config.maxConcurrency },
      );
    }
    const provider = new SubSandboxProvider(
      this.#workspaceDir,
      this.#config,
      this.#audit,
    );
    this.#sandboxes.set(provider.sandboxId, provider);
    this.#audit?.('isolated.create', {
      sandboxId: provider.sandboxId,
      activeCount: this.#sandboxes.size,
    });
    return provider;
  }

  /**
   * Destroy a single sub-sandbox by id. Resolves even if the id is unknown
   * (idempotent). Removes the entry from the active set so a subsequent
   * create() can succeed.
   */
  async destroy(sandboxId: string): Promise<void> {
    const provider = this.#sandboxes.get(sandboxId);
    if (!provider) return;
    await provider.destroy();
    this.#sandboxes.delete(sandboxId);
    this.#audit?.('isolated.destroy', {
      sandboxId,
      activeCount: this.#sandboxes.size,
    });
  }

  /**
   * Destroy every active sub-sandbox. Called by the engine ShutdownSequencer
   * during graceful termination (AC3, no residue). Best-effort: each destroy
   * is awaited but a rejection does not block the rest of the cleanup.
   */
  async destroyAll(): Promise<void> {
    const ids = Array.from(this.#sandboxes.keys());
    await Promise.allSettled(ids.map((id) => this.destroy(id)));
  }

  /** Test/inspection helper: list active sandbox ids (defensive copy). */
  listActiveIds(): readonly string[] {
    return Array.from(this.#sandboxes.keys());
  }
}
