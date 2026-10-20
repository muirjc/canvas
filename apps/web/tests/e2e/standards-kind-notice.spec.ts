import { expect, test } from '@playwright/test';
import { deleteCustomDiagramType, ensureCustomDiagramType } from './diagram-type-helpers';
import { openStandardsAdmin } from './standards-admin-helpers';

const PROJECT_ID = process.env.E2E_PROJECT_ID;

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

let typeId = '';

test.afterAll(async ({ browser }) => {
  // canvas-lj9: nothing is saved against the type, so delete it rather than leave junk behind.
  const page = await browser.newPage();
  await openStandardsAdmin(page);
  await deleteCustomDiagramType(page.request, typeId);
  await page.close();
});

/**
 * canvas-e05: two C4 kinds with the same role used to be accepted silently. It's legitimate since
 * canvas-7hp ($tags tell them apart), so the editor shows a note on the later kind naming the
 * earlier one -- and saving stays allowed.
 */
test('a C4 kind sharing its role with an earlier kind gets a note, and saving is still allowed', async ({ page }) => {
  await openStandardsAdmin(page);
  typeId = await ensureCustomDiagramType(page.request, { name: 'E2E C4 Kind Notice', dslFamily: 'c4' });
  await page.reload();
  await page.getByTestId(`standards-type-${typeId}`).click();

  await page.getByTestId('standard-new').click();
  await page.getByTestId('standard-name-input').fill('Kind notice');
  await page.getByTestId('kind-add').click();
  await page.getByTestId('kind-label-0').fill('Platform');
  await page.getByTestId('kind-add').click();
  await page.getByTestId('kind-label-1').fill('Product');
  // New C4 kinds default to the System role, so the two now overlap.
  await expect(page.getByTestId('kind-role-1')).toHaveValue('system');

  await expect(page.getByTestId('kind-notice-1')).toContainText('"Platform"');
  await expect(page.getByTestId('kind-notice-0')).toHaveCount(0);
  await expect(page.getByTestId('standard-issues')).toHaveCount(0);
  await expect(page.getByTestId('standard-save')).toBeEnabled();

  // Giving the second kind a different role clears the note.
  await page.getByTestId('kind-role-1').selectOption('person');
  await expect(page.getByTestId('kind-notice-1')).toHaveCount(0);

  await page.getByTestId('standard-cancel').click();
});
