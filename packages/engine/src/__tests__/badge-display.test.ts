// @zaivim/engine — Badge Display Tests (Story 2.2, Task 7.4)
// Tests for harm level badge data format and correctness.

import { describe, it, expect } from 'vitest';
import { getBadge, getAllBadges, isElevatedRisk, isBlockingLevel } from '../security/badge-display.js';

describe('BadgeDisplay', () => {
  describe('getBadge', () => {
    it('should return S-level badge with red color', () => {
      const badge = getBadge('S');
      expect(badge.level).toBe('S');
      expect(badge.color).toBe('red');
      expect(badge.label).toBeTruthy();
      expect(badge.icon).toBeTruthy();
      expect(badge.description).toBeTruthy();
    });

    it('should return A-level badge with orange color', () => {
      const badge = getBadge('A');
      expect(badge.level).toBe('A');
      expect(badge.color).toBe('orange');
    });

    it('should return B-level badge with yellow color', () => {
      const badge = getBadge('B');
      expect(badge.level).toBe('B');
      expect(badge.color).toBe('yellow');
    });

    it('should return C-level badge with green color', () => {
      const badge = getBadge('C');
      expect(badge.level).toBe('C');
      expect(badge.color).toBe('green');
    });
  });

  describe('getAllBadges', () => {
    it('should return all four level badges', () => {
      const badges = getAllBadges();
      expect(badges).toHaveLength(4);
      const levels = badges.map(b => b.level);
      expect(levels).toContain('S');
      expect(levels).toContain('A');
      expect(levels).toContain('B');
      expect(levels).toContain('C');
    });
  });

  describe('isElevatedRisk', () => {
    it('should return true for S-level', () => {
      expect(isElevatedRisk('S')).toBe(true);
    });

    it('should return true for A-level', () => {
      expect(isElevatedRisk('A')).toBe(true);
    });

    it('should return false for B-level', () => {
      expect(isElevatedRisk('B')).toBe(false);
    });

    it('should return false for C-level', () => {
      expect(isElevatedRisk('C')).toBe(false);
    });
  });

  describe('isBlockingLevel', () => {
    it('should return true for S-level', () => {
      expect(isBlockingLevel('S')).toBe(true);
    });

    it('should return false for A-level', () => {
      expect(isBlockingLevel('A')).toBe(false);
    });

    it('should return false for B-level', () => {
      expect(isBlockingLevel('B')).toBe(false);
    });
  });

  describe('Badge data format', () => {
    it('should have all required fields for each level', () => {
      for (const level of ['S', 'A', 'B', 'C'] as const) {
        const badge = getBadge(level);
        expect(badge).toHaveProperty('level');
        expect(badge).toHaveProperty('color');
        expect(badge).toHaveProperty('label');
        expect(badge).toHaveProperty('icon');
        expect(badge).toHaveProperty('description');
        expect(typeof badge.level).toBe('string');
        expect(typeof badge.color).toBe('string');
        expect(typeof badge.label).toBe('string');
        expect(typeof badge.icon).toBe('string');
        expect(typeof badge.description).toBe('string');
      }
    });

    it('should have distinct colors for each level', () => {
      const colors = getAllBadges().map(b => b.color);
      expect(new Set(colors).size).toBe(4); // All unique
    });
  });
});
