import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['shared/**/*.test.ts', 'server/**/*.test.ts', 'tools/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
  },
});
