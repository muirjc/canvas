import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  // Every spec shares one seeded project (E2E_PROJECT_ID) and asserts on its diagram count —
  // running spec files in parallel workers races those counts against each other (e.g. one
  // worker's diagram creation lands between another worker's "before" and "after" count
  // assertions). Sequential is correct here, not a performance workaround, mirroring
  // apps/api/vitest.config.ts's fileParallelism: false for the same reason.
  workers: 1,
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
  },
  use: {
    baseURL: 'http://localhost:5173',
  },
});
