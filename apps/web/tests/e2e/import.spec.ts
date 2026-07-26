import { expect, test } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * User Story 5 end-to-end: paste raw Mermaid DSL, import it, confirm it renders correctly, then
 * edit and re-export it exactly like a natively created diagram.
 */
test('imports a pasted Mermaid diagram and it becomes fully editable', async ({ page }) => {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await page.waitForURL('**/*');

  await page.getByTestId('import-diagram-button').click();
  await page.getByTestId('import-name').fill('Pasted Diagram');
  await page.getByTestId('import-textarea').fill('flowchart TD\n  A[Imported Start]\n  B[Imported End]\n  A --> B\n');
  await page.getByTestId('confirm-import').click();

  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
  await expect(page.getByTestId('dsl-panel')).toContainText('Imported Start');

  // Edit and re-export like a native diagram (US1's round-trip guarantees apply equally).
  await page.getByTestId('add-shape-circle').click();
  await page.getByTestId('save-diagram').click();
  await expect(page.getByTestId('save-status')).toHaveText('saved');

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-svg').click()]);
  expect(download.suggestedFilename()).toMatch(/\.svg$/);
});

test('imports the spec\'s originally-failing example ("graph" header, emoji labels, style directives)', async ({ page }) => {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await page.waitForURL('**/*');

  const dsl = [
    'graph TD',
    '    A[🚀 Welcome to Playground] --> B{Try Mermaid}',
    '    B -->|Edit Code| C[📝 Live Preview]',
    '    B -->|Love It?| D[✨ Sign Up]',
    '    C --> E[🎯 See Changes Instantly]',
    '    D --> F[💾 Save & Export]',
    '',
    '    style A fill:#e1f5fe',
    '    style D fill:#f3e5f5',
    '    style F fill:#e8f5e8',
    '',
  ].join('\n');

  await page.getByTestId('import-diagram-button').click();
  await page.getByTestId('import-name').fill('Playground Example');
  await page.getByTestId('import-textarea').fill(dsl);
  await page.getByTestId('confirm-import').click();

  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
  await expect(page.getByTestId('dsl-panel')).toContainText('Welcome to Playground');
});

test('rejects unrecognized pasted text with a specific error, not a silent failure', async ({ page }) => {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await page.waitForURL('**/*');

  await page.getByTestId('import-diagram-button').click();
  await page.getByTestId('import-textarea').fill('this is not any known diagram syntax\n');
  await page.getByTestId('confirm-import').click();

  await expect(page.getByTestId('import-error')).toBeVisible();
});
