import { expect, test } from '@playwright/test';
import { openStandardsAdmin } from './standards-admin-helpers';

const PROJECT_ID = process.env.E2E_PROJECT_ID;

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * canvas-tfr Standards v2 admin: custom diagram type -> element-kind standard (swatches, connector
 * rule) -> save draft -> edit -> publish -> clone -> retire. Uses a unique type name per run so it
 * never touches the standards other specs depend on.
 */
test('admin builds, publishes, clones and retires a kind-based standard for a custom diagram type', async ({ page }) => {
  const typeName = `Process Map ${Date.now()}`;
  await openStandardsAdmin(page, '/?admin=standards');

  // --- custom diagram type ---------------------------------------------------------------
  await page.getByTestId('diagram-type-new').click();
  const dialog = page.getByTestId('diagram-type-dialog');
  await expect(dialog).toBeVisible();
  // No persona chosen yet: creating is refused with an inline message.
  await page.getByTestId('diagram-type-name').fill(typeName);
  await page.getByTestId('diagram-type-save').click();
  await expect(page.getByTestId('diagram-type-errors')).toContainText('persona');
  await page.getByTestId('diagram-type-family').selectOption('flowchart');
  await page.getByTestId('diagram-type-persona-Business').check();
  await page.getByTestId('diagram-type-save').click();
  await expect(dialog).toHaveCount(0);

  const typeButton = page.locator('[data-testid^="standards-type-"]', { hasText: typeName });
  await expect(typeButton).toContainText('Custom');
  await expect(typeButton).toHaveAttribute('aria-current', 'true');
  const typeId = (await typeButton.getAttribute('data-testid'))!.replace('standards-type-', '');
  await expect(page.getByTestId('standards-empty')).toBeVisible();

  // --- new standard with two kinds and a connector rule ----------------------------------
  await page.getByTestId('standard-new').click();
  await expect(page.getByTestId('standard-save')).toBeDisabled(); // name is required
  await page.getByTestId('standard-name-input').fill('Process rules');
  await page.getByTestId('standard-guidance-input').fill('Steps flow into decisions.');

  await page.getByTestId('kind-add').click();
  await page.getByTestId('kind-label-0').fill('Process Step');
  await expect(page.getByTestId('kind-id-0')).toHaveValue('process_step'); // auto-suggested
  await page.getByTestId('kind-shape-0-rectangle').check();
  await page.getByTestId('kind-fill-0-hex').fill('#dbeafe');
  await page.getByTestId('kind-fill-0-add').click();
  await expect(page.getByTestId('kind-fill-0-chip-0')).toContainText('#dbeafe');

  await page.getByTestId('kind-add').click();
  await page.getByTestId('kind-label-1').fill('Decision');
  await page.getByTestId('kind-shape-1-diamond').check();
  await page.getByTestId('kind-fill-1-hex').fill('#fef3c7');
  await page.getByTestId('kind-fill-1-add').click();
  await page.getByTestId('kind-fill-1-hex').fill('#fde68a');
  await page.getByTestId('kind-fill-1-add').click();
  await page.getByTestId('kind-fill-1-chip-1').getByRole('button', { name: /default/ }).click();
  await expect(page.getByTestId('kind-fill-1-chip-0')).toContainText('#fde68a');

  // A bad id surfaces inline and disables saving.
  await page.getByTestId('kind-id-1').fill('Bad-Id');
  await expect(page.getByTestId('error-elementKinds[1].id')).toBeVisible();
  await expect(page.getByTestId('standard-save')).toBeDisabled();
  await page.getByTestId('kind-id-1').fill('decision');
  await expect(page.getByTestId('standard-save')).toBeEnabled();

  await page.getByTestId('connector-add').click();
  await page.getByTestId('connector-label-0').fill('Step to decision');
  await page.getByTestId('connector-from-0').selectOption('process_step');
  await page.getByTestId('connector-to-0').selectOption('decision');
  await page.getByTestId('connector-line-0-solid').check();
  await page.getByTestId('connector-policy').check();

  await page.getByTestId('standard-save').click();
  await expect(page.getByTestId('standard-saved-note')).toContainText('Draft saved');
  await page.getByTestId('standard-cancel').click();

  // --- edit the draft from the list -------------------------------------------------------
  const rows = page.locator('[data-testid^="standard-row-"]');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Draft');
  await rows.first().locator('[data-testid^="standard-edit-"]').click();
  await expect(page.getByTestId('kind-id-0')).toHaveValue('process_step');
  await expect(page.getByTestId('connector-to-0')).toHaveValue('decision');
  await page.getByTestId('kind-desc-0').fill('One unit of work');
  await page.getByTestId('kind-min-0').fill('1');

  // --- publish (saves first, via confirm) -------------------------------------------------
  await page.getByTestId('standard-publish').click();
  await expect(page.getByTestId('standard-publish-confirm')).toContainText('re-checked');
  await page.getByTestId('standard-publish-confirm-button').click();
  await expect(page.getByTestId('standards-editor-message')).toContainText('Published standard v1');
  await expect(rows.first()).toContainText('Published');

  // The new type is selectable when creating a diagram.
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('new-diagram').click();
  await expect(page.getByTestId(`diagram-type-${typeId}`)).toBeVisible();
  await page.keyboard.press('Escape');

  // --- clone to a new draft, then retire the published one --------------------------------
  await page.goto('/?admin=standards');
  await page.getByTestId(`standards-type-${typeId}`).click();
  await rows.first().locator('[data-testid^="standard-clone-"]').click();
  await expect(page.getByTestId('kind-id-0')).toHaveValue('process_step'); // clone carries the kinds
  await page.getByTestId('standard-cancel').click();
  await expect(rows).toHaveCount(2);

  const published = rows.filter({ hasText: 'Published' }).first();
  await published.locator('[data-testid^="retire-standard-"]').click();
  await expect(rows.filter({ hasText: 'Retired' })).toHaveCount(1);
});

test('?admin=true still lands on the Standards page with flowchart selected', async ({ page }) => {
  await openStandardsAdmin(page, '/?admin=true');
  await expect(page.getByTestId('standards-selected-type')).toHaveText(/flowchart/i);
  await expect(page.getByTestId('admin-nav-standards')).toHaveAttribute('aria-current', 'page');
});
