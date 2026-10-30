import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { showShareButton } from './app-settings-helpers';
import { expectSignedIn } from './auth-helpers';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const API_BASE_URL = process.env.VITE_API_BASE_URL ?? 'http://localhost:3000';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/** canvas-cyt: the Share dialog's people picker (combobox) over GET /users/search. Shares only with
 *  throwaway users it creates -- the seeded Guest/Architect accounts are other specs' fixtures
 *  (e.g. shared-diagrams.spec.ts expects Guest to have nothing shared). */
async function throwawayUser(page: Page, suffix: string) {
  const stamp = Date.now();
  const email = `e2e-user-${stamp}-picker-${suffix}@example.com`;
  const name = `Picker ${suffix} ${stamp}`;
  const res = await page.request.post(`${API_BASE_URL}/admin/users`, { data: { email, name, role: 'viewer' } });
  expect(res.status(), await res.text()).toBe(201);
  return { email, name, id: (await res.json()).user.id as string };
}

async function openShareDialog(page: Page) {
  await showShareButton(page);
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('login-email').fill('admin@example.com');
  await page.getByTestId('login-password').fill('admin-dev-password');
  await page.getByTestId('login-submit').click();
  await expectSignedIn(page);

  const created = await page.request.post(`${API_BASE_URL}/projects/${PROJECT_ID}/diagrams`, {
    data: { name: `Share picker ${Date.now()}`, diagramTypeId: 'flowchart' },
  });
  expect(created.status()).toBe(201);
  const diagramId = (await created.json()).diagram.id as string;
  await page.goto(`/?diagramId=${diagramId}`);
  await page.getByTestId('open-share-dialog').click();
  await expect(page.getByTestId('share-email')).toBeVisible();
}

test('picks a user by name with the keyboard, shares, and the grant shows name and email', async ({ page }) => {
  await openShareDialog(page);
  const person = await throwawayUser(page, 'keyboard');
  const input = page.getByTestId('share-email');
  await input.fill(person.name);
  await expect(input).toHaveAttribute('aria-expanded', 'true');
  const option = page.getByRole('option', { name: new RegExp(`${person.name} — ${person.email.replace(/\./g, '\\.')}`) });
  await expect(option).toBeVisible();

  await input.press('ArrowDown');
  await expect(input).toHaveAttribute('aria-activedescendant', /.+/);
  await input.press('Enter');
  await expect(page.getByTestId('share-user-selected')).toContainText(person.email);

  await page.getByTestId('confirm-share').click();
  const grants = page.getByTestId('share-grants');
  await expect(grants).toContainText(person.name);
  await expect(grants).toContainText(person.email);
  await expect(page.getByTestId('share-error')).toHaveCount(0);

  // Now that they have access, they are listed as such and cannot be picked again.
  await input.fill(person.name);
  const again = page.getByRole('option', { name: new RegExp(person.name) });
  await expect(again).toContainText('has view access');
  await expect(again).toHaveAttribute('aria-disabled', 'true');
});

test('the signed-in user is shown as (you) and cannot be picked; Escape closes only the list', async ({ page }) => {
  await openShareDialog(page);
  const input = page.getByTestId('share-email');
  await input.fill('Admin');
  const option = page.getByRole('option', { name: /admin@example\.com/ });
  await expect(option).toContainText('(you)');
  await expect(option).toHaveAttribute('aria-disabled', 'true');
  await option.click({ force: true });
  await expect(page.getByTestId('share-user-selected')).toHaveCount(0);

  await input.press('Escape');
  await expect(input).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('dialog', { name: 'Share diagram' })).toBeVisible();
});

test('shows an empty state, and a full email without picking still shares via exact lookup', async ({ page }) => {
  await openShareDialog(page);
  const input = page.getByTestId('share-email');
  await input.fill('zzz-nobody');
  await expect(page.getByTestId('share-user-list')).toContainText('No matching active users');

  await input.fill('nobody@example.com');
  await page.getByTestId('confirm-share').click();
  await expect(page.getByTestId('share-error')).toContainText('No active user found');

  const person = await throwawayUser(page, 'exact');
  await input.fill(person.email);
  await page.getByTestId('confirm-share').click();
  await expect(page.getByTestId('share-grants')).toContainText(person.email);
});

test('dialog with the expanded list has no axe violations', async ({ page }) => {
  await openShareDialog(page);
  await page.getByTestId('share-email').fill('a');
  await expect(page.getByTestId('share-user-list').getByRole('option').first()).toBeVisible();
  const results = await new AxeBuilder({ page })
    .include('dialog')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
});
