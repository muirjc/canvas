import { expect, test } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * canvas-x66: ER entity attributes (`DiagramNode.attributes`) and UML class members
 * (`DiagramNode.members`) were parsed and modeled correctly but never rendered by the interactive
 * canvas — every entity/class showed as a bare labeled box with no attribute/member rows at all.
 * Confirms the fix actually reaches the canvas via a real import, not just the export renderer
 * (covered separately by packages/diagram-core's own contract tests).
 */
const ERD_DSL = [
  'erDiagram',
  '  CUSTOMER {',
  '    string id PK',
  '    string name',
  '  }',
  '  ORDER {',
  '    string id PK',
  '  }',
  '  CUSTOMER ||--o{ ORDER : places',
  '',
].join('\n');

const UML_DSL = [
  'classDiagram',
  '  class Animal {',
  '    +String name',
  '    +makeSound() void',
  '  }',
  '',
].join('\n');

async function login(page: import('@playwright/test').Page) {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await page.waitForURL('**/*');
}

async function importDsl(page: import('@playwright/test').Page, name: string, dsl: string) {
  await page.getByTestId('import-diagram-button').click();
  await page.getByTestId('import-name').fill(name);
  await page.getByTestId('import-textarea').fill(dsl);
  await page.getByTestId('confirm-import').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
}

test('renders an ER entity\'s attribute rows on the canvas, not just its name', async ({ page }) => {
  await login(page);
  await importDsl(page, 'ER Attribute Rendering', ERD_DSL);

  const customer = page.locator('[data-testid="node-CUSTOMER"]');
  // A divider line separates the header band from the attribute rows -- absent for a plain box.
  await expect(customer.locator('line')).toHaveCount(1);
  await expect(customer).toContainText('string id PK');
  await expect(customer).toContainText('string name');

  const order = page.locator('[data-testid="node-ORDER"]');
  await expect(order.locator('line')).toHaveCount(1);
  await expect(order).toContainText('string id PK');
});

test('renders a UML class\'s attribute and method rows on the canvas, formatted differently', async ({ page }) => {
  await login(page);
  await importDsl(page, 'UML Member Rendering', UML_DSL);

  const animal = page.locator('[data-testid="node-Animal"]');
  await expect(animal.locator('line')).toHaveCount(1);
  await expect(animal).toContainText('+String name');
  await expect(animal).toContainText('+makeSound() void');
});

test('a plain flowchart node (no attributes/members) still renders with no divider line', async ({ page }) => {
  await login(page);
  await importDsl(page, 'Plain Node Regression Check', 'flowchart TD\n  A[Plain Box]\n');

  const node = page.locator('[data-testid="node-A"]');
  await expect(node.locator('line')).toHaveCount(0);
  await expect(node).toContainText('Plain Box');
});
