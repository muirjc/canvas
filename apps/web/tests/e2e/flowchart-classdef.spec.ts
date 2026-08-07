import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * Grouping C (docs/flowchart-completeness-brief.md): Mermaid's `classDef <name> <props>` /
 * `class <id1>,<id2>,... <name>` must apply on import, render on the canvas and in export, and
 * survive a save/reload round-trip — the same three checks feature 009 used for node shapes.
 */
const CLASSDEF_DSL = [
  'flowchart TD',
  '  A[Highlighted] --> B[Plain]',
  '  classDef highlight fill:#ff00ff,stroke:#333333',
  '  class A highlight',
  '',
].join('\n');

async function login(page: import('@playwright/test').Page) {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await page.waitForURL('**/*');
}

async function importClassDefDiagram(page: import('@playwright/test').Page, name: string) {
  await page.getByTestId('import-diagram-button').click();
  await page.getByTestId('import-name').fill(name);
  await page.getByTestId('import-textarea').fill(CLASSDEF_DSL);
  await page.getByTestId('confirm-import').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
}

test('renders a class-assigned node with its classDef fill/stroke, not the default', async ({ page }) => {
  await login(page);
  await importClassDefDiagram(page, 'ClassDef Canvas');

  const highlighted = page.locator('[data-testid="node-A"] [fill="#ff00ff"]');
  await expect(highlighted).toHaveCount(1);
  await expect(page.locator('[data-testid="node-B"] [fill="#ff00ff"]')).toHaveCount(0);
});

test('exports the class-assigned node with the same fill/stroke', async ({ page }) => {
  await login(page);
  await importClassDefDiagram(page, 'ClassDef Export');

  await page.getByTestId('export-menu-trigger').click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-svg').click()]);
  const path = await download.path();
  expect(path).not.toBeNull();
  const svg = readFileSync(path!, 'utf-8');

  expect(svg).toMatch(/fill="#ff00ff"[^>]*stroke="#333333"|stroke="#333333"[^>]*fill="#ff00ff"/);
});

test('preserves the class-applied style through save and reload', async ({ page }) => {
  await login(page);
  const diagramName = `ClassDef Round Trip ${Date.now()}`;
  await importClassDefDiagram(page, diagramName);

  await page.getByTestId('save-diagram').click();
  await expect(page.getByTestId('save-status')).toHaveText('saved');

  await page.goto(`/?projectId=${PROJECT_ID}`);
  await expect(page.getByTestId('project-browser')).toBeVisible();
  const row = page.locator('li.row', { hasText: diagramName });
  await row.getByRole('button', { name: 'Open' }).click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();

  const highlighted = page.locator('[data-testid="node-A"] [fill="#ff00ff"]');
  await expect(highlighted).toHaveCount(1);
});
