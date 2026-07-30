import { expect, test } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * User Story 3 end-to-end: the "Add Shape" toolbar becomes diagram-family-aware. The seven new
 * shapes (default orientation only — no -alt buttons) must appear for every diagram type sharing
 * `dslFamily: 'flowchart'`, not just `diagramTypeId === 'flowchart'` itself (research.md §4) — and
 * must be absent for any other family.
 */
const NEW_SHAPE_BUTTONS = [
  'add-shape-stadium',
  'add-shape-subroutine',
  'add-shape-double-circle',
  'add-shape-hexagon',
  'add-shape-parallelogram',
  'add-shape-trapezoid',
  'add-shape-asymmetric',
];
const UNIVERSAL_SHAPE_BUTTONS = ['add-shape-rectangle', 'add-shape-rounded-rectangle', 'add-shape-circle', 'add-shape-diamond'];

async function login(page: import('@playwright/test').Page) {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await page.waitForURL('**/*');
}

async function createDiagramOfType(page: import('@playwright/test').Page, diagramTypeId: string) {
  await page.getByTestId('new-diagram').click();
  await page.getByTestId(`diagram-type-${diagramTypeId}`).check();
  await page.getByTestId('confirm-new-diagram').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
}

test('shows all 11 Add Shape buttons for the flowchart diagram type, but no -alt buttons', async ({ page }) => {
  await login(page);
  await createDiagramOfType(page, 'flowchart');

  for (const testId of [...UNIVERSAL_SHAPE_BUTTONS, ...NEW_SHAPE_BUTTONS]) {
    await expect(page.getByTestId(testId)).toBeVisible();
  }
  await expect(page.getByTestId('add-shape-parallelogram-alt')).toHaveCount(0);
  await expect(page.getByTestId('add-shape-trapezoid-alt')).toHaveCount(0);
});

test('shows only the 4 universal buttons for a non-flowchart-family diagram type (ERD)', async ({ page }) => {
  await login(page);
  await createDiagramOfType(page, 'erd');

  for (const testId of UNIVERSAL_SHAPE_BUTTONS) {
    await expect(page.getByTestId(testId)).toBeVisible();
  }
  for (const testId of NEW_SHAPE_BUTTONS) {
    await expect(page.getByTestId(testId)).toHaveCount(0);
  }
});

test('shows the 7 new shapes for business-capability-map (dslFamily flowchart, id not "flowchart")', async ({ page }) => {
  await login(page);
  await createDiagramOfType(page, 'business-capability-map');

  for (const testId of [...UNIVERSAL_SHAPE_BUTTONS, ...NEW_SHAPE_BUTTONS]) {
    await expect(page.getByTestId(testId)).toBeVisible();
  }
});

test('clicking each new toolbar button adds a node of exactly that shape', async ({ page }) => {
  await login(page);
  await createDiagramOfType(page, 'flowchart');

  const expectedDelimiters: Record<string, [string, string]> = {
    'add-shape-stadium': ['([', '])'],
    'add-shape-subroutine': ['[[', ']]'],
    'add-shape-double-circle': ['(((', ')))'],
    'add-shape-hexagon': ['{{', '}}'],
    'add-shape-parallelogram': ['[/', '/]'],
    'add-shape-trapezoid': ['[/', '\\]'],
    'add-shape-asymmetric': ['>', ']'],
  };

  for (const [testId, [open, close]] of Object.entries(expectedDelimiters)) {
    await page.getByTestId(testId).click();
    // Adding a node re-serializes the DSL asynchronously (state update -> useDslSync effect), so
    // this needs to poll rather than read inputValue() once immediately after the click.
    await expect
      .poll(async () => page.getByTestId('dsl-panel').inputValue())
      .toEqual(expect.stringContaining(open));
    await expect
      .poll(async () => page.getByTestId('dsl-panel').inputValue())
      .toEqual(expect.stringContaining(close));
  }
});
