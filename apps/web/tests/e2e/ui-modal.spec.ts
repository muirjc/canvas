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

/**
 * User Story 3 (feature 005): dialogs overlay rather than replace, with correct focus
 * management — contracts/ui-contract.md §4 items 6–10.
 *
 * Focus behaviour comes from the native <dialog> element's showModal(), so these tests are really
 * checking that it is wired up correctly (opened via showModal, cancel event synced back to
 * React state) rather than that hand-written trapping logic is correct.
 */
test('a dialog overlays the screen with prior context still visible behind it', async ({ page }) => {
  await signIn(page);

  await page.getByTestId('new-diagram').click();
  await expect(page.getByRole('dialog', { name: 'New diagram' })).toBeVisible();

  // Contract item 6: the home screen is still there behind the dialog, not replaced.
  await expect(page.getByTestId('new-diagram')).toBeVisible();
  await expect(page.getByTestId('project-browser')).toBeVisible();
});

test('focus moves into the dialog and cannot Tab out of it', async ({ page }) => {
  await signIn(page);
  await page.getByTestId('new-diagram').click();
  const dialog = page.getByRole('dialog', { name: 'New diagram' });
  await expect(dialog).toBeVisible();

  // Contract item 7: focus starts inside.
  expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);

  // Tab well past the number of controls in the dialog. Focus must never reach an interactive
  // control on the page BEHIND the dialog — that is what "trapped" actually means. Chromium's
  // wrap-around cycle passes transiently through <body> and the <dialog> element itself before
  // re-entering, which is normal and not an escape.
  for (let i = 0; i < 20; i += 1) {
    await page.keyboard.press('Tab');
    const escapedTo = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body || el.tagName === 'DIALOG') return null;
      if (el.closest('dialog')) return null;
      return el.getAttribute('data-testid') ?? el.tagName;
    });
    expect(escapedTo, `focus reached "${escapedTo}" behind the dialog after ${i + 1} Tabs`).toBeNull();
  }
});

test('Escape closes the dialog, applies nothing, and restores focus to the opener', async ({ page }) => {
  await signIn(page);

  // Wait for the project list to finish loading before sampling, otherwise the "before" count is
  // taken mid-fetch and the comparison is meaningless.
  await expect(page.getByTestId('project-browser')).toBeVisible();
  const before = await page.locator('[data-testid^="open-diagram-"]').count();
  expect(before).toBeGreaterThan(0);

  await page.getByTestId('new-diagram').click();
  await expect(page.getByRole('dialog', { name: 'New diagram' })).toBeVisible();
  await page.keyboard.press('Escape');

  // Contract item 8: closed, and no diagram was created.
  await expect(page.getByRole('dialog', { name: 'New diagram' })).toHaveCount(0);
  expect(await page.locator('[data-testid^="open-diagram-"]').count()).toBe(before);

  // Contract item 9: focus returned to the control that opened it.
  const focusedTestId = await page.evaluate(() =>
    (document.activeElement as HTMLElement | null)?.getAttribute('data-testid'),
  );
  expect(focusedTestId).toBe('new-diagram');

  // Contract item 10: React state stayed in sync — the dialog reopens rather than being stuck
  // "already open" after the browser closed it natively.
  await page.getByTestId('new-diagram').click();
  await expect(page.getByRole('dialog', { name: 'New diagram' })).toBeVisible();
});

test('the delete confirmation is a modal alertdialog naming what it will delete', async ({ page }) => {
  await signIn(page);

  await page.getByTestId('new-diagram').click();
  await page.getByTestId('diagram-type-flowchart').check();
  await page.getByTestId('confirm-new-diagram').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();

  await page.getByTestId('add-shape-rectangle').click();
  await page.locator('[data-testid^="node-"]').first().click();
  await page.getByTestId('delete-selected').click();

  // contracts/ui-contract.md §2: ConfirmDialog must keep role="alertdialog", which the native
  // <dialog> element would otherwise silently downgrade to "dialog".
  const confirm = page.getByTestId('confirm-dialog');
  await expect(confirm).toBeVisible();
  await expect(confirm).toHaveAttribute('role', 'alertdialog');

  // FR-018: the destructive action is visually distinguished from a routine confirmation.
  const confirmBtnBg = await page
    .getByTestId('confirm-dialog-confirm')
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  const cancelBtnBg = await page
    .getByTestId('confirm-dialog-cancel')
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(confirmBtnBg).toBe('rgb(200, 30, 30)');
  expect(confirmBtnBg).not.toBe(cancelBtnBg);

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
  // Escape cancelled — the shape is still there.
  await expect(page.locator('[data-testid^="node-"]')).toHaveCount(1);
});
