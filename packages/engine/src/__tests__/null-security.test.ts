// =============================================================================
// @zaivim/engine — NullSecurityProvider Tests
// =============================================================================

import { describe, it, expect, vi } from 'vitest';
import { NullSecurityProvider } from '../security/null-security.js';

describe('NullSecurityProvider', () => {
  describe('MVP placeholder behavior', () => {
    it('should have sandboxType "none"', () => {
      const provider = new NullSecurityProvider();
      expect(provider.sandboxType).toBe('none');
    });

    it('should not have sandbox available', () => {
      const provider = new NullSecurityProvider();
      expect(provider.isSandboxAvailable()).toBe(false);
    });
  });

  describe('preExecute', () => {
    it('should always allow operations', async () => {
      const provider = new NullSecurityProvider();
      const decision = await provider.preExecute('shell_exec', { command: 'rm -rf /' });

      expect(decision.allowed).toBe(true);
      expect(decision.harmLevel).toBe('C');
      expect(decision.reason).toBeTruthy();
    });

    it('should warn about no enforcement', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const provider = new NullSecurityProvider();

      await provider.preExecute('shell_exec', { command: 'test' });

      expect(consoleWarnSpy).toHaveBeenCalled();
      const warnMessage = consoleWarnSpy.mock.calls[0][0] as string;
      expect(warnMessage).toContain('Pre-execution check');
      expect(warnMessage).toContain('ALLOWED');

      consoleWarnSpy.mockRestore();
    });

    it('should handle any operation type', async () => {
      const provider = new NullSecurityProvider();

      const operations = ['shell_exec', 'file_write', 'file_read', 'network_request'];
      for (const op of operations) {
        const decision = await provider.preExecute(op, {});
        expect(decision.allowed).toBe(true);
      }
    });
  });

  describe('postExecute', () => {
    it('should log successful operations', async () => {
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const provider = new NullSecurityProvider();

      await provider.postExecute('shell_exec', { success: true, output: 'test output' });

      expect(consoleLogSpy).toHaveBeenCalled();
      const logMessages = consoleLogSpy.mock.calls.map(call => call[0] as string);
      expect(logMessages.some(msg => msg.includes('Post-execution') && msg.includes('SUCCESS'))).toBe(true);

      consoleLogSpy.mockRestore();
    });

    it('should log failed operations', async () => {
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const provider = new NullSecurityProvider();

      await provider.postExecute('shell_exec', { success: false, output: 'error' });

      expect(consoleLogSpy).toHaveBeenCalled();
      const logMessages = consoleLogSpy.mock.calls.map(call => call[0] as string);
      expect(logMessages.some(msg => msg.includes('Post-execution') && msg.includes('FAILED'))).toBe(true);

      consoleLogSpy.mockRestore();
    });

    it('should truncate long output', async () => {
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const provider = new NullSecurityProvider();

      const longOutput = 'x'.repeat(300);
      await provider.postExecute('test', { success: true, output: longOutput });

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('...'),
      );

      consoleLogSpy.mockRestore();
    });
  });

  describe('getStatus', () => {
    it('should return null security status', () => {
      const provider = new NullSecurityProvider();
      const status = provider.getStatus();

      expect(status.sandboxMode).toBe('null');
      expect(status.isOperational).toBe(false);
      expect(status.filesystemRestricted).toBe(false);
      expect(status.networkIsolated).toBe(false);
      expect(status.auditLogPath).toBe('none');
    });

    it('should detect platform correctly', () => {
      const provider = new NullSecurityProvider();
      const status = provider.getStatus();

      expect(['linux', 'macos', 'windows', 'unknown']).toContain(status.platform);
    });

    it('should include warning details', () => {
      const provider = new NullSecurityProvider();
      const status = provider.getStatus();

      expect(status.details).toBeDefined();
      expect(Array.isArray(status.details)).toBe(true);
      expect(status.details?.some(d => d.includes('NO ENFORCEMENT'))).toBe(true);
      expect(status.details?.some(d => d.includes('BwrapSecurityProvider'))).toBe(true);
    });
  });

  describe('legacy methods', () => {
    it('should always allow path validation', () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const provider = new NullSecurityProvider();

      const result = provider.validatePath('/etc/passwd', 'read');
      expect(result).toBe(true);

      const warnMessages = consoleWarnSpy.mock.calls.map(call => call[0] as string);
      expect(warnMessages.some(msg => msg.includes('validatePath') && msg.includes('no enforcement'))).toBe(true);

      consoleWarnSpy.mockRestore();
    });

    it('should always approve change proposals', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const provider = new NullSecurityProvider();

      const result = await provider.proposeChange({
        path: '/test',
        operation: 'create',
        reason: 'test',
      });

      expect(result).toBe(true);

      const warnMessages = consoleWarnSpy.mock.calls.map(call => call[0] as string);
      expect(warnMessages.some(msg => msg.includes('proposeChange') && msg.includes('no approval flow'))).toBe(true);

      consoleWarnSpy.mockRestore();
    });
  });

  describe('interface compliance', () => {
    it('should implement all required ISecurityProvider methods', () => {
      const provider = new NullSecurityProvider();

      expect(typeof provider.preExecute).toBe('function');
      expect(typeof provider.postExecute).toBe('function');
      expect(typeof provider.getStatus).toBe('function');
      expect(typeof provider.isSandboxAvailable).toBe('function');
      expect(typeof provider.validatePath).toBe('function');
      expect(typeof provider.proposeChange).toBe('function');
    });

    it('should have readonly sandboxType property', () => {
      const provider = new NullSecurityProvider();
      // TypeScript readonly is compile-time only, verify at runtime
      // that the property exists and has the correct value
      expect(provider.sandboxType).toBe('none');
      // Note: Runtime mutation is possible but TypeScript prevents it
    });
  });
});
