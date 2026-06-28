// @zaivim/skills — Test utilities
// Factory functions for creating mock skill objects in tests.

import type { SkillAdapter, SkillInput, SkillOutput } from '@zaivim/core';

/** Create a mock SkillAdapter with sensible defaults. */
export function createMockSkillAdapter(overrides?: Partial<SkillAdapter>): SkillAdapter {
  return {
    name: 'mock-skill',
    version: '1.0.0',
    description: 'A mock skill for testing',
    execute: async (_input: SkillInput): Promise<SkillOutput> => ({ content: 'mock result' }),
    ...overrides,
  };
}

/** Create a mock SkillDefinition-shaped object. */
export function createMockSkillDefinition(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    name: 'mock-skill-def',
    description: 'Mock skill definition for testing',
    ...overrides,
  };
}
