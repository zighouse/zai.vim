// @zaivim/gateway — security-status CLI tests

import { describe, it, expect } from 'vitest';
import { getSecurityStatus, printSecurityStatus } from '../cli/security-status.js';

describe('getSecurityStatus', () => {
  it('should return a valid SecurityStatus object', () => {
    const status = getSecurityStatus();
    expect(status).toBeDefined();
    expect(['bwrap', 'null', 'degraded']).toContain(status.sandboxMode);
    expect(['linux', 'macos', 'windows', 'unknown']).toContain(status.platform);
    expect(typeof status.filesystemRestricted).toBe('boolean');
    expect(typeof status.networkIsolated).toBe('boolean');
    expect(typeof status.auditLogPath).toBe('string');
    expect(typeof status.isOperational).toBe('boolean');
  });

  it('should include details array', () => {
    const status = getSecurityStatus();
    expect(Array.isArray(status.details)).toBe(true);
    expect(status.details!.length).toBeGreaterThan(0);
  });
});

describe('printSecurityStatus', () => {
  it('should not throw when printing', () => {
    const status = getSecurityStatus();
    expect(() => printSecurityStatus(status)).not.toThrow();
  });
});
