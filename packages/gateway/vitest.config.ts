import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      thresholds: { statements: 65, branches: 65, functions: 65, lines: 65 },
      exclude: ['src/test-utils/**'],
    },
  },
});
