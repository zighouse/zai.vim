// @zaivim/engine — Risk Card Tests (Story 2.2, Task 7.3)
// Tests for risk card generation covering all harm levels and template correctness.

import { describe, it, expect } from 'vitest';
import { generateRiskCard } from '../security/risk-card.js';

describe('RiskCard', () => {
  describe('S-level risk cards', () => {
    it('should generate risk card for system file modification', () => {
      const card = generateRiskCard('S', 'system file modification attempted — resolved path: /etc/passwd', 'file_write');
      expect(card.harmLevel).toBe('S');
      expect(card.severity).toBe('danger');
      expect(card.risk).toContain('系统关键文件');
      expect(card.consequences.length).toBeGreaterThan(0);
      expect(card.alternatives.length).toBeGreaterThan(0);
      expect(card.overrideInstructions).toBeTruthy();
    });

    it('should generate risk card for SSH key access', () => {
      const card = generateRiskCard('S', 'SSH key read — resolved path: ~/.ssh/id_rsa', 'file_read');
      expect(card.severity).toBe('danger');
      expect(card.risk).toContain('SSH');
    });

    it('should generate risk card for AWS credential access', () => {
      const card = generateRiskCard('S', 'AWS credential read', 'file_read');
      expect(card.risk).toContain('AWS');
    });

    it('should fall back to default S template for unknown patterns', () => {
      const card = generateRiskCard('S', 'some unknown reason', 'shell_exec');
      expect(card.severity).toBe('danger');
      expect(card.risk).toBeTruthy();
      expect(card.templateVersion).toBeTruthy();
    });
  });

  describe('A-level risk cards', () => {
    it('should generate risk card for SSH configuration modification', () => {
      const card = generateRiskCard('A', 'SSH configuration modification', 'file_write');
      expect(card.severity).toBe('warning');
      expect(card.risk).toContain('SSH');
    });
  });

  describe('B-level risk cards', () => {
    it('should generate risk card for B-level with default template', () => {
      const card = generateRiskCard('B', 'File write operation', 'file_write');
      expect(card.harmLevel).toBe('B');
      expect(card.severity).toBe('warning');
      expect(card.risk).toBeTruthy();
    });
  });

  describe('C-level risk cards', () => {
    it('should generate risk card for C-level', () => {
      const card = generateRiskCard('C', 'File read operation', 'file_read');
      expect(card.harmLevel).toBe('C');
      expect(card.risk).toBeTruthy();
    });
  });

  describe('Template version', () => {
    it('should include template version in all cards', () => {
      for (const level of ['S', 'A', 'B', 'C'] as const) {
        const card = generateRiskCard(level, 'test reason', 'test_op');
        expect(card.templateVersion).toBeTruthy();
        expect(card.templateVersion.split('.').length).toBe(3);
      }
    });

    it('should override with operation-specific instructions for S-level', () => {
      const card = generateRiskCard('S', 'GPG key read', 'file_read');
      expect(card.overrideInstructions).toContain('GPG');
    });
  });
});
