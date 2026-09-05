import { expect, test, type Page } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

async function openNewDiagram(page: Page) {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('sign-out')).toBeVisible();
  await page.getByTestId('new-diagram').click();
  await page.getByTestId('diagram-type-flowchart').check();
  await page.getByTestId('confirm-new-diagram').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
}

/** Reads the DSL panel, which is the canonical representation — more reliable than screen
 *  geometry, and it proves the change actually reached the model. */
async function dsl(page: Page): Promise<string> {
  await page.getByTestId('rail-tab-dsl').click();
  return page.getByTestId('dsl-panel').inputValue();
}

/** Position of a container or node from the DSL front-matter. */
function positionOf(source: string, id: string): { x: number; y: number } {
  const match = source.match(new RegExp(`${id}:\\s*\\n\\s*x:\\s*(-?[0-9.]+)\\s*\\n\\s*y:\\s*(-?[0-9.]+)`));
  if (!match) throw new Error(`no position for "${id}" in DSL:\n${source}`);
  return { x: Number(match[1]), y: Number(match[2]) };
}

async function dragBy(page: Page, locator: ReturnType<Page['locator']>, dx: number, dy: number) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error('element has no bounding box');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 6 });
  await page.mouse.up();
}

/**
 * User Story 2 (feature 006): containers as first-class objects.
 *
 * Today a container can only be produced by grouping two or more shapes, is always called
 * "Group", and has no interaction handlers at all.
 */
test('creates an empty container without selecting anything first', async ({ page }) => {
  await openNewDiagram(page);

  // FR-007: no shape need be selected.
  await page.getByTestId('add-container').click();
  await expect(page.locator('[data-testid^="container-"]')).toHaveCount(1);
  await expect(page.locator('[data-testid^="node-"]')).toHaveCount(0);
});

// canvas-7vs.2 regression: the container <rect>'s fill briefly became "none" (matching
// svg-renderer.ts's export-only default) instead of "transparent" for a container with no
// style.fillColor -- SVG's default pointer-events behavior does not hit-test an unpainted
// ("none") fill, only a painted-but-invisible ("transparent") one, so every drag/resize/select
// interaction that targets a container's interior (not just its border stroke) silently stopped
// working. Caught by every other test in this file failing in CI, not by this test itself
// existing beforehand -- added after the fact so the exact mechanism has its own direct check.
test('a container with no explicit fill color still has a hit-testable (not "none") fill, so its interior stays clickable', async ({
  page,
}) => {
  await openNewDiagram(page);
  await page.getByTestId('add-container').click();
  const rect = page.locator('[data-testid^="container-"] rect').first();
  await expect(rect).toHaveAttribute('fill', 'transparent');

  // The actual behavior this attribute enables: clicking dead-center (not on the border) selects
  // the container via its interior, not just its stroke -- selection recolors the stroke to the
  // selection blue (Canvas.tsx: stroke={isSelected ? '#2563eb' : '#888'}), the same visible signal
  // the rest of this file's own tests rely on implicitly.
  const box = await rect.boundingBox();
  if (!box) throw new Error('container rect has no bounding box');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(rect).toHaveAttribute('stroke', '#2563eb');
});

test('renames a container and the name survives save and reopen', async ({ page }) => {
  await openNewDiagram(page);
  await page.getByTestId('add-container').click();

  const container = page.locator('[data-testid^="container-"]').first();
  await container.dblclick();
  const input = page.locator('[data-testid^="container-label-input-"]').first();
  await input.fill('Payments Domain');
  await input.press('Enter');

  await expect(page.getByTestId('dsl-panel')).toContainText('Payments Domain');

  // FR-014: survives a round trip through storage.
  await page.getByTestId('save-diagram').click();
  await expect(page.getByTestId('save-status')).toHaveText('saved');
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.locator('[data-testid^="open-diagram-"]').first().click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
  await expect(page.getByTestId('dsl-panel')).toContainText('Payments Domain');
});

test('moving a container takes its contents with it, preserving relative positions', async ({ page }) => {
  await openNewDiagram(page);

  // Two shapes at known positions, then a container placed over them.
  await page.getByTestId('dsl-panel').fill('flowchart TD\n  one[One]\n  two[Two]\n');
  await page.getByTestId('apply-dsl').click();
  await expect(page.locator('[data-testid^="node-"]')).toHaveCount(2);

  await page.getByTestId('add-container').click();
  const containerId = (await page
    .locator('[data-testid^="container-"]')
    .first()
    .getAttribute('data-testid'))!.replace('container-', '');

  // Put both shapes inside by dragging them onto the container.
  const containerBox = (await page.locator('[data-testid^="container-"]').first().boundingBox())!;
  for (const nodeId of ['one', 'two']) {
    const node = page.getByTestId(`node-${nodeId}`);
    const nodeBox = (await node.boundingBox())!;
    await dragBy(
      page,
      node,
      containerBox.x + 60 - (nodeBox.x + nodeBox.width / 2) + (nodeId === 'two' ? 90 : 0),
      containerBox.y + 60 - (nodeBox.y + nodeBox.height / 2),
    );
  }

  const before = await dsl(page);
  const oneBefore = positionOf(before, 'one');
  const containerBefore = positionOf(before, containerId);

  // FR-009 / SC-004: contents travel, relative positions unchanged.
  await dragBy(page, page.locator('[data-testid^="container-"]').first(), 120, 90);

  const after = await dsl(page);
  const oneAfter = positionOf(after, 'one');
  const containerAfter = positionOf(after, containerId);

  const containerDelta = { x: containerAfter.x - containerBefore.x, y: containerAfter.y - containerBefore.y };
  expect(containerDelta.x).not.toBe(0);
  expect(oneAfter.x - oneBefore.x).toBe(containerDelta.x);
  expect(oneAfter.y - oneBefore.y).toBe(containerDelta.y);
});

