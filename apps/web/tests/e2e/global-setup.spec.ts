import { expect, test } from '@playwright/test';

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * canvas-i86 regression: `global-setup.ts` runs once per `npx playwright test` invocation, before
 * any spec, and resolves `process.env.E2E_PROJECT_ID` automatically (via an idempotent
 * `npm run seed`) whenever nothing has already set it — so it self-heals if the seeded "Smoke
 * Test" project is ever deleted again, instead of every other spec's `test.skip(!PROJECT_ID, ...)`
 * silently skipping forever on a stale, manually-copied id.
 *
 * Deliberately has NO `test.skip(!PROJECT_ID, ...)` guard, unlike every other spec in this
 * directory: this spec's entire point is to prove the env var becomes set even when nothing
 * external (a developer's shell, CI's workflow) provided it. Adding that guard would make the
 * test vacuously pass by skipping itself exactly in the scenario it exists to cover.
 */
test('E2E_PROJECT_ID is resolved by global setup even when nothing set it beforehand', () => {
  expect(process.env.E2E_PROJECT_ID).toBeTruthy();
  expect(process.env.E2E_PROJECT_ID).toMatch(UUID_RE);
});

/**
 * Stronger than a string-shape check: confirms the resolved id isn't just UUID-shaped but
 * actually names a project the running app can serve, following the same sign-in/navigate
 * pattern every other spec in this directory uses (see style-affordance.spec.ts,
 * editor-back-navigation.spec.ts).
 */
test('the resolved E2E_PROJECT_ID corresponds to a project the app can actually open', async ({ page }) => {
  const projectId = process.env.E2E_PROJECT_ID;

  await page.goto(`/?projectId=${projectId}`);
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('sign-out')).toBeVisible();

  await expect(page.getByTestId('project-browser')).toBeVisible();
});
