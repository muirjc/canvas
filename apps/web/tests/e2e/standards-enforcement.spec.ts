import { expect, test } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * User Story 2 end-to-end: an admin publishes a Standard restricting the flowchart diagram type
 * to rectangles only, then a diagram using a circle is created and saved — it must save
 * successfully (soft-flag, FR-024) while the violation is specifically surfaced (FR-013).
 */
test('admin publishes a standard; a violating diagram is soft-flagged, not blocked', async ({ page }) => {
  await page.goto('/?admin=true');
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await page.waitForURL('**/*?admin=true');

  await page.getByTestId('allowed-shape-rectangle').locator('input').check();
  await page.getByTestId('create-publish-standard').click();
  await expect(page.getByTestId('standards-editor-message')).toContainText('Published standard');

  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('new-diagram').click();
  await page.getByTestId('diagram-type-flowchart').check();
  await page.getByTestId('confirm-new-diagram').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();

  await page.getByTestId('add-shape-circle').click();
  await page.getByTestId('save-diagram').click();

  await expect(page.getByTestId('save-status')).toHaveText('saved');
  // Violations are one panel of the editor's secondary rail (feature 005). Navigation only.
  await page.getByTestId('rail-tab-issues').click();
  await expect(page.getByTestId('violations-panel')).toBeVisible();
  await expect(page.getByTestId('violation-item').first()).toContainText('allowed-shapes');

  // Save succeeded despite the violation — soft-flag, never a hard block.
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-svg').click()]);
  expect(download.suggestedFilename()).toMatch(/\.svg$/);
});

/**
 * Feature 009: the admin standards editor must offer all nine new shapes as governable, even
 * though only seven have a toolbar button (research.md §5) — an admin can still mandate/allow the
 * -alt orientations. This exercises the "zero validator change needed" claim end to end rather
 * than taking it on faith: `packages/diagram-core/src/standards/validator.ts` is already generic
 * over `NodeShape`.
 */
test('admin standards editor governs the nine new shapes, including a mandatory-shape violation', async ({ page }) => {
  await page.goto('/?admin=true');
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await page.waitForURL('**/*?admin=true');

  const newShapes = [
    'stadium',
    'subroutine',
    'double-circle',
    'hexagon',
    'parallelogram',
    'parallelogram-alt',
    'trapezoid',
    'trapezoid-alt',
    'asymmetric',
  ];
  for (const shape of newShapes) {
    await expect(page.getByTestId(`allowed-shape-${shape}`)).toBeVisible();
    await expect(page.getByTestId(`mandatory-shape-${shape}`)).toBeVisible();
  }

  await page.getByTestId('mandatory-shape-hexagon').locator('input').check();
  await page.getByTestId('create-publish-standard').click();
  await expect(page.getByTestId('standards-editor-message')).toContainText('Published standard');

  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('new-diagram').click();
  await page.getByTestId('diagram-type-flowchart').check();
  await page.getByTestId('confirm-new-diagram').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();

  // No hexagon added — the mandatory-shape rule should flag its absence.
  await page.getByTestId('add-shape-rectangle').click();
  await page.getByTestId('save-diagram').click();
  await expect(page.getByTestId('save-status')).toHaveText('saved');

  await page.getByTestId('rail-tab-issues').click();
  await expect(page.getByTestId('violations-panel')).toBeVisible();
  await expect(page.getByTestId('violation-item').first()).toContainText('mandatory-shapes');
});