test('resizing a container moves nothing inside it and ejects nobody', async ({ page }) => {
  await openNewDiagram(page);
  await page.getByTestId('dsl-panel').fill('flowchart TD\n  one[One]\n');
  await page.getByTestId('apply-dsl').click();
  await page.getByTestId('add-container').click();

  const containerBox = (await page.locator('[data-testid^="container-"]').first().boundingBox())!;
  const node = page.getByTestId('node-one');
  const nodeBox = (await node.boundingBox())!;
  await dragBy(
    page,
    node,
    containerBox.x + 60 - (nodeBox.x + nodeBox.width / 2),
    containerBox.y + 60 - (nodeBox.y + nodeBox.height / 2),
  );

  const before = await dsl(page);
  const nodeBefore = positionOf(before, 'one');
  expect(before).toContain('subgraph');

  // Select the container so its resize handle appears, then shrink it well below its contents.
  await page.locator('[data-testid^="container-"]').first().click();
  const handle = page.locator('[data-testid^="container-resize-"]').first();
  await expect(handle).toBeVisible();
  await dragBy(page, handle, -200, -140);

  const after = await dsl(page);
  // FR-010: nothing inside moved.
  expect(positionOf(after, 'one')).toEqual(nodeBefore);
  // Membership is explicit, not geometric — shrinking must not eject the shape.
  expect(after).toContain('subgraph');
});

test('drags a shape into a container and back out again', async ({ page }) => {
  await openNewDiagram(page);
  await page.getByTestId('dsl-panel').fill('flowchart TD\n  one[One]\n');
  await page.getByTestId('apply-dsl').click();
  await page.getByTestId('add-container').click();

  const containerBox = (await page.locator('[data-testid^="container-"]').first().boundingBox())!;
  const node = page.getByTestId('node-one');
  const nodeBox = (await node.boundingBox())!;

  // FR-011: in.
  await dragBy(
    page,
    node,
    containerBox.x + 60 - (nodeBox.x + nodeBox.width / 2),
    containerBox.y + 60 - (nodeBox.y + nodeBox.height / 2),
  );
  expect(await dsl(page)).toContain('subgraph');

  // FR-011: out — drag far clear of the container.
  await dragBy(page, page.getByTestId('node-one'), 520, 300);
  const after = await dsl(page);
  const subgraphBody = after.slice(after.indexOf('subgraph'), after.indexOf('end'));
  expect(subgraphBody).not.toContain('one[One]');
});

test('deleting a container keeps every shape it held', async ({ page }) => {
  await openNewDiagram(page);
  await page.getByTestId('dsl-panel').fill('flowchart TD\n  one[One]\n');
  await page.getByTestId('apply-dsl').click();
  await page.getByTestId('add-container').click();

  const containerBox = (await page.locator('[data-testid^="container-"]').first().boundingBox())!;
  const node = page.getByTestId('node-one');
  const nodeBox = (await node.boundingBox())!;
  await dragBy(
    page,
    node,
    containerBox.x + 60 - (nodeBox.x + nodeBox.width / 2),
    containerBox.y + 60 - (nodeBox.y + nodeBox.height / 2),
  );
  const positionBefore = positionOf(await dsl(page), 'one');

  await page.locator('[data-testid^="container-"]').first().click();
  await page.getByTestId('delete-selected').click();

  // FR-013a: the confirmation must say the contents are kept.
  const confirm = page.getByTestId('confirm-dialog');
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText(/kept|keep/i);
  await page.getByTestId('confirm-dialog-confirm').click();

  // FR-013 / SC-004a: container gone, shape still present at the same position.
  await expect(page.locator('[data-testid^="container-"]')).toHaveCount(0);
  await expect(page.locator('[data-testid^="node-"]')).toHaveCount(1);
  expect(positionOf(await dsl(page), 'one')).toEqual(positionBefore);
});

test('the group action is presented as creating a container', async ({ page }) => {
  await openNewDiagram(page);
  await page.getByTestId('dsl-panel').fill('flowchart TD\n  one[One]\n  two[Two]\n');
  await page.getByTestId('apply-dsl').click();

  const nodes = page.locator('[data-testid^="node-"]');
  await nodes.nth(0).click();
  await nodes.nth(1).click({ modifiers: ['Shift'] });

  // FR-016: the control is preserved, its wording now uses the single term.
  const group = page.getByTestId('group-selected');
  await expect(group).toContainText(/container/i);
  await group.click();
  await expect(page.locator('[data-testid^="container-"]')).toHaveCount(1);
});
