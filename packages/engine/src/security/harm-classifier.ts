// @zaivim/engine — Harm Classifier
// Command harm level classification for security enforcement

import type { HarmLevel } from '@zaivim/core';

/**
 * Command classification result
 */
export interface CommandClassification {
  /** Classified harm level */
  readonly level: HarmLevel;
  /** Human-readable explanation */
  readonly reason: string;
  /** Whether command is whitelisted */
  readonly whitelisted: boolean;
  /** Whitelist reason (if whitelisted) */
  readonly whitelistReason?: string;
}

/**
 * Command pattern for harm classification
 */
interface CommandPattern {
  /** Pattern to match (supports wildcards) */
  readonly pattern: string;
  /** Harm level for this pattern */
  readonly level: HarmLevel;
  /** Description of why this level */
  readonly reason: string;
}

/**
 * Harm classifier for shell commands
 *
 * Classifies commands by harm level (S/A/B/C) based on command patterns.
 * Supports whitelist mechanism for user-approved commands.
 */
export class HarmClassifier {
  private whitelist: Map<string, string> = new Map();

  /** S-level (Severe): Destructive operations */
  private static readonly S_LEVEL_PATTERNS: CommandPattern[] = [
    { pattern: 'rm -rf', level: 'S', reason: 'destructive: recursive deletion command' },
    { pattern: 'rm -R', level: 'S', reason: 'destructive: recursive deletion command' },
    { pattern: 'rm -r', level: 'S', reason: 'destructive: recursive deletion command' },
    { pattern: 'mkfs', level: 'S', reason: 'Filesystem formatting' },
    { pattern: 'dd if=', level: 'S', reason: 'Direct disk write' },
    { pattern: 'chmod 000', level: 'S', reason: 'Permission removal' },
    { pattern: 'chmod 0000', level: 'S', reason: 'Permission removal' },
    { pattern: '> /dev/', level: 'S', reason: 'Direct device write' },
    { pattern: '> /etc/', level: 'S', reason: 'System configuration overwrite' },
    { pattern: '> /boot/', level: 'S', reason: 'Boot partition modification' },
    { pattern: '> /sys/', level: 'S', reason: 'System filesystem modification' },
    { pattern: 'format', level: 'S', reason: 'Disk formatting' },
    { pattern: 'del /', level: 'S', reason: 'Windows path deletion' },
    { pattern: 'rmdir /', level: 'S', reason: 'Root directory removal' },
    { pattern: 'wipefs', level: 'S', reason: 'Filesystem signature wipe' },
    { pattern: 'shred', level: 'S', reason: 'Secure file deletion' },
    { pattern: '| sh', level: 'S', reason: 'Executing downloaded content' },
    { pattern: '| bash', level: 'S', reason: 'Executing downloaded content' },
    { pattern: '> /proc/', level: 'S', reason: 'Proc filesystem modification' },
  ];

