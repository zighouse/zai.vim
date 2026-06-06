// @zaivim/gateway — multi-transport gateway
export * from './stdio/index.js';
export { MethodACL, requireAuth } from './method-acl.js';
export { generateAdminToken, removeAdminToken, readAdminToken, ADMIN_TOKEN_PATH } from './admin-token.js';
export type { MethodAccess, MethodACLEntry, AuthResult } from './method-acl.js';
