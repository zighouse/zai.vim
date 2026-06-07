import { describe, it, expect, vi } from 'vitest';
import { NullSecurityProvider } from '../null-security.js';

describe('NullSecurityProvider', () => {
  it('should log warning on construction', () => {
    const log = vi.fn();
    new NullSecurityProvider(log);
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({ type: 'security.fallback', reason: 'security module not loaded' }),
    );
  });

  it('should allow all path validations', () => {
    const sec = new NullSecurityProvider();
    expect(sec.validatePath('/etc/passwd', 'read')).toBe(true);
    expect(sec.validatePath('/any/path', 'write')).toBe(true);
  });

  it('should approve all change proposals', async () => {
    const sec = new NullSecurityProvider();
    const result = await sec.proposeChange({
      path: '/dangerous/path',
      operation: 'delete',
      reason: 'any reason',
    });
    expect(result).toBe(true);
  });

  it('should report sandbox as unavailable', () => {
    const sec = new NullSecurityProvider();
    expect(sec.isSandboxAvailable()).toBe(false);
  });

  it('should have sandboxType none', () => {
    const sec = new NullSecurityProvider();
    expect(sec.sandboxType).toBe('none');
  });
});
