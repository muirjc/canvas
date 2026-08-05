import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  // canvas-i86: resolves E2E_PROJECT_ID automatically (idempotent seed lookup-or-create of a
  // project literally named "Smoke Test") if nothing has already set it — no more manually
  // exporting a value that inevitably goes stale once that project gets deleted by some other
  // test/script run. An explicit E2E_PROJECT_ID (e.g. CI's own workflow) always wins.
  globalSetup: './tests/e2e/global-setup.ts',
  // Every spec shares one seeded project (E2E_PROJECT_ID) and asserts on its diagram count —
  // running spec files in parallel workers races those counts against each other (e.g. one
  // worker's diagram creation lands between another worker's "before" and "after" count
  // assertions). Sequential is correct here, not a performance workaround, mirroring
  // apps/api/vitest.config.ts's fileParallelism: false for the same reason.
  workers: 1,
  // CI already has an "Upload Playwright report" step pointing at playwright-report/, but nothing
  // was producing that directory — the default reporter writes no HTML. With this, the artifact
  // that step uploads actually contains the failure screenshots and traces.
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
  },
  use: {
    baseURL: 'http://localhost:5173',
    // Kept on permanently, not just while chasing one bug: this suite is the only coverage
    // apps/web has, and a failure that reproduces in CI but not locally is otherwise undiagnosable
    // from the log alone — the log shows which locator timed out, never what the page contained.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
