import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { expectSignedIn } from './auth-helpers';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run the demo seed (python -m canvas_api.jobs.seed_demo) and export it first');

/**
 * canvas-4h1j.2: Wardley maps in the editor. A "Wardley Map" diagram gets a Map elements toolbar instead of
 * the generic shapes; where an element sits is its [visibility, evolution] in the text, and dragging rewrites
 * them; the selected element/link has a panel (name, strategy, inertia, evolves to, pipeline; flow, dotted, label).
 */

async function login(page: Page): Promise<void> {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await expectSignedIn(page);
}

async function dsl(page: Page): Promise<string> {
  await page.getByTestId('rail-tab-dsl').click();
  return page.getByTestId('dsl-panel').inputValue();
}

async function createMap(page: Page): Promise<void> {
  await login(page);
  await page.getByTestId('new-diagram').click();
  await page.getByTestId('diagram-type-wardley').check();
  await page.getByTestId('confirm-new-diagram').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
  await expect(page.getByTestId('wardley-map')).toBeVisible();
}

/** Add an element of `kind`, name it, and return its id (a component's id is its name). */
async function addNamed(page: Page, kind: string, name: string): Promise<void> {
  await page.getByTestId(`add-wardley-${kind}`).click();
  await page.getByTestId('wardley-name').fill(name);
  await page.getByTestId('wardley-name').press('Enter');
  await expect(element(page, name)).toBeVisible();
}

/** An element by its drawn name (ids made in the editor are generated; only read text uses the name as id). */
function element(page: Page, name: string): Locator {
  return page.locator('[data-testid^="wardley-element-"]').filter({ has: page.getByText(name, { exact: true }) });
}

/** The dot drawn at the element's point (the group's box also holds the label). */
function dot(page: Page, name: string): Locator {
  return element(page, name).locator('circle').last();
}

/** Connect mode's gesture: click the source, wait for its green outline (the layer's marker for the source), then the target. */
async function connect(page: Page, from: string, to: string): Promise<void> {
  await dot(page, from).click();
  await expect(element(page, from).locator('rect[stroke="#16a34a"]')).toBeAttached();
  await dot(page, to).click();
}

/** The written `[visibility, evolution]` of a component or anchor. */
function coordinates(text: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.match(new RegExp(`^\\s*(?:component|anchor) ${escaped} (\\[[^\\]]*\\])`, 'm'))?.[1];
}

async function select(page: Page, id: string): Promise<void> {
  await dot(page, id).click();
  await expect(page.getByTestId('wardley-name')).toHaveValue(id);
}

test('Wardley Map is a diagram type with its own toolbar instead of the generic shapes', async ({ page }) => {
  await createMap(page);
  for (const kind of ['component', 'anchor', 'note', 'annotation', 'accelerator', 'deaccelerator']) {
    await expect(page.getByTestId(`add-wardley-${kind}`)).toBeVisible();
  }
  await expect(page.getByTestId('add-shape-rectangle')).toHaveCount(0);
  expect(await dsl(page)).toContain('wardley-beta');
});

