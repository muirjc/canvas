import { expect, test, type Page } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';
const SELECTION_STROKE = '#2563eb';

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

/**
 * Places `count` rectangle nodes via repeated toolbar clicks. `addNode`'s grid-placement rule
 * (`x: 40 + (index % 5) * 160, y: 40 + Math.floor(index / 5) * 120`, each node 140x60) means with
 * fewer than 5 nodes their bounding boxes are known and non-overlapping:
 *   node 0: (40,40)-(180,100)   node 1: (200,40)-(340,100)   node 2: (360,40)-(500,100)
 */
async function addRectangles(page: Page, count: number) {
  for (let i = 0; i < count; i++) {
    await page.getByTestId('add-shape-rectangle').click();
  }
  await expect(page.locator('[data-testid^="node-"]')).toHaveCount(count);
}

function nodeRect(page: Page, index: number) {
  return page.locator('[data-testid^="node-"]').nth(index).locator('rect').first();
}

async function expectSelected(page: Page, index: number, selected: boolean) {
  const rect = nodeRect(page, index);
  if (selected) {
    await expect(rect).toHaveAttribute('stroke', SELECTION_STROKE);
  } else {
    await expect(rect).not.toHaveAttribute('stroke', SELECTION_STROKE);
  }
}

/**
 * Drags a rubber-band marquee from `from` to `to`, both given in SVG-local coordinates (matching
 * `toClientPoint`'s own coordinate space — offset from the `diagram-canvas` element's own
 * top-left, not page/viewport coordinates). Mirrors containers.spec.ts's `dragBy` helper's use of
 * raw `page.mouse` calls with `steps` for a realistic drag, but starts from an explicit point on
 * empty background rather than a locator's center.
 */
async function dragMarquee(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  modifiers: Array<'Shift' | 'Control'> = [],
) {
  const canvas = page.getByTestId('diagram-canvas');
  const box = (await canvas.boundingBox())!;
  for (const mod of modifiers) await page.keyboard.down(mod);
  await page.mouse.move(box.x + from.x, box.y + from.y);
  await page.mouse.down();
  await page.mouse.move(box.x + to.x, box.y + to.y, { steps: 8 });
  await page.mouse.up();
  for (const mod of modifiers) await page.keyboard.up(mod);
}

/**
 * canvas-558: standard Windows diagram-app multi-select conventions (Visio/PowerPoint/draw.io) —
 * Ctrl/Cmd+click toggles a node into/out of the selection (previously only Shift did), and
 * dragging on empty background draws a rubber-band marquee that selects every node it intersects.
 */
test('Ctrl+click adds a node to an already-selected node, both ending up selected', async ({ page }) => {
  await openNewDiagram(page);
  await addRectangles(page, 2);

  await page.locator('[data-testid^="node-"]').nth(0).click();
  await expectSelected(page, 0, true);
  await expectSelected(page, 1, false);

  await page.locator('[data-testid^="node-"]').nth(1).click({ modifiers: ['Control'] });
  await expectSelected(page, 0, true);
  await expectSelected(page, 1, true);
  await expect(page.getByTestId('delete-selected')).toBeEnabled();
  await expect(page.getByTestId('group-selected')).toBeEnabled();
});

test('Ctrl+click an already-selected node removes it from the selection (toggle off)', async ({ page }) => {
  await openNewDiagram(page);
  await addRectangles(page, 2);

  await page.locator('[data-testid^="node-"]').nth(0).click();
  await page.locator('[data-testid^="node-"]').nth(1).click({ modifiers: ['Control'] });
  await expectSelected(page, 0, true);
  await expectSelected(page, 1, true);

  // Toggle node 1 back off — only node 0 should remain selected.
  await page.locator('[data-testid^="node-"]').nth(1).click({ modifiers: ['Control'] });
  await expectSelected(page, 0, true);
  await expectSelected(page, 1, false);
});

test('dragging a marquee around multiple nodes selects exactly those nodes, and Delete Selected removes exactly them', async ({
  page,
}) => {
  await openNewDiagram(page);
  await addRectangles(page, 3);

  // Covers node 0 (40,40)-(180,100) and node 1 (200,40)-(340,100) fully; node 2 starts at x=360,
  // well clear of the marquee's right edge.
  await dragMarquee(page, { x: 20, y: 20 }, { x: 350, y: 120 });

  await expectSelected(page, 0, true);
  await expectSelected(page, 1, true);
  await expectSelected(page, 2, false);

  // Existing Group/Delete actions must work unmodified on a marquee-built selection — Delete is
  // exercised here (functional signal, not just the visual stroke check above).
  await page.getByTestId('delete-selected').click();
  const confirm = page.getByTestId('confirm-dialog');
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText('2 selected shapes');
  await page.getByTestId('confirm-dialog-confirm').click();

  await expect(page.locator('[data-testid^="node-"]')).toHaveCount(1);
});

test('a marquee that only partially overlaps a node still selects it (intersection, not containment)', async ({ page }) => {
  await openNewDiagram(page);
  await addRectangles(page, 1);
  // node 0 occupies (40,40)-(180,100). A marquee clipping only its bottom-right corner.
  await dragMarquee(page, { x: 150, y: 70 }, { x: 250, y: 200 });

  await expectSelected(page, 0, true);
});

test('Ctrl/Shift-held marquee drag adds to the existing selection instead of replacing it', async ({ page }) => {
  await openNewDiagram(page);
  await addRectangles(page, 3);

  // Select node 0 by a plain click first.
  await page.locator('[data-testid^="node-"]').nth(0).click();
  await expectSelected(page, 0, true);

  // Ctrl+drag a marquee around nodes 1 and 2 only — node 0 must remain selected too.
  await dragMarquee(page, { x: 190, y: 20 }, { x: 510, y: 120 }, ['Control']);

  await expectSelected(page, 0, true);
  await expectSelected(page, 1, true);
  await expectSelected(page, 2, true);
});

test('a plain click on empty canvas background clears the current selection', async ({ page }) => {
  await openNewDiagram(page);
  await addRectangles(page, 1);

  await page.locator('[data-testid^="node-"]').nth(0).click();
  await expectSelected(page, 0, true);

  // Well clear of the single node's bounding box (40,40)-(180,100).
  const canvas = page.getByTestId('diagram-canvas');
  const box = (await canvas.boundingBox())!;
  await canvas.click({ position: { x: box.width - 20, y: box.height - 20 } });

  await expectSelected(page, 0, false);
  await expect(page.getByTestId('delete-selected')).toBeDisabled();
});
