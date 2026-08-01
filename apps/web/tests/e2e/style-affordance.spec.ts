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

  let dsl = await page.getByTestId('dsl-panel').inputValue();
  expect(dsl).toContain('#ff0000');

  await page.getByTestId('style-clear-one').click();

  dsl = await page.getByTestId('dsl-panel').inputValue();
  expect(dsl).not.toContain('#ff0000');
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
  // KNOWN BUG (found by this test, reported rather than worked around): opening the popup via
  // the trigger button leaves focus ON THE TRIGGER BUTTON, not inside the popup — nothing moves
  // focus into it (no autoFocus on the color input, no effect-driven focus()). The popup's
  // Escape handler is a plain onKeyDown on its wrapping div, which only ever sees the event if
  // focus is already somewhere inside that div when Escape is pressed. In the normal
  // click-the-palette-icon flow, it never is, so Escape does nothing — confirmed by manually
  // focusing an element inside the popup first (e.g. the Done button), at which point Escape
  // does close it. This assertion intentionally reflects the *intended* behavior (documented in
  // Canvas.tsx's own comment: "Escape also closes it, matching the label editors") and is
  // expected to fail until focus is actually moved into the popup on open.
  await openDiagramWithTwoConnectedShapes(page);

  await page.getByTestId('node-one').click();
  await page.getByTestId('edit-style-one').click();
  await expect(page.getByTestId('style-color-input-one')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('style-color-input-one')).toHaveCount(0);
});

test('picking a connector color updates canvas.edgeStyles in the DSL', async ({ page }) => {
  // KNOWN BUG (found by this test, reported rather than worked around): edges are drawn before
  // nodes in the SVG, so a node painted afterwards sits on top of any earlier edge's
  // foreignObject content. For two nodes as close together as this suite's standard default
  // two-node layout (the exact layout label-affordance.spec.ts and every other canvas e2e spec
  // already uses), the connector's style affordance — offset further from the midpoint
  // (`midX + 34`) than the pre-existing pencil affordance (`midX + 8`) to sit beside it without
  // overlapping — lands inside the target node's own rectangle and is genuinely unclickable by a
  // real pointer, not just by Playwright. A shorter timeout here just fails fast; it does not
  // change what's being asserted.
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
