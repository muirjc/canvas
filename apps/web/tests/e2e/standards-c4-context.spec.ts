import { expect, test } from '@playwright/test';
import { PROJECT_ID, addKind, applyDsl, login, newDiagram, readDsl } from './standards-v2-helpers';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

test('c4 context: external system kind renders grey and serializes System_Ext', async ({ page }) => {
  await login(page);
  await newDiagram(page, 'c4-context');
  await expect(page.getByTestId('kind-toolbar')).toBeVisible();

  const id = await addKind(page, 'external_system');
  const node = page.getByTestId(`node-${id}`);
  await expect(node.locator('rect, path, ellipse, polygon').first()).toHaveAttribute('fill', /#999999/i);
  expect(await readDsl(page)).toContain('System_Ext(');
});

test('c4 context: Container element is flagged unknown-kind, unlabeled Rel flagged connector-label-required', async ({ page }) => {
  await login(page);
  await newDiagram(page, 'c4-context');

  await applyDsl(
    page,
    ['C4Context', '  System(a, "A")', '  System(b, "B")', '  Container(c, "C")', '  Rel(a, b, "")', ''].join('\n'),
  );
  await expect(page.locator('[data-testid^="node-"]')).toHaveCount(3);

  await page.getByTestId('rail-tab-issues').click();
  await expect(page.locator('[data-testid="violation-item"][data-rule="unknown-kind"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="violation-item"][data-rule="connector-label-required"]')).toHaveCount(1);
});
