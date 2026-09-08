import { expect, test, type Page } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * canvas-2s6.7: node strokeColor (mirroring the edge popup, which already had it), plus stroke
 * width/dash pattern/font family/font size on BOTH nodes and edges — none were ever settable from
 * the canvas even though updateNodeStyle/updateEdgeStyle (diagram-ops.ts) already modeled every
 * field. fontFamily/fontSize turned out to be a real gap one layer deeper too: StylePatch
 * (diagram-ops.ts) and the AI tool's own stylePatchSchema (diagram-tools.ts) never carried either
 * field at all, despite NodeStyle itself already declaring them — fixed alongside the canvas UI
 * since both routes share the exact same patch shape (Constitution I).
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

/** Same native-setter trick style-affordance.spec.ts's own pickColor uses — a plain value
 *  assignment on a controlled `input[type=color]` is silently swallowed by React's own tracked
 *  value, so the change must go through the native prototype setter first. */
async function pickColor(page: Page, testId: string, hex: string) {
  await page.getByTestId(testId).evaluate((el: HTMLInputElement, value: string) => {
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    nativeSetter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, hex);
}

const FLOWCHART_DSL = ['flowchart TD', '  one[One]', '  two[Two]', '  one --> two', ''].join('\n');

test('the node style popup has BOTH a Fill and a Stroke color field', async ({ page }) => {
  await login(page);
  await importDsl(page, 'Style Popup Node Fields', FLOWCHART_DSL);

  await page.getByTestId('node-one').click();
  await page.getByTestId('edit-style-one').click();

  await expect(page.getByTestId('style-fill-input-one')).toBeVisible();
  await expect(page.getByTestId('style-stroke-input-one')).toBeVisible();
});

test('the edge style popup has only a Stroke field, no Fill', async ({ page }) => {
  await login(page);
  await importDsl(page, 'Style Popup Edge Fields', FLOWCHART_DSL);

  const edgeId = (await page.locator('[data-testid^="edge-"]').first().getAttribute('data-testid'))!.replace('edge-', '');
  await page.locator('[data-testid^="edge-"]').first().hover();
  await page.getByTestId(`edit-style-${edgeId}`).click();

  await expect(page.getByTestId(`style-stroke-input-${edgeId}`)).toBeVisible();
  await expect(page.getByTestId(`style-fill-input-${edgeId}`)).toHaveCount(0);
});

test('setting a node\'s stroke color produces a real strokeColor entry in canvas.styles', async ({ page }) => {
  await login(page);
  await importDsl(page, 'Style Popup Node Stroke Color', FLOWCHART_DSL);

  await page.getByTestId('node-one').click();
  await page.getByTestId('edit-style-one').click();
  await pickColor(page, 'style-stroke-input-one', '#00ff00');

  const source = await dsl(page);
  expect(source).toContain('strokeColor');
  expect(source).toContain('#00ff00');
});

test('setting stroke width, dash pattern, font family, and font size on a node all reach the DSL', async ({ page }) => {
  await login(page);
  await importDsl(page, 'Style Popup Node Full Style', FLOWCHART_DSL);

  await page.getByTestId('node-one').click();
  await page.getByTestId('edit-style-one').click();
  await page.getByTestId('style-stroke-width-one').fill('4');
  await page.getByTestId('style-dasharray-one').fill('5 5');
  await page.getByTestId('style-font-family-one').fill('Georgia');
  await page.getByTestId('style-font-size-one').fill('18');

  const source = await dsl(page);
  expect(source).toContain('strokeWidth: 4');
  expect(source).toContain('strokeDasharray: 5 5');
  expect(source).toContain('fontFamily: Georgia');
  expect(source).toContain('fontSize: 18');
});

test('setting stroke width, dash pattern, font family, and font size on an edge all reach the DSL', async ({ page }) => {
  await login(page);
  await importDsl(page, 'Style Popup Edge Full Style', FLOWCHART_DSL);

  const edgeId = (await page.locator('[data-testid^="edge-"]').first().getAttribute('data-testid'))!.replace('edge-', '');
  await page.locator('[data-testid^="edge-"]').first().hover();
  await page.getByTestId(`edit-style-${edgeId}`).click();
  await page.getByTestId(`style-stroke-width-${edgeId}`).fill('2');
  await page.getByTestId(`style-dasharray-${edgeId}`).fill('2 4');
  await page.getByTestId(`style-font-family-${edgeId}`).fill('Courier');
  await page.getByTestId(`style-font-size-${edgeId}`).fill('10');

  const source = await dsl(page);
  expect(source).toContain('strokeWidth: 2');
  expect(source).toContain('strokeDasharray: 2 4');
  expect(source).toContain('fontFamily: Courier');
  expect(source).toContain('fontSize: 10');
});

test('clearing the font family field removes it from the DSL entirely', async ({ page }) => {
  await login(page);
  await importDsl(page, 'Style Popup Clear Font', FLOWCHART_DSL);

  await page.getByTestId('node-one').click();
  await page.getByTestId('edit-style-one').click();
  await page.getByTestId('style-font-family-one').fill('Georgia');
  await expect(await dsl(page)).toContain('fontFamily: Georgia');

  await page.getByTestId('node-one').click();
  await page.getByTestId('edit-style-one').click();
  await page.getByTestId('style-font-family-one').fill('');

  const source = await dsl(page);
  expect(source).not.toContain('fontFamily');
});

test('a flowchart subgraph gets a direction-override select when renamed, absent for other families', async ({ page }) => {
  await login(page);
  await importDsl(page, 'Subgraph Direction Picker', FLOWCHART_DSL);

  await page.getByTestId('add-container').click();
  const containerId = (await page.locator('[data-testid^="container-"]').first().getAttribute('data-testid'))!.replace('container-', '');
  await page.getByTestId(`container-${containerId}`).dblclick();

  await expect(page.getByTestId(`container-direction-${containerId}`)).toBeVisible();
});

test('picking a direction override on a subgraph produces a real "direction <X>" line inside it', async ({ page }) => {
  await login(page);
  await importDsl(page, 'Subgraph Direction Authoring', FLOWCHART_DSL);

  await page.getByTestId('add-container').click();
  const containerId = (await page.locator('[data-testid^="container-"]').first().getAttribute('data-testid'))!.replace('container-', '');
  await page.getByTestId(`container-${containerId}`).dblclick();
  await page.getByTestId(`container-direction-${containerId}`).selectOption('LR');

  const source = await dsl(page);
  expect(source).toMatch(/direction LR/);
});

test('picking "Inherit diagram direction" clears a previously-set override', async ({ page }) => {
  await login(page);
  await importDsl(page, 'Subgraph Direction Clear', FLOWCHART_DSL);

  await page.getByTestId('add-container').click();
  const containerId = (await page.locator('[data-testid^="container-"]').first().getAttribute('data-testid'))!.replace('container-', '');
  await page.getByTestId(`container-${containerId}`).dblclick();
  await page.getByTestId(`container-direction-${containerId}`).selectOption('LR');
  await expect(await dsl(page)).toContain('direction LR');

  await page.getByTestId(`container-${containerId}`).dblclick();
  await page.getByTestId(`container-direction-${containerId}`).selectOption('');

  const source = await dsl(page);
  expect(source).not.toContain('direction LR');
});

test('the direction-override select is absent for a non-flowchart container (C4 boundary)', async ({ page }) => {
  await login(page);
  await importDsl(
    page,
    'C4 No Direction Picker',
    ['C4Context', '  Person(user, "User")', '  System(sys, "System")', ''].join('\n'),
  );

  await page.getByTestId('node-user').click();
  await page.getByTestId('node-sys').click({ modifiers: ['Shift'] });
  await page.getByTestId('group-selected').click();

  const containerId = (await page.locator('[data-testid^="container-"]').first().getAttribute('data-testid'))!.replace('container-', '');
  await page.getByTestId(`container-${containerId}`).dblclick();

  await expect(page.getByTestId(`container-direction-${containerId}`)).toHaveCount(0);
});
