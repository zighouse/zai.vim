import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    testTimeout: 15000,
    hookTimeout: 10000,
    env: {
      E2E_EPIC: process.env.E2E_EPIC ?? process.argv.find(a => a.startsWith('--epic='))?.split('=')[1] ?? '',
    },
  },
});
