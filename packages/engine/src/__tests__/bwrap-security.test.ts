// =============================================================================
// @zaivim/engine — BwrapSecurityProvider Tests
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BwrapSecurityProvider } from '../security/bwrap-security.js';
import * as fs from 'node:fs';

// Mock child_process and fs
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
}));

describe('BwrapSecurityProvider', () => {
  let mockExistsSync: unknown;

  beforeEach(() => {
    // Reset mocks
    mockExistsSync = vi.mocked(fs).existsSync;
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Platform detection', () => {
    it('should detect current platform', () => {
      vi.mocked(mockExistsSync).mockReturnValue(true);

      const provider = new BwrapSecurityProvider('/workspace', '/audit/audit.jsonl');
      const status = provider.getStatus();

      expect(['linux', 'macos', 'windows', 'unknown']).toContain(status.platform);
    });

    it('should report sandbox availability based on bwrap existence', () => {
      vi.mocked(mockExistsSync).mockReturnValue(true);

      const provider = new BwrapSecurityProvider('/workspace', '/audit/audit.jsonl');

      // On Linux with bwrap available, should be operational
      if (process.platform === 'linux') {
        expect(provider.isSandboxAvailable()).toBe(true);
        expect(provider.getStatus().isOperational).toBe(true);
      } else {
        expect(provider.isSandboxAvailable()).toBe(false);
        expect(provider.getStatus().isOperational).toBe(false);
      }
    });
  });

  describe('bwrap availability detection', () => {
    it('should detect bwrap availability based on platform', () => {
      vi.mocked(mockExistsSync).mockReturnValue(true);

      const provider = new BwrapSecurityProvider('/workspace', '/audit/audit.jsonl');

      // Only Linux should have bwrap available
      const isAvailable = provider.isSandboxAvailable();
      if (process.platform === 'linux') {
        expect(isAvailable).toBe(true);
        expect(provider.getStatus().sandboxMode).toBe('bwrap');
      } else {
        expect(isAvailable).toBe(false);
        expect(provider.getStatus().sandboxMode).toBe('degraded');
      }
    });

    it('should detect degraded mode when bwrap not found', () => {
      vi.mocked(mockExistsSync).mockReturnValue(false);

      const provider = new BwrapSecurityProvider('/workspace', '/audit/audit.jsonl');

      expect(provider.isSandboxAvailable()).toBe(false);

      const status = provider.getStatus();
      expect(['bwrap', 'degraded', 'null']).toContain(status.sandboxMode);

      if (process.platform === 'linux') {
        expect(status.sandboxMode).toBe('degraded');
        expect(status.isOperational).toBe(false);
      }
    });
  });

  describe('preExecute security checks', () => {
    beforeEach(() => {
      vi.mocked(mockExistsSync).mockReturnValue(process.platform === 'linux');
    });

    it('should allow safe shell commands on Linux', async () => {
      const provider = new BwrapSecurityProvider('/workspace', '/audit/audit.jsonl');

      if (process.platform !== 'linux') {
        // Non-Linux: should allow but warn about degraded mode
        const decision = await provider.preExecute('shell_exec', { command: 'ls -la' });
        expect(decision.allowed).toBe(true);
        return;
      }

      const decision = await provider.preExecute('shell_exec', { command: 'ls -la' });

      expect(decision.allowed).toBe(true);
      expect(decision.harmLevel).toBe('C');
    });

    it('should block destructive commands on Linux', async () => {
      const provider = new BwrapSecurityProvider('/workspace', '/audit/audit.jsonl');

      if (process.platform !== 'linux') {
        // Non-Linux: degraded mode allows but reports actual S-level
        const decision = await provider.preExecute('shell_exec', { command: 'rm -rf /' });
        expect(decision.allowed).toBe(true);
        expect(decision.harmLevel).toBe('S');
        expect(decision.reason).toContain('degraded');
        return;
      }

      const decision = await provider.preExecute('shell_exec', { command: 'rm -rf /' });

      expect(decision.allowed).toBe(false);
      expect(decision.harmLevel).toBe('S');
      expect(decision.reason).toContain('blocked');
      expect(decision.alternatives).toBeDefined();
    });

    it('should block empty commands', async () => {
      const provider = new BwrapSecurityProvider('/workspace', '/audit/audit.jsonl');

      const decision = await provider.preExecute('shell_exec', { command: '' });

      expect(decision.allowed).toBe(false);
      expect(decision.harmLevel).toBe('B');
    });

    it('should detect destructive patterns case-insensitively', async () => {
      const provider = new BwrapSecurityProvider('/workspace', '/audit/audit.jsonl');

      const destructiveCommands = [
        'RM -RF /',
        'Rm -Rf /usr',
        'DD IF=/dev/zero',
        'CHMOD 000 /etc',
      ];

      for (const cmd of destructiveCommands) {
        const decision = await provider.preExecute('shell_exec', { command: cmd });

        // On non-Linux, destructive commands are allowed but reported as S-level
        if (process.platform === 'linux') {
          expect(decision.allowed).toBe(false);
          expect(decision.harmLevel).toBe('S');
        } else {
          expect(decision.allowed).toBe(true);
          expect(decision.harmLevel).toBe('S');
          expect(decision.reason).toContain('degraded');
        }
      }
    });
  });

  describe('preExecute on non-Linux platforms', () => {
    it('should handle non-Linux platforms gracefully', async () => {
      vi.mocked(mockExistsSync).mockReturnValue(false);

      const provider = new BwrapSecurityProvider('/workspace', '/audit/audit.jsonl');

      if (process.platform === 'linux') {
        // Linux without bwrap
        vi.mocked(mockExistsSync).mockReturnValue(false);
        const linuxProvider = new BwrapSecurityProvider('/workspace', '/audit/audit.jsonl');
        const decision = await linuxProvider.preExecute('shell_exec', { command: 'test' });

        expect(decision.allowed).toBe(true);
        expect(decision.reason).toContain('degraded');
      } else {
        // Non-Linux
        const decision = await provider.preExecute('shell_exec', { command: 'test' });

        expect(decision.allowed).toBe(true);
        // 'test' is unknown → S-level in degraded mode
        expect(decision.harmLevel).toBe('S');
        expect(decision.reason).toContain('degraded');
      }
    });
  });

  describe('getStatus', () => {
    it('should report status based on platform and bwrap availability', () => {
      vi.mocked(mockExistsSync).mockReturnValue(process.platform === 'linux');

      const provider = new BwrapSecurityProvider('/workspace', '/audit/audit.jsonl');
      const status = provider.getStatus();

      expect(['linux', 'macos', 'windows', 'unknown']).toContain(status.platform);
      expect(['bwrap', 'degraded', 'null']).toContain(status.sandboxMode);

      // On Linux with bwrap, should be operational
      if (process.platform === 'linux' && status.sandboxMode === 'bwrap') {
        expect(status.isOperational).toBe(true);
        expect(status.filesystemRestricted).toBe(true);
        expect(status.networkIsolated).toBe(true);
      }
    });

    it('should report degraded status when bwrap unavailable', () => {
      vi.mocked(mockExistsSync).mockReturnValue(false);

      const provider = new BwrapSecurityProvider('/workspace', '/audit/audit.jsonl');
      const status = provider.getStatus();

      expect(status.isOperational).toBe(false);
      expect(['degraded', 'null']).toContain(status.sandboxMode);
      expect(status.filesystemRestricted).toBe(false);
      expect(status.networkIsolated).toBe(false);
    });

    it('should include relevant details', () => {
      vi.mocked(mockExistsSync).mockReturnValue(true);

      const provider = new BwrapSecurityProvider('/workspace', '/audit/audit.jsonl');
      const status = provider.getStatus();

      expect(status.details).toBeDefined();
      expect(Array.isArray(status.details)).toBe(true);
      expect(status.details.length).toBeGreaterThan(0);
    });
  });

  describe('postExecute', () => {
    it('should log execution results', async () => {
      vi.stubGlobal('platform', () => 'linux');
      vi.mocked(mockExistsSync).mockReturnValue(true);

      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const provider = new BwrapSecurityProvider('/workspace', '/audit/audit.jsonl');
      await provider.postExecute('shell_exec', { success: true, output: 'test output' });

      expect(consoleLogSpy).toHaveBeenCalled();
      const logMessage = consoleLogSpy.mock.calls[0][0] as string;
      expect(logMessage).toContain('Audit');

      consoleLogSpy.mockRestore();
    });
  });

  describe('legacy methods', () => {
    beforeEach(() => {
      vi.mocked(mockExistsSync).mockReturnValue(process.platform === 'linux');
    });

    it('should validate paths', () => {
      const provider = new BwrapSecurityProvider('/workspace', '/audit/audit.jsonl');

      expect(provider.validatePath('/workspace/test.txt', 'read')).toBe(true);
      expect(provider.validatePath('/workspace/.git/config', 'write')).toBe(false);
      expect(provider.validatePath('/workspace/.git/', 'read')).toBe(false);
    });

    it('should approve changes within workspace', async () => {
      const provider = new BwrapSecurityProvider('/workspace', '/audit/audit.jsonl');

      const result = await provider.proposeChange({
        path: '/workspace/test.txt',
        operation: 'create',
        reason: 'Test file creation',
      });

      expect(result).toBe(true);
    });

    it('should reject changes outside workspace', async () => {
      const provider = new BwrapSecurityProvider('/workspace', '/audit/audit.jsonl');

      const result = await provider.proposeChange({
        path: '/etc/passwd',
        operation: 'modify',
        reason: 'System modification',
      });

      expect(result).toBe(false);
    });
  });

  describe('interface compliance', () => {
    it('should implement all required ISecurityProvider methods', () => {
      vi.mocked(mockExistsSync).mockReturnValue(true);

      const provider = new BwrapSecurityProvider('/workspace', '/audit/audit.jsonl');

      expect(typeof provider.preExecute).toBe('function');
      expect(typeof provider.postExecute).toBe('function');
      expect(typeof provider.getStatus).toBe('function');
      expect(typeof provider.isSandboxAvailable).toBe('function');
      expect(typeof provider.validatePath).toBe('function');
      expect(typeof provider.proposeChange).toBe('function');
      expect(typeof provider.openFile).toBe('function');
    });

    it('should have correct sandboxType', () => {
      vi.mocked(mockExistsSync).mockReturnValue(true);

      const provider = new BwrapSecurityProvider('/workspace', '/audit/audit.jsonl');
      expect(provider.sandboxType).toBe('bwrap');
    });
  });

  describe('performance (AC7)', () => {
    it('should initialize within 100ms (sandbox startup latency)', () => {
      vi.mocked(mockExistsSync).mockReturnValue(true);

      const samples = 5;
      const durations: number[] = [];

      for (let i = 0; i < samples; i++) {
        const start = performance.now();
        const provider = new BwrapSecurityProvider('/workspace', '/audit/audit.jsonl');
        const elapsed = performance.now() - start;
        durations.push(elapsed);
        // Verify instance is functional after creation
        expect(provider.sandboxType).toBe('bwrap');
      }

      const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
      expect(avg).toBeLessThan(100);
    });
  });
});
