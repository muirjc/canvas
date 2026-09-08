import { expect, test, type Page } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * canvas-2s6.9: the canvas's style popup has always been shown for sequence-family nodes/edges
 * too, but serializeSequence never emitted canvas.styles/canvas.edgeStyles at all — any style set
 * this way silently vanished on save/reload, unlike every other family. Confirms the DSL panel now
 * actually carries the style front-matter for a sequence diagram, the same level of coverage
 * style-popup-parity.spec.ts already established for flowchart.
 */

const SEQUENCE_DSL = ['sequenceDiagram', '  participant Alice', '  participant Bob', '  Alice->>Bob: Hi', ''].join('\n');

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

async function pickColor(page: Page, testId: string, hex: string) {
  await page.getByTestId(testId).evaluate((el: HTMLInputElement, value: string) => {
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    nativeSetter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, hex);
}

test('setting a participant\'s stroke color produces a real canvas.styles entry in the DSL', async ({ page }) => {
  await login(page);
  await importDsl(page, 'Sequence Style Round Trip Node', SEQUENCE_DSL);

  await page.getByTestId('node-Alice').click();
  await page.getByTestId('edit-style-Alice').click();
  await pickColor(page, 'style-stroke-input-Alice', '#00ff00');

  const source = await dsl(page);
  expect(source).toContain('styles:');
  expect(source).toContain('#00ff00');
});

test('setting a message\'s stroke width produces a real canvas.edgeStyles entry in the DSL', async ({ page }) => {
  await login(page);
  await importDsl(page, 'Sequence Style Round Trip Edge', SEQUENCE_DSL);

  const edgeId = (await page.locator('[data-testid^="edge-"]').first().getAttribute('data-testid'))!.replace('edge-', '');
  await page.locator('[data-testid^="edge-"]').first().hover();
  await page.getByTestId(`edit-style-${edgeId}`).click();
  await page.getByTestId(`style-stroke-width-${edgeId}`).fill('3');

  const source = await dsl(page);
  expect(source).toContain('edgeStyles:');
  expect(source).toContain('strokeWidth: 3');
});

test('a freshly imported sequence diagram with no styles has no front-matter block at all', async ({ page }) => {
  await login(page);
  await importDsl(page, 'Sequence Style Round Trip None', SEQUENCE_DSL);

  const source = await dsl(page);
  expect(source).not.toContain('---');
});
