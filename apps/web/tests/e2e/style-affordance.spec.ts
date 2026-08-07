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

async function firstEdgeId(page: Page): Promise<string> {
  const testId = await page.locator('[data-testid^="edge-"]').first().getAttribute('data-testid');
  return testId!.replace('edge-', '');
}

/**
 * Setting `el.value = ...` directly goes through the setter React itself installs on the DOM
 * node instance to track the "last known value" — so a plain `input`/`change` dispatch after a
 * direct assignment is silently swallowed (React sees no change from its own tracked value and
 * never calls the component's onChange). Going through the *native* HTMLInputElement prototype
 * setter first, the same trick React Testing Library's fireEvent uses internally, bypasses
 * React's instance-level tracker so the subsequent 'input' event is actually observed as a real
 * change — the only reliable way to script a native `input[type=color]` pick.
 */
async function pickColor(page: Page, testId: string, hex: string) {
  await page.getByTestId(testId).evaluate((el: HTMLInputElement, value: string) => {
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    nativeSetter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, hex);
}

/**
 * canvas-xig: a second, separate small control next to the existing pencil affordance
 * (label-affordance.spec.ts) that opens a small floating color-picker popup instead of the
 * inline label editor. Deliberately its own affordance/popup so the pre-existing rename flow is
 * untouched — the regression check for that lives in label-affordance.spec.ts itself, re-run
 * unchanged alongside this spec.
 */
test('a shape reveals a style affordance on hover', async ({ page }) => {
  await openDiagramWithTwoConnectedShapes(page);

  const node = page.getByTestId('node-one');
  await expect(page.getByTestId('edit-style-one')).toHaveCount(0);
  await node.hover();
  await expect(page.getByTestId('edit-style-one')).toBeVisible();
});

test('a shape reveals the same style affordance on selection, so it is not hover-only', async ({ page }) => {
  await openDiagramWithTwoConnectedShapes(page);

  await page.getByTestId('node-one').click();
  await page.mouse.move(5, 5); // move the pointer well away, so only selection can be revealing it
  await expect(page.getByTestId('edit-style-one')).toBeVisible();
});

test('a connector reveals a style affordance on hover', async ({ page }) => {
  await openDiagramWithTwoConnectedShapes(page);
  const edgeId = await firstEdgeId(page);

  await expect(page.getByTestId(`edit-style-${edgeId}`)).toHaveCount(0);
  await page.locator('[data-testid^="edge-"]').first().hover();
  await expect(page.getByTestId(`edit-style-${edgeId}`)).toBeVisible();
});

test('clicking the style affordance on a node opens the color popup, and picking a color updates the DSL', async ({ page }) => {
  await openDiagramWithTwoConnectedShapes(page);

  await page.getByTestId('node-one').click();
  await page.getByTestId('edit-style-one').click();

  await expect(page.getByTestId('style-color-input-one')).toBeVisible();
  await pickColor(page, 'style-color-input-one', '#ff0000');

  await page.getByTestId('rail-tab-dsl').click();
  const dsl = await page.getByTestId('dsl-panel').inputValue();
  expect(dsl).toContain('#ff0000');
  expect(dsl).toContain('one');
});

test('clicking Clear removes the color override from the DSL', async ({ page }) => {
  await openDiagramWithTwoConnectedShapes(page);

  await page.getByTestId('node-one').click();
  await page.getByTestId('edit-style-one').click();

  await pickColor(page, 'style-color-input-one', '#ff0000');

  const dsl = await page.getByTestId('dsl-panel').inputValue();
  expect(dsl).toContain('#ff0000');

  await page.getByTestId('style-clear-one').click();

  // canvas-mup: a single-shot inputValue() read here raced the Clear click's React state update
  // (onChange -> updateNodeStyle -> re-render -> DSL panel content), intermittently reading a
  // stale value that still contained the cleared color (canvas-i2q). expect.poll retries within
  // its default timeout instead of reading once immediately.
  await expect.poll(() => page.getByTestId('dsl-panel').inputValue()).not.toContain('#ff0000');
});

test('clicking Done closes the popup without further changes', async ({ page }) => {
  await openDiagramWithTwoConnectedShapes(page);

  await page.getByTestId('node-one').click();
  await page.getByTestId('edit-style-one').click();
  await expect(page.getByTestId('style-color-input-one')).toBeVisible();

  await page.getByTestId('style-done-one').click();
  await expect(page.getByTestId('style-color-input-one')).toHaveCount(0);

  const dsl = await page.getByTestId('dsl-panel').inputValue();
  expect(dsl).not.toContain('fillColor');
});

test('pressing Escape while the popup is open closes it', async ({ page }) => {
  // This test originally caught a real bug (canvas-xig): opening the popup via the trigger
  // button left focus on the trigger, not inside the popup, so the Escape handler — a plain
  // onKeyDown on the popup's wrapping div — never saw the keypress. Fixed before canvas-xig
  // shipped by adding autoFocus to the popup's color input (canvas-th1: this comment previously
  // described the bug as still open and the test as expected to fail, which stopped being true
  // once the fix landed but was never updated).
  await openDiagramWithTwoConnectedShapes(page);

  await page.getByTestId('node-one').click();
  await page.getByTestId('edit-style-one').click();
  await expect(page.getByTestId('style-color-input-one')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('style-color-input-one')).toHaveCount(0);
});

test('picking a connector color updates canvas.edgeStyles in the DSL', async ({ page }) => {
  // This test originally caught a real bug (canvas-xig): edges are drawn before nodes in the
  // SVG, so for this suite's standard close-together two-node layout, the connector's style
  // affordance (offset further from the midpoint than the pencil affordance to sit beside it)
  // landed inside the target node's own rectangle and was genuinely unclickable. Fixed before
  // canvas-xig shipped by stacking the connector affordance vertically above the pencil instead
  // of beside it (canvas-th1: this comment previously described the bug as still open and the
  // test as expected to fail, which stopped being true once the fix landed but was never
  // updated). The shorter timeout is just a leftover fail-fast habit from that investigation; it
  // doesn't change what's being asserted.
  test.setTimeout(10_000);
  await openDiagramWithTwoConnectedShapes(page);
  const edgeId = await firstEdgeId(page);

  await page.locator('[data-testid^="edge-"]').first().hover();
  await page.getByTestId(`edit-style-${edgeId}`).click();

  await expect(page.getByTestId(`style-color-input-${edgeId}`)).toBeVisible();
  await pickColor(page, `style-color-input-${edgeId}`, '#0000ff');

  await page.getByTestId('rail-tab-dsl').click();
  const dsl = await page.getByTestId('dsl-panel').inputValue();
  expect(dsl).toContain('#0000ff');
  expect(dsl).toContain('edgeStyles');
});

test('the style affordance has an accessible name', async ({ page }) => {
  await openDiagramWithTwoConnectedShapes(page);

  await page.getByTestId('node-one').click();
  const affordance = page.getByTestId('edit-style-one');
  const name = await affordance.getAttribute('aria-label');
  expect(name, 'style affordance has no accessible name').toBeTruthy();
});