  /** A-level (Advanced): System modifications */
  private static readonly A_LEVEL_PATTERNS: CommandPattern[] = [
    { pattern: 'apt install', level: 'A', reason: 'system modification: package installation' },
    { pattern: 'apt-get install', level: 'A', reason: 'system modification: package installation' },
    { pattern: 'apt remove', level: 'A', reason: 'Package removal' },
    { pattern: 'apt-get remove', level: 'A', reason: 'Package removal' },
    { pattern: 'apt purge', level: 'A', reason: 'Package removal' },
    { pattern: 'yum install', level: 'A', reason: 'Package installation' },
    { pattern: 'dnf install', level: 'A', reason: 'Package installation' },
    { pattern: 'pacman -S', level: 'A', reason: 'Package installation' },
    { pattern: 'pip install', level: 'A', reason: 'Python package installation' },
    { pattern: 'pip3 install', level: 'A', reason: 'Python package installation' },
    { pattern: 'npm install', level: 'A', reason: 'NPM package installation' },
    { pattern: 'npm i', level: 'A', reason: 'NPM package installation' },
    { pattern: 'yarn add', level: 'A', reason: 'Yarn package installation' },
    { pattern: 'cargo install', level: 'A', reason: 'Cargo package installation' },
    { pattern: 'go install', level: 'A', reason: 'Go package installation' },
    { pattern: 'gem install', level: 'A', reason: 'Gem package installation' },
    { pattern: 'systemctl', level: 'A', reason: 'Service control' },
    { pattern: 'service ', level: 'A', reason: 'Service control' },
    { pattern: 'modprobe', level: 'A', reason: 'Kernel module loading' },
    { pattern: 'insmod', level: 'A', reason: 'Kernel module loading' },
    { pattern: 'rmmod', level: 'A', reason: 'Kernel module removal' },
    { pattern: 'iptables', level: 'A', reason: 'Firewall modification' },
    { pattern: 'ufw ', level: 'A', reason: 'Firewall modification' },
    { pattern: 'firewall-cmd', level: 'A', reason: 'Firewall modification' },
    { pattern: 'useradd', level: 'A', reason: 'User management' },
    { pattern: 'userdel', level: 'A', reason: 'User management' },
    { pattern: 'usermod', level: 'A', reason: 'User management' },
    { pattern: 'crontab', level: 'A', reason: 'Cron modification' },
    { pattern: 'docker build', level: 'A', reason: 'Container build' },
    { pattern: 'docker run', level: 'A', reason: 'Container execution' },
    { pattern: 'podman build', level: 'A', reason: 'Container build' },
    { pattern: 'mount', level: 'A', reason: 'Filesystem mounting' },
    { pattern: 'umount', level: 'A', reason: 'Filesystem unmounting' },
    { pattern: 'fdisk', level: 'A', reason: 'Disk partitioning' },
    { pattern: 'parted', level: 'A', reason: 'Disk partitioning' },
    { pattern: 'lvcreate', level: 'A', reason: 'LVM modification' },
    { pattern: 'lvremove', level: 'A', reason: 'LVM modification' },
  ];

  /** B-level (Basic): Standard operations with impact */
  private static readonly B_LEVEL_PATTERNS: CommandPattern[] = [
    { pattern: 'touch ', level: 'B', reason: 'File creation' },
    { pattern: 'mkdir', level: 'B', reason: 'Directory creation' },
    { pattern: 'mv ', level: 'B', reason: 'File move/rename' },
    { pattern: 'cp ', level: 'B', reason: 'File copy' },
    { pattern: 'rm ', level: 'B', reason: 'File removal' },
    { pattern: 'ln ', level: 'B', reason: 'Link creation' },
    { pattern: 'symlink', level: 'B', reason: 'Link creation' },
    { pattern: 'chmod', level: 'B', reason: 'Permission change' },
    { pattern: 'chown', level: 'B', reason: 'Ownership change' },
    { pattern: 'chgrp', level: 'B', reason: 'Group ownership change' },
    { pattern: 'truncate', level: 'B', reason: 'File size modification' },
    { pattern: 'split', level: 'B', reason: 'File splitting' },
    { pattern: 'tee ', level: 'B', reason: 'File write' },
    { pattern: 'echo >', level: 'B', reason: 'File write' },
    { pattern: 'printf >', level: 'B', reason: 'File write' },
    { pattern: 'cat >', level: 'B', reason: 'File write' },
    { pattern: '>>', level: 'B', reason: 'File append' },
    { pattern: 'tar xf', level: 'B', reason: 'Archive extraction' },
    { pattern: 'tar -xf', level: 'B', reason: 'Archive extraction' },
    { pattern: 'unzip', level: 'B', reason: 'Archive extraction' },
    { pattern: 'git clone', level: 'B', reason: 'Repository clone' },
    { pattern: 'git pull', level: 'B', reason: 'Repository update' },
    { pattern: 'git push', level: 'B', reason: 'Repository push' },
  ];

