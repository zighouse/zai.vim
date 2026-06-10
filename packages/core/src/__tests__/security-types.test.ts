// =============================================================================
// @zaivim/core — Security Types Tests
// =============================================================================

import { describe, it, expect } from 'vitest';
import type {
  HarmLevel,
  SecurityDecision,
  SecurityStatus,
  AuditEntry,
  ISecurityProvider,
} from '../types/security.js';

describe('Security Types', () => {
  describe('HarmLevel', () => {
    it('should accept valid harm levels', () => {
      const levels: HarmLevel[] = ['S', 'A', 'B', 'C'];
      expect(levels).toHaveLength(4);
    });

    it('should represent destructive operations as S-level', () => {
      const severeLevel: HarmLevel = 'S';
      expect(severeLevel).toBe('S');
    });

    it('should represent system modifications as A-level', () => {
      const advancedLevel: HarmLevel = 'A';
      expect(advancedLevel).toBe('A');
    });

    it('should represent standard operations as B-level', () => {
      const basicLevel: HarmLevel = 'B';
      expect(basicLevel).toBe('B');
    });

    it('should represent read-only operations as C-level', () => {
      const commonLevel: HarmLevel = 'C';
      expect(commonLevel).toBe('C');
    });
  });

  describe('SecurityDecision', () => {
    it('should create allowed decision with required fields', () => {
      const decision: SecurityDecision = {
        allowed: true,
        harmLevel: 'C',
        reason: 'Read-only operation',
      };
      expect(decision.allowed).toBe(true);
      expect(decision.harmLevel).toBe('C');
      expect(decision.reason).toBe('Read-only operation');
    });

    it('should create denied decision with alternatives', () => {
      const decision: SecurityDecision = {
        allowed: false,
        harmLevel: 'S',
        reason: 'Destructive operation blocked',
        alternatives: ['Use safer command with confirmation', 'Review target path'],
      };
      expect(decision.allowed).toBe(false);
      expect(decision.harmLevel).toBe('S');
      expect(decision.alternatives).toHaveLength(2);
    });

    it('should require reason field', () => {
      const decision: SecurityDecision = {
        allowed: false,
        harmLevel: 'A',
        reason: 'System modification requires approval',
      };
      expect(decision.reason).toBeTruthy();
      expect(typeof decision.reason).toBe('string');
    });
  });

  describe('SecurityStatus', () => {
    it('should represent bwrap sandbox mode', () => {
      const status: SecurityStatus = {
        sandboxMode: 'bwrap',
        platform: 'linux',
        filesystemRestricted: true,
        networkIsolated: true,
        auditLogPath: '/var/log/zaivim/audit.jsonl',
        isOperational: true,
      };
      expect(status.sandboxMode).toBe('bwrap');
      expect(status.isOperational).toBe(true);
    });

    it('should represent degraded mode with details', () => {
      const status: SecurityStatus = {
        sandboxMode: 'degraded',
        platform: 'macos',
        filesystemRestricted: false,
        networkIsolated: false,
        auditLogPath: '/tmp/zaivim-audit.jsonl',
        isOperational: false,
        details: [
          'bwrap not available on macOS',
          'Using null security provider',
          'Manual approval required for risky operations',
        ],
      };
      expect(status.isOperational).toBe(false);
      expect(status.details).toHaveLength(3);
    });

    it('should support all platform types', () => {
      const platforms: Array<'linux' | 'macos' | 'windows' | 'unknown'> = [
        'linux',
        'macos',
        'windows',
        'unknown',
      ];
      expect(platforms).toHaveLength(4);
    });
  });

  describe('AuditEntry', () => {
    it('should create audit entry with required fields', () => {
      const entry: AuditEntry = {
        timestamp: '2026-06-10T12:00:00Z',
        sessionId: 'sess-123',
        operation: 'shell_exec',
        harmLevel: 'C',
        decision: 'allowed',
        reason: 'Safe command',
      };
      expect(entry.operation).toBe('shell_exec');
      expect(entry.decision).toBe('allowed');
    });

    it('should include metadata for operation-specific data', () => {
      const entry: AuditEntry = {
        timestamp: '2026-06-10T12:00:00Z',
        sessionId: 'sess-123',
        operation: 'file_write',
        harmLevel: 'B',
        decision: 'allowed',
        reason: 'File write approved',
        metadata: {
          filePath: '/workspace/test.txt',
          fileSize: 1024,
        },
      };
      expect(entry.metadata?.filePath).toBe('/workspace/test.txt');
    });

    it('should track user acknowledgment for overrides', () => {
      const entry: AuditEntry = {
        timestamp: '2026-06-10T12:00:00Z',
        sessionId: 'sess-123',
        operation: 'shell_exec',
        harmLevel: 'A',
        decision: 'allowed',
        reason: 'User acknowledged risk',
        userAcknowledged: true,
      };
      expect(entry.userAcknowledged).toBe(true);
    });
  });

  describe('ISecurityProvider interface', () => {
    it('should define required methods', () => {
      // Type check only - ensure interface structure is correct
      const provider: ISecurityProvider = {
        sandboxType: 'bwrap',
        preExecute: async (op, params) => ({
          allowed: true,
          harmLevel: 'C',
          reason: 'Test',
        }),
        postExecute: async (op, result) => {},
        getStatus: () => ({
          sandboxMode: 'bwrap',
          platform: 'linux',
          filesystemRestricted: true,
          networkIsolated: true,
          auditLogPath: '/test/audit.jsonl',
          isOperational: true,
        }),
        isSandboxAvailable: () => true,
        validatePath: (path, op) => true,
        proposeChange: async (proposal) => true,
      };

      expect(provider.sandboxType).toBe('bwrap');
      expect(typeof provider.preExecute).toBe('function');
      expect(typeof provider.postExecute).toBe('function');
      expect(typeof provider.getStatus).toBe('function');
      expect(typeof provider.isSandboxAvailable).toBe('function');
    });

    it('should require sandboxType property', () => {
      const sandboxTypes: Array<'none' | 'bwrap' | 'sandbox-exec' | 'wsl2'> = [
        'none',
        'bwrap',
        'sandbox-exec',
        'wsl2',
      ];
      expect(sandboxTypes).toHaveLength(4);
    });
  });

  describe('Type compatibility', () => {
    it('should allow ISecurityProvider in ToolContext', () => {
      // Test that ISecurityProvider is compatible with ToolContext.security
      const mockProvider: ISecurityProvider = {
        sandboxType: 'bwrap',
        preExecute: async () => ({ allowed: true, harmLevel: 'C', reason: 'OK' }),
        postExecute: async () => {},
        getStatus: () => ({
          sandboxMode: 'bwrap',
          platform: 'linux',
          filesystemRestricted: true,
          networkIsolated: true,
          auditLogPath: '/test',
          isOperational: true,
        }),
        isSandboxAvailable: () => true,
        validatePath: () => true,
        proposeChange: async () => true,
      };

      // If this compiles, types are compatible
      const security = mockProvider;
      expect(security.sandboxType).toBe('bwrap');
    });

    it('should support all sandbox modes in SecurityStatus', () => {
      const modes: Array<'bwrap' | 'null' | 'degraded' | 'sandbox-exec' | 'wsl2'> = [
        'bwrap',
        'null',
        'degraded',
        'sandbox-exec',
        'wsl2',
      ];
      expect(modes).toHaveLength(5);
    });
  });
});
