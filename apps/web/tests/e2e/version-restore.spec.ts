import { expect, test, type Page } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/** A new flowchart saved twice more: v1 = one shape, v2 = two, v3 = three. */
async function diagramWithThreeVersions(page: Page) {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('login-email').fill('admin@example.com');
  await page.getByTestId('login-password').fill('admin-dev-password');
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('sign-out')).toBeVisible();
  await page.getByTestId('new-diagram').click();
  await page.getByTestId('diagram-type-flowchart').check();
  await page.getByTestId('confirm-new-diagram').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
  for (let i = 0; i < 3; i += 1) {
    await page.getByTestId('add-shape-rectangle').click();
    await page.getByTestId('save-diagram').click();
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
  }
  await page.getByTestId('rail-tab-history').click();
  await expect(page.getByTestId('version-4')).toBeVisible();
}

const nodes = (page: Page) => page.locator('[data-testid="canvas-surface"] [data-testid^="node-"]');

// canvas-3fha: preview an earlier version read-only, then restore it as a new, labelled version.
test('previewing a version is read-only, and Back returns to the current diagram', async ({ page }) => {
  await diagramWithThreeVersions(page);
  await expect(nodes(page)).toHaveCount(3);

  await page.getByTestId('view-version-2').click();
  await expect(page.getByTestId('version-preview-bar')).toContainText('Viewing v2');
  await expect(nodes(page)).toHaveCount(1);
  await expect(page.getByTestId('version-2')).toHaveAttribute('aria-current', 'true');
  // No editing while previewing.
  await expect(page.getByTestId('add-shape-rectangle')).toBeHidden();
  await expect(page.getByTestId('save-diagram')).toBeDisabled();
  await page.getByTestId('rail-tab-dsl').click();
  await expect(page.getByTestId('dsl-panel')).toHaveAttribute('readonly', '');
  await expect(page.getByTestId('apply-dsl')).toHaveCount(0);

  await page.getByTestId('close-preview').click();
  await expect(page.getByTestId('version-preview-bar')).toHaveCount(0);
  await expect(nodes(page)).toHaveCount(3);
  await expect(page.getByTestId('save-diagram')).toBeEnabled();
});

test('restoring asks first and adds a new version labelled with its source', async ({ page }) => {
  await diagramWithThreeVersions(page);
  await page.getByTestId('view-version-2').click();
  await page.getByTestId('restore-preview').click();

  // Cancel leaves everything as it was.
  await page.getByTestId('restore-cancel').click();
  await expect(page.getByTestId('version-preview-bar')).toBeVisible();

  await page.getByTestId('restore-preview').click();
  await page.getByTestId('restore-confirm-button').click();
  await expect(page.getByTestId('version-preview-bar')).toHaveCount(0);
  await expect(nodes(page)).toHaveCount(1);
  await expect(page.getByTestId('save-status')).toHaveText('Saved');
  await page.getByTestId('rail-tab-history').click();
  await expect(page.getByTestId('version-restored-from-5')).toHaveText('Restored from v2');
  // Nothing was discarded: the newest version before the restore is still there.
  await expect(page.getByTestId('version-4')).toBeVisible();
});

test('unsaved changes: restore offers to save them first, or to discard them', async ({ page }) => {
  await diagramWithThreeVersions(page);

  // Discard: the unsaved shape is gone, and no extra version was saved for it.
  await page.getByTestId('add-shape-rectangle').click();
  await expect(page.getByTestId('save-status')).toHaveText('Unsaved changes');
  await page.getByTestId('rail-tab-history').click();
  await page.getByTestId('view-version-2').click();
  await page.getByTestId('restore-preview').click();
  await expect(page.getByTestId('restore-unsaved')).toBeVisible();
  await page.getByTestId('restore-discard').click();
  await expect(nodes(page)).toHaveCount(1);
  await page.getByTestId('rail-tab-history').click();
  await expect(page.getByTestId('version-restored-from-5')).toBeVisible();

  // Save first: the unsaved work becomes its own version, then the restore follows it.
  await page.getByTestId('add-shape-rectangle').click();
  await page.getByTestId('rail-tab-history').click();
  await page.getByTestId('view-version-3').click();
  await page.getByTestId('restore-preview').click();
  await page.getByTestId('restore-save-first').click();
  await expect(page.getByTestId('version-preview-bar')).toHaveCount(0);
  await page.getByTestId('rail-tab-history').click();
  await expect(page.getByTestId('version-6')).toBeVisible();
  await expect(page.getByTestId('version-restored-from-7')).toHaveText('Restored from v3');
});
