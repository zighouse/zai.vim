// @zaivim/engine — Mock session factories
// Used by: pipeline.test.ts, agent-handle.test.ts, tool-executor.test.ts

import type { Session, ZaiConfig } from '@zaivim/core';

export function createMockSession(opts?: Partial<Session>): Session {
  return {
    id: 'mock-session',
    messages: [],
    createdAt: Date.now(),
    config: {} as ZaiConfig,
    status: 'active',
    ...opts,
  };
}
