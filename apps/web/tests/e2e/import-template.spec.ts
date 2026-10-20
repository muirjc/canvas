import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { expectSignedIn } from './auth-helpers';

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
  await expectSignedIn(page);

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

async function signIn(page: import('@playwright/test').Page) {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await expectSignedIn(page);
}

/** canvas-73s.1-.5: every diagram type with a template compiler is offered, with its blank template. */
test('offers each template type with a download of its blank template', async ({ page }) => {
  await signIn(page);
  await page.getByTestId('import-template-button').click();
  const expected: Record<string, string> = {
    'c4-context': 'c4-context-template.md',
    'c4-container': 'c4-levels-template.md',
    'c4-component': 'c4-levels-template.md',
    'c4-deployment': 'c4-levels-template.md',
    sequence: 'sequence-template.md',
    erd: 'erd-template.md',
    uml: 'uml-class-template.md',
    network: 'architecture-template.md',
    deployment: 'architecture-template.md',
    'cloud-infrastructure': 'architecture-template.md',
  };
  await expect(page.getByTestId('download-template')).toHaveCount(0);
  for (const [typeId, fileName] of Object.entries(expected)) {
    await page.getByTestId(`template-type-${typeId}`).click();
    await expect(page.getByTestId('download-template')).toHaveAttribute('download', fileName);
  }

  await page.getByTestId('template-type-sequence').click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('download-template').click()]);
  expect(download.suggestedFilename()).toBe('sequence-template.md');
  const path = await download.path();
  expect(readFileSync(path!, 'utf-8')).toContain('# Sequence Diagram — Intake Template');
});

test('imports a filled sequence template into a real diagram', async ({ page }) => {
  await signIn(page);
  const template = [
    '# Sequence Diagram — Intake Template',
    '',
    '## 2. Participants',
    '',
    '| Name | Type |',
    '|---|---|',
    '| Customer | Actor |',
    '| Web Shop | Participant |',
    '',
    '## 3. Messages',
    '',
    '| # | From | To | Message | Arrow | Activation |',
    '|---|---|---|---|---|---|',
    '| 1 | Customer | Web Shop | Place order | Sync | Start |',
    '| 2 | Web Shop | Customer | Confirmation | Reply | End |',
    '',
  ].join('\n');

  await page.getByTestId('import-template-button').click();
  await page.getByTestId('template-type-sequence').click();
  await page.getByTestId('import-template-name').fill('Sequence Template Import');
  await page.getByTestId('import-template-textarea').fill(template);
  await page.getByTestId('confirm-import-template').click();

  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
  await expect(page.getByTestId('node-customer')).toBeVisible();
  await expect(page.getByTestId('node-webShop')).toBeVisible();
  await page.getByTestId('rail-tab-dsl').click();
  // The saved DSL is the serializer's canonical form: the "+" shorthand becomes an activate line.
  await expect(page.getByTestId('dsl-panel')).toHaveValue(/customer\s*->>\s*webShop\s*:\s*Place order\s*\n\s*activate webShop/);
});
