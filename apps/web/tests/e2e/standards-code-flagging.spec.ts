import { expect, test } from '@playwright/test';
import { PROJECT_ID, login, newDiagram } from './standards-v2-helpers';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

test('value chain DSL: an unknown kind class is flagged by line before Apply, and Apply/Save still work', async ({ page }) => {
  await login(page);
  await newDiagram(page, 'value-chain');
  await page.getByTestId('rail-tab-dsl').click();

  const dsl = ['flowchart LR', '  a>Alpha]:::primary_activity', '  b[Bravo]:::bogus', ''].join('\n');
  const panel = page.getByTestId('dsl-panel');
  await panel.fill(dsl);

  const issue = page.locator('[data-testid="dsl-standards-issue"][data-rule="unknown-kind"]');
  await expect(issue).toHaveCount(1);
  const line = await issue.getAttribute('data-line');
  expect(Number(line)).toBe(3);

  await page.getByTestId(`dsl-standards-line-${line}`).click();
  const lines = dsl.split('\n');
  const start = lines.slice(0, 2).join('\n').length + 1;
  const end = start + lines[2].length;
  await expect.poll(() => panel.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])).toEqual([start, end]);

  await page.getByTestId('apply-dsl').click();
  await expect(page.locator('[data-testid^="node-"]')).toHaveCount(2);
  await page.getByTestId('save-diagram').click();
  await expect(page.getByTestId('save-status')).toHaveText(/saved/i);
});
