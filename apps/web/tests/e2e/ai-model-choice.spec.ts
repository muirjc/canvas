import { expect, test, type Page } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

async function signIn(page: Page, email: string, password: string, url: string) {
  await page.goto(url);
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(password);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('sign-out')).toBeVisible();
}

/** canvas-tj1: the Model field on the AI admin page. Runs against the mock provider (no choice). */
test('admin sees the model field disabled with the mock note', async ({ page }) => {
  await signIn(page, 'admin@example.com', 'admin-dev-password', `/?projectId=${PROJECT_ID}&admin=ai-personas`);
  await expect(page.getByTestId('ai-model-select')).toBeVisible();
  await expect(page.getByTestId('ai-model-select')).toBeDisabled();
  await expect(page.getByText('Mock provider — no model to choose')).toBeVisible();
  await expect(page.getByTestId('ai-model-effective')).toContainText('Chats use: mock');
});

test('a non-admin cannot reach the page', async ({ page }) => {
  await signIn(page, 'architect@example.com', 'architect-dev-password', `/?projectId=${PROJECT_ID}&admin=ai-personas`);
  await expect(page.getByTestId('admin-shell')).toHaveCount(0);
  await expect(page.getByTestId('ai-model-select')).toHaveCount(0);
});
