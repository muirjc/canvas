import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15000,
    // Contract tests share one real Postgres database and each resets it in beforeEach; running
    // test files in parallel races those resets against each other. Sequential is correct here,
    // not a performance workaround.
    fileParallelism: false,
  },
});
