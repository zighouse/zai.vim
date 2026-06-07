// @zaivim/engine — Configuration barrel export
export { loadConfig, DEFAULT_CONFIG } from './config-loader.js';
export { validateConfig } from './config-validator.js';
export { resolveEnvVars, markUnavailableProviders } from './env-resolver.js';
export { stripJsComments, normalizeModelField, normalizeConfigKeys } from './config-compat.js';
export type { ModelConfig } from './config-compat.js';
export { createConfigBackup, restoreFromBackup, getDefaultConfig } from './config-backup.js';
export { detectLegacyFormat, generateDiffPreview, tryMigrate } from './config-migrator.js';
export type { MigrateOptions } from './config-migrator.js';
export { redactSensitiveInfo } from './redact.js';
