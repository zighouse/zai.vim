import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      thresholds: { statements: 70, branches: 70, functions: 70, lines: 70 },
      exclude: ['src/test-utils/**'],
    },
  },
});
