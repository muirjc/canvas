import { defineConfig } from '@playwright/test';

/**
 * Screenshots for docs/user-guide and docs/admin-guide (written to the repo's docs/images/).
 * Not part of the e2e suite: playwright.config.ts's testDir is ./tests/e2e, so it never sees this.
 * Needs the API (:3000, AI_PROVIDER=mock) and web (:5173) dev servers running, and the seeded
 * demo accounts. Run: npm run docs:screenshots --workspace=@canvas/web
 */
export default defineConfig({
  testDir: './docs-screenshots',
  workers: 1,
  retries: 0,
  reporter: 'list',
  timeout: 180_000,
  use: {
    baseURL: 'http://localhost:5173',
    viewport: { width: 1280, height: 800 },
    browserName: 'chromium',
    screenshot: 'off',
    trace: 'off',
  },
});
