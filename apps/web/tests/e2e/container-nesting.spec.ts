import { expect, test, type Page, type Locator } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * canvas-2s6.8: Canvas.tsx had ZERO references to parentContainerId anywhere — there was no drag/
 * drop or any other UI mechanism to nest one container inside another, for any diagram family,
 * even though the model/DSL (and the backing setContainerParent/removeContainerParent ops,
 * canvas-2s6.1) already fully supported it. Confirms dragging one container fully inside another's
 * bounds nests it (a real DSL structural change, not just a position change), dragging it back out
 * clears the nesting, and a live drop-target highlight appears while dragging.
 */

async function login(page: Page) {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await page.waitForURL('**/*');
}

async function importDsl(page: Page, name: string, source: string) {
  await page.getByTestId('import-diagram-button').click();
  await page.getByTestId('import-name').fill(name);
  await page.getByTestId('import-textarea').fill(source);
  await page.getByTestId('confirm-import').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
}

async function dsl(page: Page): Promise<string> {
  await page.getByTestId('rail-tab-dsl').click();
  return page.getByTestId('dsl-panel').inputValue();
}

async function dragBy(page: Page, locator: Locator, dx: number, dy: number) {
  await locator.scrollIntoViewIfNeeded();
  const box = (await locator.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 6 });
  await page.mouse.up();
}

/** Drags `locator` so its centre lands exactly on `target`'s current centre — the reliable way to
 *  guarantee it ends up well inside target's bounds regardless of either element's size, rather
 *  than an ad-hoc pixel offset that can misjudge how much of the dragged element's own bulk
 *  extends past whatever point the pointer itself lands on. */
async function dragOnto(page: Page, locator: Locator, target: Locator) {
  await locator.scrollIntoViewIfNeeded();
  const box = (await locator.boundingBox())!;
  const targetBox = (await target.boundingBox())!;
  const dx = targetBox.x + targetBox.width / 2 - (box.x + box.width / 2);
  const dy = targetBox.y + targetBox.height / 2 - (box.y + box.height / 2);
  await dragBy(page, locator, dx, dy);
}

/** Drags `locator` well clear of `target`'s bounds — up and to the left, since every fixture here
 *  starts with plenty of open canvas in that direction. */
async function dragAwayFrom(page: Page, locator: Locator, target: Locator) {
  await locator.scrollIntoViewIfNeeded();
  const box = (await locator.boundingBox())!;
  const targetBox = (await target.boundingBox())!;
  const dx = targetBox.x - 300 - (box.x + box.width / 2);
  const dy = targetBox.y - 300 - (box.y + box.height / 2);
  await dragBy(page, locator, dx, dy);
}

/** Same as dragOnto, but pauses mid-drag (still held down) so the caller can assert the live
 *  drop-target highlight before completing the drop. */
async function dragOntoHeld(page: Page, locator: Locator, target: Locator) {
  await locator.scrollIntoViewIfNeeded();
  const box = (await locator.boundingBox())!;
  const targetBox = (await target.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 6 });
}

test('dragging one container fully inside another nests it (a real "subgraph" indent, not just a position change)', async ({ page }) => {
  await login(page);
  await importDsl(page, 'Container Nest Flowchart', 'flowchart TD\n  a[A]\n');

  await page.getByTestId('add-container').click();
  await page.getByTestId('add-container').click();
  const containers = page.locator('[data-testid^="container-"]');
  await expect(containers).toHaveCount(2);
  const outer = containers.nth(0);
  const inner = containers.nth(1);

  await dragOnto(page, inner, outer);

  const source = await dsl(page);
  expect(source).toMatch(/^\s{2,}subgraph/m);
});

test('dragging a nested container back out to open canvas clears the nesting', async ({ page }) => {
  await login(page);
  await importDsl(page, 'Container Unnest Flowchart', 'flowchart TD\n  a[A]\n');

  await page.getByTestId('add-container').click();
  await page.getByTestId('add-container').click();
  const containers = page.locator('[data-testid^="container-"]');
  const outer = containers.nth(0);
  const inner = containers.nth(1);

  await dragOnto(page, inner, outer);
  expect(await dsl(page)).toMatch(/^\s{2,}subgraph/m);

  await dragAwayFrom(page, inner, outer);

  const source = await dsl(page);
  expect(source).not.toMatch(/^\s{2,}subgraph/m);
});

test('a live green drop-target highlight appears on the target container while dragging over it', async ({ page }) => {
  await login(page);
  await importDsl(page, 'Container Nest Drop Highlight', 'flowchart TD\n  a[A]\n');

  await page.getByTestId('add-container').click();
  await page.getByTestId('add-container').click();
  const containers = page.locator('[data-testid^="container-"]');
  const outer = containers.nth(0);
  const inner = containers.nth(1);

  await dragOntoHeld(page, inner, outer);
  await expect(outer.locator('rect').first()).toHaveAttribute('stroke', '#16a34a');

  await page.mouse.up();
  const source = await dsl(page);
  expect(source).toMatch(/^\s{2,}subgraph/m);
});

test('dropping a container back on open canvas shows no highlight and no nesting', async ({ page }) => {
  await login(page);
  await importDsl(page, 'Container No False Highlight', 'flowchart TD\n  a[A]\n');

  await page.getByTestId('add-container').click();
  await page.getByTestId('add-container').click();
  const containers = page.locator('[data-testid^="container-"]');
  const outer = containers.nth(0);
  const inner = containers.nth(1);

  await dragAwayFrom(page, inner, outer);
  await expect(outer.locator('rect').first()).not.toHaveAttribute('stroke', '#16a34a');
  expect(await dsl(page)).not.toMatch(/^\s{2,}subgraph/m);
});

test('architecture: dragging one group inside another produces a real "in <groupId>" clause', async ({ page }) => {
  await login(page);
  await importDsl(page, 'Container Nest Architecture', 'architecture-beta\n  group left(cloud)[Left]\n  group right(cloud)[Right]\n');

  const groups = page.locator('[data-testid^="container-"]');
  await expect(groups).toHaveCount(2);
  const outer = groups.nth(0);
  const inner = groups.nth(1);

  await dragOnto(page, inner, outer);

  const source = await dsl(page);
  expect(source).toMatch(/group right\(cloud\)\[Right\] in left/);
});

test('dragging a container onto its own child does not nest it into itself (no cycle)', async ({ page }) => {
  await login(page);
  await importDsl(page, 'Container No Self Cycle', 'flowchart TD\n  a[A]\n');

  await page.getByTestId('add-container').click();
  await page.getByTestId('add-container').click();
  const containers = page.locator('[data-testid^="container-"]');
  const outer = containers.nth(0);
  const inner = containers.nth(1);

  // Nest inner inside outer first.
  await dragOnto(page, inner, outer);
  expect(await dsl(page)).toMatch(/^\s{2,}subgraph/m);

  // Now drag the OUTER container onto the inner one — must not create a cycle; outer should
  // simply move (carrying inner along, per moveContainer's own cascade), staying top-level.
  await dragOnto(page, outer, inner);

  const source = await dsl(page);
  // Still exactly one nested (indented) subgraph -- the structure wasn't corrupted into a cycle.
  const nestedCount = (source.match(/^\s{2,}subgraph/gm) ?? []).length;
  expect(nestedCount).toBe(1);
});
