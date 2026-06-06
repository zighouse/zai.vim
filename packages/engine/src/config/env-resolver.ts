// @zaivim/engine — Environment variable resolver
// Replaces $VAR_NAME patterns in config values with process.env.VAR_NAME
// Marks providers as unavailable when referenced env vars are not set

const ENV_PATTERN = /^\$([A-Z_][A-Z0-9_]*)$/;

/**
 * Resolve environment variable references in config values.
 * Recursively walks config object, replacing `$VAR_NAME` strings with their env values.
 * When a provider's apiKey references an unset env var, marks it as `unavailable`.
 * Modifies the config object in place (called before deepFreeze).
 */
export function resolveEnvVars(obj: Record<string, unknown>): void {
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (typeof value === 'string') {
      const match = ENV_PATTERN.exec(value);
      if (match?.[1]) {
        const envValue = process.env[match[1]];
        if (envValue !== undefined) {
          obj[key] = envValue;
        }
        // If env var not set, leave the $VAR_NAME string as-is
        // Provider-level status marking handled below
      }
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      resolveEnvVars(value as Record<string, unknown>);
    } else if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        if (typeof value[i] === 'string') {
          const match = ENV_PATTERN.exec(value[i] as string);
          if (match?.[1]) {
            const envValue = process.env[match[1]];
            if (envValue !== undefined) {
              value[i] = envValue;
            }
          }
        }
      }
    }
  }
}

/**
 * Mark providers as unavailable when their apiKey references an unset env var.
 * Must be called after resolveEnvVars() — checks if apiKey still starts with '$'.
 */
export function markUnavailableProviders(providers: Record<string, Record<string, unknown>>): void {
  for (const [, cfg] of Object.entries(providers)) {
    if (typeof cfg.apiKey === 'string' && ENV_PATTERN.test(cfg.apiKey)) {
      (cfg as Record<string, unknown>).status = 'unavailable';
    }
  }
}
