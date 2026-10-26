import { expect, test, type Page } from '@playwright/test';
import { addKind, applyDsl, login, newDiagram, PROJECT_ID, readDsl } from './standards-v2-helpers';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');
test.describe.configure({ timeout: 90_000 });

/** canvas-eac: pinning a comment -- why the checkbox is off, and pinning to a group as well as a shape. */

async function save(page: Page) {
  await page.getByTestId('save-diagram').click();
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
}

async function openComments(page: Page) {
  await page.getByTestId('rail-tab-comments').click();
  await expect(page.getByTestId('comments-panel')).toBeVisible();
}

const thread = (page: Page, text: string) =>
  page.locator('[data-testid^="comment-thread-"]:not([data-testid*="-el-"])', { hasText: text });

async function postPinned(page: Page, text: string) {
  await page.getByTestId('comment-new').fill(text);
  await page.getByTestId('comment-pin-selected').check();
  await page.getByTestId('comment-new-submit').click();
  await expect(thread(page, text)).toHaveCount(1);
}

test('value chain: the pin checkbox explains itself, then pins the selected element', async ({ page }) => {
  await login(page);
  await newDiagram(page, 'value-chain');
  const id = await addKind(page, 'primary_activity');
  // The node's text also holds a standards badge, so take the label from the DSL.
  const label = (await readDsl(page)).match(new RegExp(`${id}[\\[>(]+(.+?)[\\])]+:::`))?.[1] ?? '';
  expect(label).not.toBe('');
  await save(page);
  await openComments(page);

  const pin = page.getByTestId('comment-pin-selected');
  await expect(pin).toBeDisabled();
  await expect(page.getByTestId('comment-pin-hint')).toHaveText(
    'To pin this comment, select one shape, connector or group on the canvas.',
  );

  await page.getByTestId(`node-${id}`).click();
  await expect(pin).toBeEnabled();
  await expect(page.getByTestId('comment-pin-hint')).toHaveCount(0);
  await expect(page.getByText(`Pin to ${label}`, { exact: false }).first()).toBeVisible();

  const text = `Pinned to value chain element ${Date.now()}`;
  await postPinned(page, text);
  await expect(thread(page, text)).toContainText(`On: ${label}`);
  await expect(page.getByTestId(`comment-pin-${id}`)).toBeVisible();
});

test('a group (subgraph) can be pinned to, and gets a pin on the canvas', async ({ page }) => {
  await login(page);
  await newDiagram(page, 'flowchart');
  await applyDsl(page, 'flowchart TD\n  subgraph grp[Billing Area]\n    a[Alpha]\n  end\n');
  await expect(page.locator('[data-testid^="container-"]')).toHaveCount(1);
  await save(page);
  await openComments(page);

  const containerTestId = (await page.locator('[data-testid^="container-"]').first().getAttribute('data-testid'))!;
  const containerId = containerTestId.replace('container-', '');
  await expect(page.getByTestId('comment-pin-selected')).toBeDisabled();

  // Click the container's own rect, near its top-left corner (inside it, clear of the child node).
  const box = (await page.locator(`[data-testid="${containerTestId}"] rect`).first().boundingBox())!;
  await page.mouse.click(box.x + 6, box.y + 6);
  await expect(page.getByTestId('comment-pin-selected')).toBeEnabled();
  await expect(page.getByText('Pin to Billing Area').first()).toBeVisible();

  const text = `Pinned to a group ${Date.now()}`;
  await postPinned(page, text);
  await expect(thread(page, text)).toContainText('On: Billing Area');
  await expect(page.getByTestId(`comment-pin-${containerId}`)).toBeVisible();
});
