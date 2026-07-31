import { expect, test, type Page } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

async function signIn(page: Page) {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('sign-out')).toBeVisible();
}

async function openNewDiagram(page: Page) {
  await page.getByTestId('new-diagram').click();
  await page.getByTestId('diagram-type-flowchart').check();
  await page.getByTestId('confirm-new-diagram').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
}

/**
 * Regression: once a diagram was open, there was no way back to the project browser short of
 * switching to a different project (a no-op if you picked the current one) or signing out —
 * "Diagrams" in the editor's doc-bar is the fix. Mirrors the project-switch unsaved-changes guard
 * exactly (App.tsx's requestGoHome/requestProjectChange) rather than a separate, weaker check.
 */
test('returns to the project browser immediately when there are no unsaved changes', async ({ page }) => {
  await signIn(page);
  await openNewDiagram(page);

  await page.getByTestId('back-to-diagrams').click();
  await expect(page.getByTestId('home-nav-confirm')).toHaveCount(0);
  await expect(page.getByTestId('new-diagram')).toBeVisible();
});

test('warns before discarding unsaved changes, and cancelling keeps the work', async ({ page }) => {
  await signIn(page);
  await openNewDiagram(page);

  await page.getByTestId('add-shape-rectangle').click();
  await expect(page.locator('[data-testid^="node-"]')).toHaveCount(1);

  await page.getByTestId('back-to-diagrams').click();
  await expect(page.getByTestId('home-nav-confirm')).toBeVisible();

  await page.getByTestId('cancel-home-nav').click();
  await expect(page.getByTestId('home-nav-confirm')).toHaveCount(0);
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
  await expect(page.locator('[data-testid^="node-"]')).toHaveCount(1);
});

test('confirming discard returns to the project browser', async ({ page }) => {
  await signIn(page);
  await openNewDiagram(page);

  await page.getByTestId('add-shape-rectangle').click();
  await expect(page.locator('[data-testid^="node-"]')).toHaveCount(1);

  await page.getByTestId('back-to-diagrams').click();
  await expect(page.getByTestId('home-nav-confirm')).toBeVisible();
  await page.getByTestId('confirm-home-nav').click();

  await expect(page.getByTestId('home-nav-confirm')).toHaveCount(0);
  await expect(page.getByTestId('new-diagram')).toBeVisible();
});
