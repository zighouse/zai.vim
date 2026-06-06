// @zaivim/gateway — Admin token generation for JSON-RPC ACL
// Token is a 64-char hex string (crypto.randomBytes(32).toString('hex'))

import { randomBytes } from 'node:crypto';
import { writeFileSync, unlinkSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

export const ADMIN_TOKEN_DIR = join(homedir(), '.zaivim');
export const ADMIN_TOKEN_PATH = join(ADMIN_TOKEN_DIR, '.admin-token');
export const ADMIN_TOKEN_LENGTH = 64; // 32 bytes → 64 hex chars

/**
 * Generate a cryptographically random admin token and write it to ~/.zaivim/.admin-token
 * with 0600 permissions.
 */
export function generateAdminToken(): string {
  const token = randomBytes(32).toString('hex');
  const dir = dirname(ADMIN_TOKEN_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(ADMIN_TOKEN_PATH, token + '\n', { mode: 0o600 });
  chmodSync(ADMIN_TOKEN_PATH, 0o600);
  return token;
}

/**
 * Remove the admin token file.
 */
export function removeAdminToken(): void {
  try {
    if (existsSync(ADMIN_TOKEN_PATH)) {
      unlinkSync(ADMIN_TOKEN_PATH);
    }
  } catch {
    // Best-effort cleanup
  }
}
