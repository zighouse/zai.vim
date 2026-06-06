// @zaivim/engine — Config compatibility layer
// JS comment stripping, model field normalization, key normalization (- → _)

const STRING_RE = /"(?:[^"\\]|\\.)*"/g;
// URL pattern: matches scheme:// (e.g., https://, http://, ws://)
const URL_RE = /[a-zA-Z][a-zA-Z0-9+.-]*:\/\//g;
const COMMENT_RE = /\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
const PLACEHOLDER_PREFIX = '\x00__STR_';
const URL_PLACEHOLDER_PREFIX = '\x00__URL_';

/**
 * Strip JS-style comments (// and /* *​/) from text,
 * preserving // inside string literals and URLs (scheme://).
 * Uses the same placeholder technique as Python _strip_comments().
 */
export function stripJsComments(text: string): string {
  const protectedValues: string[] = [];

  // Step 1: Protect double-quoted string literals
  let masked = text.replace(STRING_RE, (m) => {
    protectedValues.push(m);
    return `${PLACEHOLDER_PREFIX}${protectedValues.length - 1}__\x00`;
  });

  // Step 2: Protect URL schemes (https://, http://, etc.)
  masked = masked.replace(URL_RE, (m) => {
    protectedValues.push(m);
    return `${URL_PLACEHOLDER_PREFIX}${protectedValues.length - 1}__\x00`;
  });

  // Step 3: Remove comments
  const cleaned = masked.replace(COMMENT_RE, '');

  // Step 4: Restore all protected values
  return protectedValues.reduce(
    (acc, s, i) => {
      const placeholder = i < protectedValues.length
        ? (acc.includes(`${PLACEHOLDER_PREFIX}${i}__\x00`)
          ? `${PLACEHOLDER_PREFIX}${i}__\x00`
          : `${URL_PLACEHOLDER_PREFIX}${i}__\x00`)
        : '';
      return placeholder ? acc.replace(placeholder, s) : acc;
    },
    cleaned,
  );
}

export interface ModelConfig {
  name: string;
  [key: string]: unknown;
}

/**
 * Normalize model field to uniform ModelConfig[] format.
 * - String "deepseek-v3" → [{name: "deepseek-v3"}]
 * - Array of strings ["a", "b"] → [{name: "a"}, {name: "b"}]
 * - Array of objects [{name: "a", maxTokens: 8192}] → unchanged
 */
export function normalizeModelField(value: unknown): ModelConfig[] {
  if (typeof value === 'string') return [{ name: value }];
  if (Array.isArray(value)) {
    return value.map((item) =>
      typeof item === 'string' ? { name: item } : (item as ModelConfig),
    );
  }
  return [];
}

/**
 * Recursively normalize config keys: replace `-` with `_`.
 * e.g., api-key → api_key, base-url → base_url
 */
export function normalizeConfigKeys(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(normalizeConfigKeys);
  if (obj && typeof obj === 'object') {
    const normalized: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      normalized[k.replace(/-/g, '_')] = normalizeConfigKeys(v);
    }
    return normalized;
  }
  return obj;
}
