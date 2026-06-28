// @zaivim/tools — Test utilities
// Factory functions for creating mock tool context objects in tests.

import type { ToolContext, FileChangeProposal, ISecurityProvider } from '@zaivim/core';

/** Create a mock ToolContext with sensible defaults. */
export function createMockToolContext(overrides?: Partial<ToolContext>): ToolContext {
  const abortSignal = new AbortController().signal;
  return {
    sessionId: 'test-session',
    sandbox: 'none',
    signal: abortSignal,
    security: {
      sandboxType: 'none',
      validatePath: () => ({ allowed: true }),
      validateOperation: () => ({ allowed: true, riskLevel: 'C' }),
      isSandboxAvailable: () => false,
    } as ISecurityProvider,
    audit: () => {},
    spawn: () => ({ pid: 0 } as any),
    ...overrides,
  };
}

/** Create a mock FileChangeProposal with sensible defaults. */
export function createMockFileChangeProposal(overrides?: Partial<FileChangeProposal>): FileChangeProposal {
  return {
    path: '/tmp/test-file.ts',
    operation: 'modify',
    diff: '--- a/test.ts\n+++ b/test.ts\n@@ -1 +1 @@\n-old\n+new',
    reason: 'Test change',
    ...overrides,
  };
}
