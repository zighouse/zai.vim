// @zaivim/engine — Harm Classifier File Operation Tests (Story 2.2, Task 7.1)
// Tests for file operation classification covering S/A/B/C level path patterns.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, symlinkSync, rmdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HarmClassifier } from '../security/harm-classifier.js';

describe('HarmClassifier — File Operations', () => {
  let classifier: HarmClassifier;
  let tmpDir: string;

  beforeAll(() => {
    classifier = new HarmClassifier();
    tmpDir = mkdtempSync(join(tmpdir(), 'hc-test-'));
  });

  afterAll(() => {
    if (existsSync(tmpDir)) {
      rmdirSync(tmpDir, { recursive: true });
    }
  });

  // ============================================================================
  // S-level path patterns  (Subtask 1.2)
  // ============================================================================

  describe('S-level file paths', () => {
    it('should classify write to /etc/ as S-level', () => {
      const result = classifier.classifyFileOperation('/etc/passwd', 'write');
      expect(result.harmLevel).toBe('S');
      expect(result.reason).toContain('system file modification');
    });

    it('should classify write to /boot/ as S-level', () => {
      const result = classifier.classifyFileOperation('/boot/vmlinuz', 'write');
      expect(result.harmLevel).toBe('S');
    });

    it('should classify write to /sys/ as S-level', () => {
      const result = classifier.classifyFileOperation('/sys/class/backlight', 'write');
      expect(result.harmLevel).toBe('S');
    });

    it('should classify delete of /etc/ file as S-level', () => {
      const result = classifier.classifyFileOperation('/etc/hosts', 'delete');
      expect(result.harmLevel).toBe('S');
    });

    it('should classify read of /etc/shadow as S-level', () => {
      const result = classifier.classifyFileOperation('/etc/shadow', 'read');
      expect(result.harmLevel).toBe('S');
    });

    it('should classify write to /proc/ as S-level', () => {
      const result = classifier.classifyFileOperation('/proc/cpuinfo', 'write');
      expect(result.harmLevel).toBe('S');
    });

    it('should classify write to /usr/ as S-level', () => {
      const result = classifier.classifyFileOperation('/usr/local/bin/test', 'write');
      expect(result.harmLevel).toBe('S');
    });

    it('should classify write to /bin/ as S-level', () => {
      const result = classifier.classifyFileOperation('/bin/myapp', 'write');
      expect(result.harmLevel).toBe('S');
    });
  });

  // ============================================================================
  // A-level path patterns  (Subtask 1.3)
  // ============================================================================

  describe('A-level file paths', () => {
    it('should classify write to ~/.ssh/ as A-level', () => {
      const result = classifier.classifyFileOperation('~/.ssh/config', 'write');
      expect(result.harmLevel).toBe('A');
      expect(result.reason).toContain('SSH configuration');
    });

    it('should classify write to ~/.aws/ as A-level', () => {
      const result = classifier.classifyFileOperation('~/.aws/credentials', 'write');
      expect(result.harmLevel).toBe('A');
    });

    it('should classify write to ~/.kube/ as A-level', () => {
      const result = classifier.classifyFileOperation('~/.kube/config', 'write');
      expect(result.harmLevel).toBe('A');
    });

    it('should classify delete of ~/.ssh/ as A-level', () => {
      const result = classifier.classifyFileOperation('~/.ssh/known_hosts', 'delete');
      expect(result.harmLevel).toBe('A');
    });

    it('should classify write to .env as A-level', () => {
      const result = classifier.classifyFileOperation('/project/.env', 'write');
      expect(result.harmLevel).toBe('A');
    });

    it('should classify write to .env.production as A-level', () => {
      const result = classifier.classifyFileOperation('/project/.env.production', 'write');
      expect(result.harmLevel).toBe('A');
    });
  });

  // ============================================================================
  // B-level: write/delete outside project  (Subtask 1.4)
  // ============================================================================

  describe('B-level file paths', () => {
    it('should classify write to project-adjacent path as B-level', () => {
      const result = classifier.classifyFileOperation('/tmp/somefile', 'write');
      expect(result.harmLevel).toBe('B');
    });

    it('should classify delete of /tmp/file as B-level', () => {
      const result = classifier.classifyFileOperation('/tmp/old.log', 'delete');
      expect(result.harmLevel).toBe('B');
    });
  });

  // ============================================================================
  // C-level: read within project  (Subtask 1.5)
  // ============================================================================

  describe('C-level file paths', () => {
    it('should classify read of normal file as C-level', () => {
      const result = classifier.classifyFileOperation('./src/index.ts', 'read');
      expect(result.harmLevel).toBe('C');
    });

    it('should classify read of /tmp/file as C-level', () => {
      const result = classifier.classifyFileOperation('/tmp/readme.txt', 'read');
      expect(result.harmLevel).toBe('C');
    });
  });

  // ============================================================================
  // Path resolution security  (Subtask 1.6)
  // ============================================================================

  describe('Path resolution security', () => {
    it('should resolve ~ to home directory', () => {
      const result = classifier.resolveSecurePath('~/test.txt');
      expect(result).not.toContain('~');
      expect(result).toContain('test.txt');
    });

    it('should resolve ~user to home directory', () => {
      const result = classifier.resolveSecurePath('~/.ssh/config');
      expect(result).not.toContain('~');
      expect(result).toContain('.ssh');
    });

    it('should not crash on empty path', () => {
      const result = classifier.resolveSecurePath('');
      expect(typeof result).toBe('string');
    });
  });

  // ============================================================================
  // Empty / invalid paths  (Subtask 1.9)
  // ============================================================================

  describe('Edge cases', () => {
    it('should handle empty path gracefully', () => {
      const result = classifier.classifyFileOperation('', 'write');
      expect(result.harmLevel).toBe('S'); // Blocked by default
    });

    it('should handle read of system path as S for sensitive patterns', () => {
      const result = classifier.classifyFileOperation('/etc/certificates/ssl.crt', 'read');
      expect(result.harmLevel).toBe('S');
    });
  });
});
