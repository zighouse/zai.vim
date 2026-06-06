// @zaivim/gateway — Method-level ACL registry + auth middleware
// Three access levels: public, session-scoped, admin

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { generateAdminToken, ADMIN_TOKEN_PATH, ADMIN_TOKEN_LENGTH } from './admin-token.js';

export type MethodAccess = 'public' | 'session-scoped' | 'admin';

export interface MethodACLEntry {
  access: MethodAccess;
  description: string;
}

/**
 * ACL registry mapping method names to their access levels.
 */
export class MethodACL {
  readonly #entries = new Map<string, MethodACLEntry>();

  register(method: string, entry: MethodACLEntry): void {
    this.#entries.set(method, entry);
  }

  getAccess(method: string): MethodAccess | undefined {
    return this.#entries.get(method)?.access;
  }

  has(method: string): boolean {
    return this.#entries.has(method);
  }

  listMethods(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [method, entry] of this.#entries) {
      result[method] = entry.access;
    }
    return result;
  }

  /**
   * Create default ACL with all standard methods.
   */
  static createDefault(): MethodACL {
    const acl = new MethodACL();
    acl.register('health', { access: 'public', description: 'Engine health check' });
    acl.register('ping', { access: 'public', description: 'Engine ping' });
    acl.register('metrics', { access: 'public', description: 'Engine metrics' });
    acl.register('session.create', { access: 'session-scoped', description: 'Create a new chat session' });
    acl.register('session.close', { access: 'session-scoped', description: 'Close a chat session' });
    acl.register('session.send', { access: 'session-scoped', description: 'Send a message to a session' });
    acl.register('engine.stop', { access: 'admin', description: 'Stop the engine' });
    acl.register('audit.query', { access: 'admin', description: 'Query audit logs' });
    acl.register('config.set', { access: 'admin', description: 'Set configuration values' });
    return acl;
  }
}

// ---- Auth middleware --------------------------------------------------------

export interface AuthResult {
  allowed: boolean;
  code?: number;
  message?: string;
}

/**
 * Read the admin token from ~/.zaivim/.admin-token.
 * Returns undefined if file doesn't exist or can't be read.
 */
export function readAdminToken(): string | undefined {
  try {
    const tokenPath = ADMIN_TOKEN_PATH;
    if (!existsSync(tokenPath)) return undefined;
    return readFileSync(tokenPath, 'utf-8').trim();
  } catch {
    return undefined;
  }
}

/**
 * Express-style auth middleware for JSON-RPC methods.
 * Called before dispatching to method handler.
 */
export function requireAuth(
  method: string,
  params: unknown,
  acl: MethodACL,
): AuthResult {
  const access = acl.getAccess(method);

  // Unknown method — reject
  if (access === undefined) {
    return { allowed: false, code: -32601, message: `Method not found: ${method}` };
  }

  // Public — always allowed
  if (access === 'public') {
    return { allowed: true };
  }

  const p = params as Record<string, unknown> | undefined;
  const token = p?.token;

  // Session-scoped — require non-empty token string
  if (access === 'session-scoped') {
    if (!token || typeof token !== 'string') {
      return {
        allowed: false,
        code: -32001,
        message: `Unauthorized: method '${method}' requires authentication`,
      };
    }
    return { allowed: true };
  }

  // Admin — require token matching ~/.zaivim/.admin-token
  if (access === 'admin') {
    if (!token || typeof token !== 'string') {
      return {
        allowed: false,
        code: -32001,
        message: `Unauthorized: method '${method}' requires authentication`,
      };
    }
    const adminToken = readAdminToken();
    if (token !== adminToken) {
      return {
        allowed: false,
        code: -32001,
        message: `Unauthorized: method '${method}' requires authentication`,
      };
    }
    return { allowed: true };
  }

  return { allowed: false, code: -32603, message: 'Internal error: unknown access level' };
}

export { generateAdminToken, ADMIN_TOKEN_PATH, ADMIN_TOKEN_LENGTH };