  /** C-level (Common): Read-only operations */
  private static readonly C_LEVEL_PATTERNS: CommandPattern[] = [
    { pattern: 'cat ', level: 'C', reason: 'File read' },
    { pattern: 'less', level: 'C', reason: 'File read' },
    { pattern: 'more', level: 'C', reason: 'File read' },
    { pattern: 'head', level: 'C', reason: 'File read' },
    { pattern: 'tail', level: 'C', reason: 'File read' },
    { pattern: 'ls ', level: 'C', reason: 'Directory listing' },
    { pattern: 'll ', level: 'C', reason: 'Directory listing' },
    { pattern: 'dir', level: 'C', reason: 'Directory listing' },
    { pattern: 'find ', level: 'C', reason: 'File search' },
    { pattern: 'grep ', level: 'C', reason: 'Content search' },
    { pattern: 'egrep', level: 'C', reason: 'Content search' },
    { pattern: 'fgrep', level: 'C', reason: 'Content search' },
    { pattern: 'awk ', level: 'C', reason: 'Text processing' },
    { pattern: 'sed ', level: 'C', reason: 'Text processing' },
    { pattern: 'sort', level: 'C', reason: 'Text processing' },
    { pattern: 'uniq', level: 'C', reason: 'Text processing' },
    { pattern: 'wc', level: 'C', reason: 'Text count' },
    { pattern: 'diff', level: 'C', reason: 'File comparison' },
    { pattern: 'file ', level: 'C', reason: 'File type detection' },
    { pattern: 'stat', level: 'C', reason: 'File status' },
    { pattern: 'readlink', level: 'C', reason: 'Link read' },
    { pattern: 'pwd', level: 'C', reason: 'Print working directory' },
    { pattern: 'id', level: 'C', reason: 'User identity' },
    { pattern: 'whoami', level: 'C', reason: 'User identity' },
    { pattern: 'env', level: 'C', reason: 'Environment display' },
    { pattern: 'printenv', level: 'C', reason: 'Environment display' },
    { pattern: 'echo ', level: 'C', reason: 'Text output' },
    { pattern: 'printf', level: 'C', reason: 'Text output' },
    { pattern: 'date', level: 'C', reason: 'Date display' },
    { pattern: 'uname', level: 'C', reason: 'System information' },
    { pattern: 'df', level: 'C', reason: 'Disk usage' },
    { pattern: 'du', level: 'C', reason: 'Disk usage' },
    { pattern: 'ps ', level: 'C', reason: 'Process list' },
    { pattern: 'top', level: 'C', reason: 'Process monitor' },
    { pattern: 'htop', level: 'C', reason: 'Process monitor' },
    { pattern: 'which', level: 'C', reason: 'Command location' },
    { pattern: 'whereis', level: 'C', reason: 'Command location' },
    { pattern: 'type', level: 'C', reason: 'Command type' },
    { pattern: 'basename', level: 'C', reason: 'Path basename' },
    { pattern: 'dirname', level: 'C', reason: 'Path dirname' },
    { pattern: 'realpath', level: 'C', reason: 'Path resolution' },
    { pattern: 'git status', level: 'C', reason: 'Repository status' },
    { pattern: 'git log', level: 'C', reason: 'Repository log' },
    { pattern: 'git show', level: 'C', reason: 'Repository show' },
    { pattern: 'git diff', level: 'C', reason: 'Repository diff' },
  ];

  /**
   * Classify a command by harm level
   *
   * @param command - Shell command to classify
   * @returns Classification result with level, reason, and whitelist status
   */
  classifyCommand(command: string): CommandClassification {
    // Trim whitespace
    const normalized = command.trim();

    // Handle empty command
    if (!normalized) {
      return {
        level: 'C',
        reason: 'empty or invalid command',
        whitelisted: false,
      };
    }

    // Check whitelist first
    const whitelisted = this.checkWhitelist(normalized);
    if (whitelisted.matched) {
      return {
        level: 'C', // Whitelisted commands are downgraded to C
        reason: `Whitelisted: ${whitelisted.reason}`,
        whitelisted: true,
        whitelistReason: whitelisted.reason,
      };
    }

    // Check for command chains (&&, ||, ;, |)
    const chainResult = this.checkCommandChain(normalized);
    if (chainResult) {
      return chainResult;
    }

    // Check S-level patterns (most severe)
    const sResult = this.checkPatterns(normalized, HarmClassifier.S_LEVEL_PATTERNS);
    if (sResult) return sResult;

    // Check A-level patterns
    const aResult = this.checkPatterns(normalized, HarmClassifier.A_LEVEL_PATTERNS);
    if (aResult) return aResult;

    // Check B-level patterns
    const bResult = this.checkPatterns(normalized, HarmClassifier.B_LEVEL_PATTERNS);
    if (bResult) return bResult;

    // Check C-level patterns
    const cResult = this.checkPatterns(normalized, HarmClassifier.C_LEVEL_PATTERNS);
    if (cResult) return cResult;

    // Default to S for unknown commands (deny by default / fail closed)
    return {
      level: 'S',
      reason: 'Unknown command - blocked by default (deny by default policy)',
      whitelisted: false,
    };
  }

