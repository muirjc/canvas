import { expect, test } from '@playwright/test';
import { ensureCustomDiagramType, hideCustomDiagramType } from './diagram-type-helpers';
import { API_BASE_URL, PROJECT_ID, addKind, login, newDiagram } from './standards-v2-helpers';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * canvas-8o01: "only one Component per diagram". Once a kind reaches its Max count, the Elements
 * button is disabled (its tooltip says why) and the kind picker won't turn another element into it.
 * Uses a fixed-name CUSTOM type, never a built-in one.
 */
test.describe.configure({ mode: 'serial' });

let typeId = '';
let standardId = '';
const diagramIds: string[] = [];

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  await login(page);
  typeId = await ensureCustomDiagramType(page.request, { name: 'E2E Max Count Flow', dslFamily: 'flowchart' });
  const res = await page.request.post(`${API_BASE_URL}/diagram-types/${typeId}/standards`, {
    data: {
      name: `Max count ${Date.now()}`,
      elementKinds: [
        { id: 'component', label: 'Component', shapes: ['rectangle'], approvedFills: ['#dbeafe'], maxCount: 1 },
        { id: 'consumer', label: 'Consumer', shapes: ['rounded-rectangle'], approvedFills: ['#fef3c7'] },
      ],
    },
  });
  expect(res.status()).toBe(201);
  standardId = (await res.json()).standard.id as string;
  expect((await page.request.post(`${API_BASE_URL}/standards/${standardId}/publish`)).status()).toBe(200);
  await page.close();
});

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage();
  await login(page);
  for (const id of diagramIds) await page.request.delete(`${API_BASE_URL}/diagrams/${id}`);
  if (standardId) await page.request.post(`${API_BASE_URL}/standards/${standardId}/retire`);
  await hideCustomDiagramType(page.request, typeId);
  await page.close();
});

test('a kind at its Max count cannot be added again, from the toolbar or the kind picker', async ({ page }) => {
  await login(page);
  const created = page.waitForResponse((r) => /\/projects\/[^/]+\/diagrams$/.test(r.url()) && r.request().method() === 'POST');
  await newDiagram(page, typeId);
  diagramIds.push((await (await created).json()).diagram.id as string);

  const addComponent = page.getByTestId('add-kind-component');
  await expect(addComponent).toBeEnabled();
  await addKind(page, 'component');

  // The one Component exists: the button is disabled and says why.
  await expect(addComponent).toBeDisabled();
  await expect(addComponent).toHaveAttribute('title', 'This diagram already has its 1 Component.');
  // Other kinds are unaffected.
  const consumerId = await addKind(page, 'consumer');

  // The picker on the Consumer lists Component but won't let it be chosen.
  await page.getByTestId(`node-${consumerId}`).hover();
  await page.getByTestId(`edit-kind-${consumerId}`).click();
  const option = page.getByTestId(`kind-role-select-${consumerId}`).locator('option[value="component"]');
  // Checked as an attribute: inside the SVG's foreignObject Playwright's toBeDisabled doesn't see it.
  await expect(option).toHaveAttribute('disabled', '');
  await expect(option).toHaveText('Component (limit reached)');
  await page.getByTestId(`kind-done-${consumerId}`).click();

  // Removing the Component frees the slot again.
  await page.locator('[data-testid^="node-"]').first().click();
  await page.getByTestId('canvas-root').focus();
  await page.keyboard.press('Delete');
  await page.getByTestId('confirm-dialog-confirm').click();
  await expect(addComponent).toBeEnabled();
});
