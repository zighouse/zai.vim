// @zaivim/engine — Log redaction for sensitive information
// Matches API key, token, and password patterns and replaces values with ***REDACTED***

const REDACT_PATTERNS: Array<{ re: RegExp; replacement: string }> = [
  { re: /(api[_-]?\s*key)([=:\s]+)\s*\S+/gi, replacement: '$1$2***REDACTED***' },
  { re: /(token)([=:\s]+)\s*\S+/gi, replacement: '$1$2***REDACTED***' },
  { re: /(password)([=:\s]+)\s*\S+/gi, replacement: '$1$2***REDACTED***' },
];

/**
 * Redact sensitive information from log output.
 * Replaces API key, token, and password values with ***REDACTED***.
 * Preserves the label and separator (e.g., "api_key=***REDACTED***").
 */
export function redactSensitiveInfo(text: string): string {
  let result = text;
  for (const { re, replacement } of REDACT_PATTERNS) {
    result = result.replace(re, replacement);
  }
  return result;
}
