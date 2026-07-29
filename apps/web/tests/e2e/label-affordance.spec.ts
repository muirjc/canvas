import { expect, test, type Page } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

async function openDiagramWithTwoConnectedShapes(page: Page) {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('sign-out')).toBeVisible();
  await page.getByTestId('new-diagram').click();
  await page.getByTestId('diagram-type-flowchart').check();
  await page.getByTestId('confirm-new-diagram').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();

  await page.getByTestId('dsl-panel').fill('flowchart TD\n  one[One]\n  two[Two]\n  one --> two\n');
  await page.getByTestId('apply-dsl').click();
  await expect(page.locator('[data-testid^="node-"]')).toHaveCount(2);
  await expect(page.locator('[data-testid^="edge-"]')).toHaveCount(1);
}

/**
 * User Story 3 (feature 006): label editing is *discoverable*.
 *
 * The capability itself is not new — double-clicking a shape or connector has opened an inline
 * editor since feature 002. Nothing on screen communicated it, so it was only found by accident
 * or by being told. These tests are about the affordance, not the editor.
 */
test('a shape reveals an edit affordance on hover', async ({ page }) => {
  await openDiagramWithTwoConnectedShapes(page);

  const node = page.getByTestId('node-one');
  await expect(page.getByTestId('edit-label-one')).toHaveCount(0);
  await node.hover();
  await expect(page.getByTestId('edit-label-one')).toBeVisible();
});

test('a shape reveals the same affordance on selection, so it is not hover-only', async ({ page }) => {
  await openDiagramWithTwoConnectedShapes(page);

  // FR-017 must hold for keyboard users too — an affordance that only appears on hover is
  // unreachable without a pointer and would fail the accessibility gate.
  await page.getByTestId('node-one').click();
  await page.mouse.move(5, 5); // move the pointer well away, so only selection can be revealing it
  await expect(page.getByTestId('edit-label-one')).toBeVisible();
});

test('activating the affordance opens the same inline editor', async ({ page }) => {
  await openDiagramWithTwoConnectedShapes(page);

  await page.getByTestId('node-one').click();
  await page.getByTestId('edit-label-one').click();

  // FR-019: the very same editor the double-click gesture produces.
  const input = page.getByTestId('node-label-input-one');
  await expect(input).toBeVisible();
  await input.fill('Renamed via affordance');
  await input.press('Enter');
  await expect(page.getByTestId('dsl-panel')).toContainText('Renamed via affordance');
});

test('the existing double-click gesture still works unchanged', async ({ page }) => {
  await openDiagramWithTwoConnectedShapes(page);

  // FR-020: the new affordance is a second entry point, not a replacement.
  await page.getByTestId('node-two').dblclick();
  const input = page.getByTestId('node-label-input-two');
  await expect(input).toBeVisible();
  await input.fill('Still works');
  await input.press('Enter');
  await expect(page.getByTestId('dsl-panel')).toContainText('Still works');
});

test('a connector reveals an edit affordance and it opens the connector editor', async ({ page }) => {
  await openDiagramWithTwoConnectedShapes(page);

  const edgeId = (await page
    .locator('[data-testid^="edge-"]')
    .first()
    .getAttribute('data-testid'))!.replace('edge-', '');

  // FR-018.
  await page.locator('[data-testid^="edge-"]').first().hover();
  const affordance = page.getByTestId(`edit-label-${edgeId}`);
  await expect(affordance).toBeVisible();

  await affordance.click();
  const input = page.getByTestId(`edge-label-input-${edgeId}`);
  await expect(input).toBeVisible();
  await input.fill('flows to');
  await input.press('Enter');
  await expect(page.getByTestId('dsl-panel')).toContainText('flows to');
});

test('the affordance has an accessible name', async ({ page }) => {
  await openDiagramWithTwoConnectedShapes(page);

  // Without one this fails the axe gate — an unlabelled control is exactly the regression the
  // plan flagged as most likely here.
  await page.getByTestId('node-one').click();
  const affordance = page.getByTestId('edit-label-one');
  const name = await affordance.getAttribute('aria-label');
  expect(name, 'edit affordance has no accessible name').toBeTruthy();
});
