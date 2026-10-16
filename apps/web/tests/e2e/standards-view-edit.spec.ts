import { expect, test, type Page } from '@playwright/test';
import { openStandardsAdmin } from './standards-admin-helpers';
import { PROJECT_ID, addKind, newDiagram } from './standards-v2-helpers';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/** canvas-chq: every built-in type has a published starter standard that can be viewed and revised. */

/** Index of the element-kind row whose id input holds `kindId`. */
async function kindIndex(page: Page, kindId: string): Promise<number> {
  const values = await page
    .locator('[data-testid^="kind-id-"]')
    .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
  const idx = values.indexOf(kindId);
  expect(idx, `kind ${kindId} among ${values.join(',')}`).toBeGreaterThanOrEqual(0);
  return idx;
}

test('c4 context: view the active standard, revise it into a new published version, and draw with the new swatch', async ({ page }) => {
  // A fresh, unique color per run so repeated runs against the same DB never collide.
  const hex = `#${(0x100000 + (Date.now() % 0xeffff0)).toString(16).padStart(6, '0')}`;

  await openStandardsAdmin(page);
  await page.getByTestId('standards-type-c4-context').click();
  await expect(page.getByTestId('standards-selected-type')).toContainText('C4');

  const activeRow = page.locator('[data-testid^="standard-row-"]').filter({ has: page.locator('[data-testid^="standard-status-"]', { hasText: 'Published' }) });
  await expect(activeRow).toHaveCount(1);
  const oldId = (await activeRow.getAttribute('data-testid'))!.replace('standard-row-', '');
  const versionsBefore = await page.locator('[data-testid^="standard-row-"]').count();

  // --- view mode ---------------------------------------------------------------------------
  await page.getByTestId('standard-view-active').click();
  await expect(page.getByTestId('standard-editor-title')).toContainText(/v\d+ \(published\)/);
  await expect(page.getByTestId('standard-form')).toHaveJSProperty('disabled', true);
  const idx = await kindIndex(page, 'external_system');
  await expect(page.getByTestId(`kind-row-${idx}`)).toBeVisible();
  await expect(page.getByTestId(`kind-id-${idx}`)).toBeDisabled();
  await expect(page.getByTestId('standard-name-input')).toBeDisabled();
  await expect(page.getByTestId('standard-save')).toHaveCount(0);
  await expect(page.getByTestId('standard-revise-banner')).toHaveCount(0);

  // --- Edit -> revise mode -----------------------------------------------------------------
  await page.getByTestId('standard-view-edit').click();
  await expect(page.getByTestId('standard-revise-banner')).toBeVisible();
  await expect(page.getByTestId('standard-editor-title')).toContainText('as a new version');
  await expect(page.getByTestId('standard-form')).toHaveJSProperty('disabled', false);
  await expect(page.getByTestId('standard-save')).toContainText('Save as draft');
  await expect(page.getByTestId('standard-publish')).toContainText('Save & publish new version');

  const i = await kindIndex(page, 'external_system');
  await page.getByTestId(`kind-fill-${i}-hex`).fill(hex);
  await page.getByTestId(`kind-fill-${i}-add`).click();
  await expect(page.getByTestId(`kind-fill-${i}`)).toContainText(hex);

  await page.getByTestId('standard-publish').click();
  await page.getByTestId('standard-publish-confirm-button').click();
  await expect(page.getByTestId('standards-editor-message')).toContainText(/Published v\d+ for C4 Context, replacing v\d+/);

  // --- versions list: new version Published, previous Retired --------------------------------
  await expect(page.locator('[data-testid^="standard-row-"]')).toHaveCount(versionsBefore + 1);
  await expect(page.getByTestId(`standard-status-${oldId}`)).toHaveText('Retired');
  const published = page.locator('[data-testid^="standard-status-"]', { hasText: 'Published' });
  await expect(published).toHaveCount(1);
  expect(await published.getAttribute('data-testid')).not.toBe(`standard-status-${oldId}`);

  // --- a new diagram offers the new swatch -------------------------------------------------
  // Already signed in as admin from the standards page; go to the project.
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await expect(page.getByTestId('sign-out')).toBeVisible();
  await newDiagram(page, 'c4-context');
  const node = await addKind(page, 'external_system');
  await page.getByTestId(`node-${node}`).hover();
  await page.getByTestId(`edit-style-${node}`).click();
  await expect(page.getByTestId(`style-fill-swatch-${node}-${hex.slice(1)}`)).toBeVisible();
});

test('generic flowchart shows a published starter standard that opens in view mode', async ({ page }) => {
  await openStandardsAdmin(page);
  await page.getByTestId('standards-type-flowchart').click();
  await expect(page.getByTestId('standards-empty')).toHaveCount(0);
  await expect(page.locator('[data-testid^="standard-status-"]', { hasText: 'Published' })).toHaveCount(1);

  await page.locator('[data-testid^="standard-view-"]:not([data-testid="standard-view-active"]):not([data-testid="standard-view-edit"])').first().click();
  await expect(page.getByTestId('standard-editor-title')).toContainText('(published)');
  await expect(page.getByTestId('standard-form')).toHaveJSProperty('disabled', true);
  await expect(page.getByTestId('standard-view-edit')).toBeVisible();
});

test('built-in type Roadmap can be edited (family locked) and is then badged edited', async ({ page }) => {
  const description = `Edited by e2e ${Date.now()}`;
  await openStandardsAdmin(page);
  const roadmap = page.getByTestId('standards-type-roadmap');
  await roadmap.click();
  await page.getByTestId('diagram-type-edit').click();

  await expect(page.getByTestId('diagram-type-dialog')).toBeVisible();
  await expect(page.getByTestId('diagram-type-family')).toBeDisabled();
  await page.getByTestId('diagram-type-description').fill(description);
  await page.getByTestId('diagram-type-save').click();
  await expect(page.getByTestId('diagram-type-dialog')).toHaveCount(0);

  await expect(roadmap).toContainText('Built-in · edited');

  // The edit persists across a reload.
  await page.reload();
  await expect(page.getByTestId('standards-type-roadmap')).toContainText('Built-in · edited');
});