  /**
   * Check if command matches any pattern in a list
   */
  private checkPatterns(command: string, patterns: CommandPattern[]): CommandClassification | null {
    const normalized = command.toLowerCase();

    for (const pattern of patterns) {
      if (this.patternMatches(normalized, pattern.pattern.toLowerCase())) {
        return {
          level: pattern.level,
          reason: pattern.reason,
          whitelisted: false,
        };
      }
    }

    return null;
  }

  /**
   * Check if a pattern matches a command
   * Supports simple wildcard matching (*) and contains matching
   */
  private patternMatches(command: string, pattern: string): boolean {
    // Exact match
    if (command === pattern) {
      return true;
    }

    // Handle wildcard patterns (git *, npm *, etc.)
    if (pattern.endsWith(' *')) {
      const prefix = pattern.slice(0, -2).trim();
      if (command.startsWith(prefix + ' ')) {
        return true;
      }
    }

    // Handle trailing space patterns (command with arguments)
    if (pattern.endsWith(' ')) {
      const prefix = pattern.slice(0, -1);
      if (command.startsWith(prefix + ' ')) {
        return true;
      }
    }

    // Contains pattern (for in-string matches like | sh)
    if (command.includes(pattern)) {
      return true;
    }

    return false;
  }

  /**
   * Check command chain for highest harm level
   */
  private checkCommandChain(command: string): CommandClassification | null {
    // Split by command separators
    const separators = ['&&', '||', ';', '|'];
    let highestLevel: HarmLevel = 'C';
    let reasons: string[] = [];

    for (const sep of separators) {
      if (command.includes(sep)) {
        const parts = command.split(sep);
        for (const part of parts) {
          const trimmedPart = part.trim();

          // Check S-level patterns first (highest priority)
          const sResult = this.checkPatterns(trimmedPart, HarmClassifier.S_LEVEL_PATTERNS);
          if (sResult) {
            return {
              level: 'S',
              reason: `command chain contains S-level operation: ${sResult.reason}`,
              whitelisted: false,
            };
          }

          // Check A-level patterns
          const aResult = this.checkPatterns(trimmedPart, HarmClassifier.A_LEVEL_PATTERNS);
          if (aResult) {
            highestLevel = 'A';
            reasons.push(aResult.reason);
            continue;
          }

          // Check B-level patterns
          const bResult = this.checkPatterns(trimmedPart, HarmClassifier.B_LEVEL_PATTERNS);
          if (bResult && highestLevel === 'C') {
            highestLevel = 'B';
            reasons.push(bResult.reason);
          }
        }

        // If we found any high-level operations, return the classification
        if (highestLevel !== 'C') {
          return {
            level: highestLevel,
            reason: `command chain: ${reasons.join('; ')}`,
            whitelisted: false,
          };
        }
      }
    }

    return null;
  }

  /**
   * Check if command is whitelisted
   */
  private checkWhitelist(command: string): { matched: boolean; reason?: string } {
    const normalized = command.toLowerCase();

    for (const [pattern, reason] of this.whitelist.entries()) {
      const patternLower = pattern.toLowerCase();
      if (this.patternMatches(normalized, patternLower)) {
        return { matched: true, reason };
      }
    }

    return { matched: false };
  }

  /**
   * Add a command pattern to the whitelist
   *
   * @param pattern - Command pattern to whitelist (supports wildcards)
   * @param reason - Reason for whitelisting
   */
  addToWhitelist(pattern: string, reason: string): void {
    this.whitelist.set(pattern, reason);
  }

  /**
   * Remove a command pattern from the whitelist
   *
   * @param pattern - Pattern to remove
   */
  removeFromWhitelist(pattern: string): void {
    this.whitelist.delete(pattern);
  }

  /**
   * Get all whitelisted patterns
   *
   * @returns Array of [pattern, reason] tuples
   */
  getWhitelist(): Array<[string, string]> {
    return Array.from(this.whitelist.entries());
  }

  /**
   * Clear all whitelist entries
   */
  clearWhitelist(): void {
    this.whitelist.clear();
  }
}
