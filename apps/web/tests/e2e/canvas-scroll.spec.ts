import { expect, test, type Page } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

async function signIn(page: Page) {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('sign-out')).toBeVisible();
}

async function openNewFlowchart(page: Page) {
  await page.getByTestId('new-diagram').click();
  await page.getByTestId('diagram-type-flowchart').check();
  await page.getByTestId('confirm-new-diagram').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
}

async function applyDsl(page: Page, dsl: string) {
  await page.getByTestId('rail-tab-dsl').click();
  await page.getByTestId('dsl-panel').fill(dsl);
  await page.getByTestId('apply-dsl').click();
}

/**
 * canvas-0s3: the canvas SVG used to render at a hardcoded 800x500 regardless of actual diagram
 * content, so a shape placed beyond that fixed size was clipped and completely unreachable — no
 * scrollbar, no way to pan to it. `Canvas.tsx` now sizes its `<svg>` to
 * Math.max(visible container, real content bounds) via `computeBounds` (packages/diagram-core),
 * so `.editor__canvas`'s pre-existing `overflow: auto` actually produces usable scrollbars.
 */
test('a shape placed far beyond the default viewport is reachable via scrolling and remains interactive', async ({ page }) => {
  await signIn(page);
  await openNewFlowchart(page);

  const farDsl = [
    '---',
    'canvas:',
    '  positions:',
    '    far:',
    '      x: 2000',
    '      y: 1500',
    '---',
    'flowchart TD',
    '  far[Far Away Shape]',
    '',
  ].join('\n');

  await applyDsl(page, farDsl);
  await expect(page.locator('[data-testid^="node-"]')).toHaveCount(1);

  const surface = page.getByTestId('canvas-surface');
  await expect(surface).toBeVisible();

  const overflowsBeforeScroll = await surface.evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    scrollHeight: el.scrollHeight,
    clientWidth: el.clientWidth,
    clientHeight: el.clientHeight,
  }));
  expect(overflowsBeforeScroll.scrollWidth).toBeGreaterThan(overflowsBeforeScroll.clientWidth);
  expect(overflowsBeforeScroll.scrollHeight).toBeGreaterThan(overflowsBeforeScroll.clientHeight);

  // The far node exists in the DOM already (SVG content isn't clipped out of the tree), but is
  // scrolled out of the visible viewport — confirm it's not visible until we actually scroll.
  await expect(page.getByTestId('node-far')).not.toBeInViewport();

  await surface.evaluate((el) => {
    el.scrollLeft = el.scrollWidth;
    el.scrollTop = el.scrollHeight;
  });

  await expect(page.getByTestId('node-far')).toBeInViewport();

  // Genuinely clickable/selectable, not just present in the DOM: clicking it reveals its style
  // affordance, which only appears on real selection (style-affordance.spec.ts).
  await page.getByTestId('node-far').click();
  await expect(page.getByTestId('edit-style-far')).toBeVisible();
});

/**
 * Regression check: an ordinary small diagram must NOT gain spurious scrollbars now that the
 * canvas size is computed dynamically instead of a fixed constant.
 */
test('an ordinary small diagram does not produce scrollbars', async ({ page }) => {
  await signIn(page);
  await openNewFlowchart(page);

  await applyDsl(page, 'flowchart TD\n  one[One]\n  two[Two]\n  one --> two\n');
  await expect(page.locator('[data-testid^="node-"]')).toHaveCount(2);

  const surface = page.getByTestId('canvas-surface');
  const dims = await surface.evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    scrollHeight: el.scrollHeight,
    clientWidth: el.clientWidth,
    clientHeight: el.clientHeight,
  }));

  // Allow a few pixels of slack for scrollbar/border rounding rather than requiring exact equality.
  expect(dims.scrollWidth - dims.clientWidth).toBeLessThanOrEqual(2);
  expect(dims.scrollHeight - dims.clientHeight).toBeLessThanOrEqual(2);
});

/**
 * The .app-shell/.app-content CSS changes that make the editor's canvas scroll internally
 * (height:100vh cap + overflow-y:auto) are shared by every screen, including the Projects page.
 * Not exhaustive — just confirms that screen still renders and its content is reachable.
 */
test('the Projects screen still renders and scrolls correctly after the shared layout CSS change', async ({ page }) => {
  await signIn(page);

  await page.getByTestId('view-projects').click();
  await expect(page.getByTestId('projects-page-list')).toBeVisible();
  await expect(page.locator('[data-testid^="projects-page-row-"]').first()).toBeInViewport();
});
