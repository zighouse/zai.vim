// @zaivim/engine — SecurityEnricher Pipeline Middleware (Story 2.2, Task 3.3)
// Sits after ToolExecutor and enriches tool_call responses with harmLevel and badge info.

import type { HarmLevel, HarmLevelBadge, ResponseChunk } from '@zaivim/core';
import { getBadge } from '../security/badge-display.js';

/**
 * Enriched tool call result with security context
 */
export interface EnrichedChunk extends ResponseChunk {
  harmLevel?: HarmLevel;
  badge?: HarmLevelBadge;
}

/**
 * SecurityEnricher — Pipeline middleware
 *
 * MUST be registered after ToolExecutor in the pipeline.
 * Startup validation ensures this constraint (Subtask 3.3.1).
 *
 * Converts SecurityDecision to transport format and attaches
 * harmLevel/badge to each tool_call chunk via independent context
 * (prevents race conditions in parallel tool calls — Subtask 3.3).
 */
export class SecurityEnricher {
  #active: boolean;

  constructor() {
    this.#active = true;
  }

  /**
   * Enrich a response chunk with security context
   *
   * @param chunk - The response chunk to enrich
   * @param harmLevel - Optional harm level from preExecute
   * @returns Enriched chunk with harmLevel and badge
   */
  enrich(chunk: ResponseChunk, harmLevel?: HarmLevel): EnrichedChunk {
    if (!this.#active) return chunk as EnrichedChunk;

    // Only enrich tool_call chunks (Subtask 3.4)
    if (chunk.type !== 'tool_call') return chunk as EnrichedChunk;

    // If no harmLevel from context, skip enrichment
    if (!harmLevel) return chunk as EnrichedChunk;

    const badge = getBadge(harmLevel);

    return {
      ...chunk,
      harmLevel,
      badge,
    };
  }

  /**
   * Generate tool security notification event data
   */
  toNotification(toolCallId: string, harmLevel: HarmLevel): {
    type: 'tool.security';
    toolCallId: string;
    harmLevel: HarmLevel;
    badge: HarmLevelBadge;
  } {
    return {
      type: 'tool.security',
      toolCallId,
      harmLevel,
      badge: getBadge(harmLevel),
    };
  }

  /**
   * Shutdown the enricher
   */
  shutdown(): void {
    this.#active = false;
  }
}
