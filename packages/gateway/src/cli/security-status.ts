// @zaivim/engine — security-status CLI command
// Standalone diagnostic: checks bwrap availability, platform, and sandbox config.
// Works without a running engine.

import { platform } from 'node:os';
import { existsSync } from 'node:fs';
import type { SecurityStatus } from '@zaivim/core';

function detectPlatform(): SecurityStatus['platform'] {
  const p = platform();
  if (p === 'linux') return 'linux';
  if (p === 'darwin') return 'macos';
  if (p === 'win32') return 'windows';
  return 'unknown';
}

function checkBwrapAvailable(): boolean {
  try {
    return existsSync('/usr/bin/bwrap') || existsSync('/bin/bwrap');
  } catch {
    return false;
  }
}

export function getSecurityStatus(): SecurityStatus {
  const detectedPlatform = detectPlatform();
  const bwrapAvailable = detectedPlatform === 'linux' && checkBwrapAvailable();

  if (detectedPlatform === 'linux' && bwrapAvailable) {
    return {
      sandboxMode: 'bwrap',
      platform: detectedPlatform,
      filesystemRestricted: true,
      networkIsolated: true,
      auditLogPath: '~/.zaivim/logs/audit.jsonl',
      isOperational: true,
      details: [
        'Sandbox: bubblewrap (bwrap)',
        'Platform: Linux',
        'Filesystem isolation: enabled (ro-bind system dirs)',
        'Network isolation: enabled (--unshare-net)',
        'Process isolation: enabled (--unshare-all, --die-with-parent)',
        'Bwrap available: yes',
      ],
    };
  }

  if (detectedPlatform === 'linux' && !bwrapAvailable) {
    return {
      sandboxMode: 'degraded',
      platform: detectedPlatform,
      filesystemRestricted: false,
      networkIsolated: false,
      auditLogPath: '~/.zaivim/logs/audit.jsonl',
      isOperational: false,
      details: [
        'Sandbox: degraded (bwrap not installed)',
        'Platform: Linux',
        'Filesystem isolation: disabled',
        'Network isolation: disabled',
        'Bwrap available: no',
        'Install: apt install bubblewrap  (or your distro equivalent)',
      ],
    };
  }

  return {
    sandboxMode: 'null',
    platform: detectedPlatform,
    filesystemRestricted: false,
    networkIsolated: false,
    auditLogPath: '~/.zaivim/logs/audit.jsonl',
    isOperational: false,
    details: [
      `Sandbox: null (no bwrap support on ${detectedPlatform})`,
      `Platform: ${detectedPlatform}`,
      'Filesystem isolation: disabled',
      'Network isolation: disabled',
      'Consider using Linux for full sandbox protection',
    ],
  };
}

export function printSecurityStatus(status: SecurityStatus): void {
  const icon = status.isOperational ? '✓' : '✗';
  console.log(`${icon} Security Status`);
  console.log('');
  console.log(`  Sandbox mode:    ${status.sandboxMode}`);
  console.log(`  Platform:        ${status.platform}`);
  console.log(`  Filesystem:      ${status.filesystemRestricted ? 'restricted' : 'not restricted'}`);
  console.log(`  Network:         ${status.networkIsolated ? 'isolated' : 'not isolated'}`);
  console.log(`  Audit log:       ${status.auditLogPath}`);
  console.log(`  Operational:     ${status.isOperational ? 'yes' : 'no'}`);
  console.log('');
  if (status.details && status.details.length > 0) {
    console.log('  Details:');
    for (const detail of status.details) {
      console.log(`    · ${detail}`);
    }
  }
}
