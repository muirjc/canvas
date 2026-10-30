import { expect, test, type Page } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * canvas-bx3: zoom in and out on the canvas. A view setting only -- never written to the diagram,
 * never an unsaved change -- and every drag lands at the right diagram coordinates at any zoom.
 */
async function openWith(page: Page, dsl: string) {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('sign-out')).toBeVisible();
  await page.getByTestId('new-diagram').click();
  await page.getByTestId('diagram-type-flowchart').check();
  await page.getByTestId('confirm-new-diagram').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
  await page.getByTestId('rail-tab-dsl').click();
  await page.getByTestId('dsl-panel').fill(dsl);
  await page.getByTestId('apply-dsl').click();
  await page.getByTestId('save-diagram').click();
  await expect(page.getByTestId('save-status')).toHaveText('Saved');
}

const ONE_SHAPE = ['---', 'canvas:', '  positions:', '    a:', '      x: 100', '      y: 100', '---', 'flowchart TD', '  a[Step]', ''].join('\n');

async function position(page: Page): Promise<{ x: number; y: number }> {
  const dsl = await page.getByTestId('dsl-panel').inputValue();
  const match = /a:\s*\n\s*x: (-?[\d.]+)\s*\n\s*y: (-?[\d.]+)/.exec(dsl);
  expect(match, dsl).not.toBeNull();
  return { x: Number(match![1]), y: Number(match![2]) };
}

async function dragShapeBy(page: Page, dx: number, dy: number) {
  const box = (await page.locator('[data-testid="node-a"]').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 6 });
  await page.mouse.up();
}

test('the buttons and keyboard shortcuts zoom in steps, and 100% resets', async ({ page }) => {
  await openWith(page, ONE_SHAPE);
  const level = page.getByTestId('zoom-reset');
  const canvas = page.getByTestId('diagram-canvas');
  await expect(level).toHaveText('100%');

  await page.getByTestId('zoom-in').click();
  await expect(level).toHaveText('110%');
  await expect(canvas).toHaveAttribute('data-zoom', '1.1');
  await page.getByTestId('zoom-out').click();
  await page.getByTestId('zoom-out').click();
  await expect(level).toHaveText('90%');

  await page.getByTestId('canvas-root').focus();
  await page.keyboard.press('Control+=');
  await expect(level).toHaveText('100%');
  await page.keyboard.press('Control+=');
  await expect(level).toHaveText('110%');
  await page.keyboard.press('Control+0');
  await expect(level).toHaveText('100%');

  // The shape is drawn bigger: twice the on-screen size at 200%.
  const before = (await page.locator('[data-testid="node-a"]').boundingBox())!;
  for (let i = 0; i < 5; i += 1) await page.getByTestId('zoom-in').click();
  await expect(level).toHaveText('200%');
  const after = (await page.locator('[data-testid="node-a"]').boundingBox())!;
  expect(after.width).toBeCloseTo(before.width * 2, 0);

  // Zooming is a view setting: the diagram stays saved.
  await expect(page.getByTestId('save-status')).toHaveText('Saved');
});

for (const [steps, zoom, direction] of [
  [5, 2, 'zoom-in'],
  [4, 0.5, 'zoom-out'],
] as const) {
  test(`dragging a shape at ${zoom * 100}% moves it by the on-screen distance divided by the zoom`, async ({ page }) => {
    await openWith(page, ONE_SHAPE);
    for (let i = 0; i < steps; i += 1) await page.getByTestId(direction).click();
    await expect(page.getByTestId('zoom-reset')).toHaveText(`${zoom * 100}%`);

    const start = await position(page);
    await dragShapeBy(page, 100, 60);
    await expect.poll(async () => (await position(page)).x).not.toBe(start.x);
    const end = await position(page);
    expect(end.x - start.x).toBeCloseTo(100 / zoom, -1);
    expect(end.y - start.y).toBeCloseTo(60 / zoom, -1);
  });
}

test('Fit to diagram shows a far-off shape without scrolling', async ({ page }) => {
  await openWith(page, ONE_SHAPE.replace('x: 100', 'x: 2400').replace('y: 100', 'y: 1600'));
  const surface = page.getByTestId('canvas-surface');
  const node = page.locator('[data-testid="node-a"]');
  await page.getByTestId('zoom-fit').click();
  await expect(page.getByTestId('zoom-reset')).not.toHaveText('100%');
  const view = (await surface.boundingBox())!;
  await expect
    .poll(async () => {
      const box = (await node.boundingBox())!;
      return box.x + box.width <= view.x + view.width && box.y + box.height <= view.y + view.height;
    })
    .toBe(true);
});
