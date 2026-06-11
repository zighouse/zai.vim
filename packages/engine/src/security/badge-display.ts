// @zaivim/engine — Badge Display (Story 2.2, Task 3)
// Security level badge definitions and helpers for UI display.

import type { HarmLevel, HarmLevelBadge } from '@zaivim/core';

/**
 * Badge configuration per harm level (AC5 / FR31)
 */
const BADGE_CONFIG: Record<HarmLevel, HarmLevelBadge> = {
  S: {
    level: 'S',
    color: 'red',
    label: '危险',
    icon: '🔴',
    description: '此操作有严重安全风险，已被自动阻止',
  },
  A: {
    level: 'A',
    color: 'orange',
    label: '警告',
    icon: '🟠',
    description: '此操作将修改系统配置或安装软件，请确认',
  },
  B: {
    level: 'B',
    color: 'yellow',
    label: '注意',
    icon: '🟡',
    description: '此操作有潜在影响，已记录审计',
  },
  C: {
    level: 'C',
    color: 'green',
    label: '安全',
    icon: '🟢',
    description: '只读操作或无风险',
  },
};

/**
 * Get badge for a harm level
 */
export function getBadge(level: HarmLevel): HarmLevelBadge {
  return BADGE_CONFIG[level];
}

/**
 * Get all badge definitions
 */
export function getAllBadges(): HarmLevelBadge[] {
  return Object.values(BADGE_CONFIG);
}

/**
 * Check if a badge level indicates elevated risk
 */
export function isElevatedRisk(level: HarmLevel): boolean {
  return level === 'S' || level === 'A';
}

/**
 * Check if a badge level is blocking (S-level always blocks, A-level blocks write/delete)
 */
export function isBlockingLevel(level: HarmLevel): boolean {
  return level === 'S';
}