test('adds elements, drags one (new 0-1 coordinates), renames, marks, pipelines, and draws links', async ({ page }) => {
  await createMap(page);
  await addNamed(page, 'component', 'Kettle');
  await addNamed(page, 'component', 'Power');
  await addNamed(page, 'anchor', 'User');
  await expect(page.locator('[data-testid^="wardley-element-"]')).toHaveCount(3);

  const before = await dsl(page);
  const kettleBefore = coordinates(before, 'Kettle');
  const powerBefore = coordinates(before, 'Power');
  expect(kettleBefore).toBeDefined();
  expect(powerBefore).toBeDefined();

  // Drag Kettle: its coordinates change to  numbers from 0 to 1; Power's stay as they were.
  await page.getByTestId('rail-tab-dsl').click();
  const target = await dot(page, 'Kettle').boundingBox();
  expect(target).not.toBeNull();
  const x = target!.x + target!.width / 2;
  const y = target!.y + target!.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 60, y + 40, { steps: 8 });
  await page.mouse.move(x + 120, y + 80, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => coordinates(await dsl(page), 'Kettle')).not.toBe(kettleBefore);
  const after = await dsl(page);
  expect(coordinates(after, 'Kettle')).toMatch(/^\[[01](\.\d{1,2})?, [01](\.\d{1,2})?\]$/);
  expect(coordinates(after, 'Power')).toBe(powerBefore);
  await expect(page.getByTestId('wardley-coordinates')).toContainText(/Visibility \d\.\d\d · Evolution \d\.\d\d/);

  // Renaming: a name that's taken is refused with a notice, a free one is written.
  await select(page, 'Power');
  await page.getByTestId('wardley-name').fill('Kettle');
  await page.getByTestId('wardley-name').press('Enter');
  await expect(page.getByTestId('wardley-notice')).toContainText('already a component named "Kettle"');
  expect(await dsl(page)).toContain('component Power [');
  await page.getByTestId('wardley-name').fill('Electricity');
  await page.getByTestId('wardley-name').press('Enter');
  await expect(element(page, 'Electricity')).toBeVisible();
  await expect(element(page, 'Power')).toHaveCount(0);
  expect(coordinates(await dsl(page), 'Electricity')).toBe(powerBefore);

  // Strategy, inertia and evolve.
  await select(page, 'Kettle');
  await page.getByTestId('wardley-strategy').selectOption('buy');
  await page.getByTestId('wardley-inertia').check();
  await page.getByTestId('wardley-evolve').fill('0.8');
  await page.getByTestId('wardley-evolve').press('Enter');
  await expect(page.locator('[data-testid^="wardley-evolve-"]')).toBeAttached();
  await expect(page.locator('[data-testid^="wardley-inertia-"]')).toBeAttached();
  let text = await dsl(page);
  expect(text).toMatch(/component Kettle \[[^\]]*\].*\(buy\)/);
  expect(text).toMatch(/component Kettle \[[^\]]*\].*\(inertia\)/);
  expect(text).toMatch(/^\s*evolve Kettle 0\.8/m);

  // Connect Kettle to Electricity: `Kettle -> Electricity`; then a forward flow from the link panel.
  await page.getByTestId('connect-mode-toggle').click();
  await connect(page, 'Kettle', 'Electricity');
  await expect(page.getByTestId('connect-mode-toggle')).toHaveText('Connect');
  await expect(page.locator('[data-testid^="wardley-link-"]:not([data-testid^="wardley-link-flow"])')).toHaveCount(1);
  expect(await dsl(page)).toMatch(/^\s*Kettle -> Electricity\s*$/m);
  await page.locator('[data-testid^="wardley-link-"]').first().locator('line').first().click({ force: true });
  await page.getByTestId('wardley-link-flow').selectOption('+>');
  await expect.poll(async () => dsl(page)).toMatch(/^\s*Kettle \+> Electricity\s*$/m);
  await page.getByTestId('wardley-link-dotted').check();
  await page.getByTestId('wardley-link-label').fill('needs');
  await page.getByTestId('wardley-link-label').press('Enter');
  await expect.poll(async () => dsl(page)).toMatch(/^\s*Kettle \+> -\.-> Electricity; needs\s*$/m);

  // Add to pipeline.
  await select(page, 'Kettle');
  await page.getByTestId('wardley-add-pipeline-component').click();
  await expect(page.locator('[data-testid^="wardley-pipeline-"]')).toHaveCount(1);
  text = await dsl(page);
  expect(text).toMatch(/pipeline Kettle \{\s*\n\s*component [^\n]*\[[\d.]+\][^\n]*\n\s*\}/);

  // A note can't be linked.
  await addNamed(page, 'note', 'Remember this');
  await page.getByTestId('connect-mode-toggle').click();
  await dot(page, 'Electricity').click();
  await element(page, 'Remember this').click();
  await expect(page.getByTestId('connect-notice')).toContainText('cannot be linked');
  await page.getByTestId('connect-mode-toggle').click();

  // Delete a component: it and its links go.
  await select(page, 'Electricity');
  await page.getByTestId('delete-selected').click();
  await expect(page.getByTestId('confirm-dialog')).toContainText('Delete 1 selected shape');
  await page.getByTestId('confirm-dialog-confirm').click();
  await expect(element(page, 'Electricity')).toHaveCount(0);
  expect(await dsl(page)).not.toContain('Electricity');
});

test('saves, reloads to the same map, and exports Mermaid', async ({ page }) => {
  await createMap(page);
  await addNamed(page, 'component', 'Tea');
  await addNamed(page, 'component', 'Water');
  await addNamed(page, 'anchor', 'Drinker');
  await page.getByTestId('connect-mode-toggle').click();
  await connect(page, 'Tea', 'Water');
  // Connect mode ends by itself once the link is made.
  await expect(page.getByTestId('connect-mode-toggle')).toHaveText('Connect');
  await select(page, 'Tea');
  await page.getByTestId('wardley-strategy').selectOption('build');

  await page.getByTestId('save-diagram').click();
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
  const saved = await dsl(page);
  expect(saved).toContain('wardley-beta');

  await page.reload();
  await expect(element(page, 'Tea')).toBeVisible();
  await expect(element(page, 'Water')).toBeVisible();
  await expect(element(page, 'Drinker')).toBeVisible();
  expect(await dsl(page)).toBe(saved);

  await page.getByTestId('export-menu-trigger').click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-mermaid').click()]);
  expect(download.suggestedFilename()).toMatch(/\.mmd$/);
  const path = await download.path();
  expect(readFileSync(path, 'utf8')).toContain('wardley-beta');
});

test('pasting wardley-beta text in the DSL tab and applying draws the elements', async ({ page }) => {
  await createMap(page);
  await page.getByTestId('rail-tab-dsl').click();
  await page.getByTestId('dsl-panel').fill(
    ['wardley-beta', '  title Tea shop', '  anchor Customer [0.95, 0.60]', '  component Cup of tea [0.70, 0.55]', '  component Kettle [0.45, 0.65] (buy)', '  Customer -> Cup of tea', '  Cup of tea -> Kettle', '  evolve Kettle 0.85', ''].join('\n'),
  );
  await page.getByTestId('apply-dsl').click();
  for (const id of ['Customer', 'Cup of tea', 'Kettle']) {
    await expect(element(page, id)).toBeVisible();
  }
  await expect(page.locator('[data-testid^="wardley-link-"]')).toHaveCount(2);
  await expect(page.locator('[data-testid^="wardley-evolve-"]')).toBeAttached();
  await expect(element(page, 'Kettle')).toHaveAttribute('data-strategy', 'buy');
});
