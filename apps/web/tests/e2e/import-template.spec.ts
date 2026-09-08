import { expect, test } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * Golden path for "Import from Template": paste a filled-in C4 Context intake template (the
 * doc's own "Example — filled template → output" fixture, reassembled into a full document),
 * compile it via the template dialog, and confirm it becomes a real, rendered diagram with the
 * expected generated DSL — mirroring import.spec.ts's raw-DSL import flow.
 */
test('imports a filled C4 Context template and compiles it into a real diagram', async ({ page }) => {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await page.waitForURL('**/*');

  const template = [
    '# C4 Context Diagram — Intake Template',
    '',
    '## 1. Diagram metadata',
    '',
    '| Field | Value |',
    '|---|---|',
    '| Diagram title | System Context diagram: OrderService |',
    '| Central system name | OrderService |',
    '| Central system description (one line) | Handles order creation and fulfillment |',
    '| Central system technology (optional) | |',
    '',
    '## 2. Boundaries (optional)',
    '',
    '| Boundary name | Type (Enterprise / System) | Entities inside |',
    '|---|---|---|',
    '| | | |',
    '',
    '## 3. Surrounding entities',
    '',
    '| Name | Type | Internal/External | Description (one line) | Technology (optional) |',
    '|---|---|---|---|---|',
    '| Customer | Person | Internal | Places and tracks orders | |',
    '| Payment Gateway | System | External | Processes credit card payments | |',
    '',
    '## 4. Relationships',
    '',
    '| From | To | Label (short verb phrase) | Technology/protocol (optional) |',
    '|---|---|---|---|',
    '| Customer | OrderService | Places orders using | HTTPS |',
    '| OrderService | Payment Gateway | Sends payment requests to | HTTPS/JSON |',
    '',
    '## 5. Styling notes (optional)',
    '',
    '| Entity name | Background color | Font color | Border color |',
    '|---|---|---|---|',
    '| | | | |',
    '',
  ].join('\n');

  await page.getByTestId('import-template-button').click();
  await page.getByTestId('template-type-c4-context').click();
  await page.getByTestId('import-template-name').fill('Template Import Diagram');
  await page.getByTestId('import-template-textarea').fill(template);
  await page.getByTestId('confirm-import-template').click();

  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
  await expect(page.getByTestId('dsl-panel')).toContainText('System(orderService');
  await expect(page.getByTestId('dsl-panel')).toContainText('Person(customer');
});
