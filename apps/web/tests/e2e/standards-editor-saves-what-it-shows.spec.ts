import { expect, test, type Page } from '@playwright/test';
import { openStandardsAdmin } from './standards-admin-helpers';
import { ensureCustomDiagramType } from './diagram-type-helpers';

/**
 * canvas-qxb: on Azure a C4 Context standard published from the editor came out with the Person
 * kind carrying External System's match. Both ways of changing a published standard -- revising it
 * (Edit) and cloning it -- must save exactly what the form shows, each change on its own kind.
 * Runs against a custom C4 type so no built-in standard is touched.
 */
const API_BASE_URL = process.env.VITE_API_BASE_URL ?? 'http://localhost:3000';
const C4_CONTEXT_KINDS = [
  { id: 'person', label: 'Person', shapes: ['person'], approvedFills: ['#08427b'], match: { role: 'person', external: false } },
  { id: 'external_person', label: 'External Person', shapes: ['person'], approvedFills: ['#686868'], match: { role: 'person', external: true } },
  { id: 'software_system', label: 'Software System', shapes: ['rectangle', 'cylinder', 'stadium'], approvedFills: ['#1168bd'], match: { role: 'system', external: false } },
  { id: 'external_system', label: 'External System', shapes: ['rectangle', 'cylinder', 'stadium'], approvedFills: ['#999999'], match: { role: 'system', external: true } },
];
const MATCHES = C4_CONTEXT_KINDS.map((k) => k.match);

type SavedKind = { id: string; match: { role: string; external: boolean }; requireConnection?: boolean };
async function activeStandard(page: Page, typeId: string) {
  const res = await page.request.get(`${API_BASE_URL}/diagram-types/${typeId}/standard`);
  expect(res.ok()).toBe(true);
  return (await res.json()).standard as { id: string; version: number; rules: { elementKinds: SavedKind[]; severityOverrides?: Record<string, string> } };
}

async function formMatches(page: Page) {
  return Promise.all(
    C4_CONTEXT_KINDS.map(async (_, i) => ({ role: await page.getByTestId(`kind-role-${i}`).inputValue(), external: await page.getByTestId(`kind-external-${i}`).isChecked() })),
  );
}

async function publish(page: Page) {
  await page.getByTestId('standard-publish').click();
  await page.getByTestId('standard-publish-confirm-button').click();
  await expect(page.getByTestId('standards-editor-message')).toContainText('Published');
}

test('revising and cloning a C4 standard save each kind exactly as the form shows it', async ({ page }) => {
  await openStandardsAdmin(page);
  const typeId = await ensureCustomDiagramType(page.request, { name: 'E2E C4 editor round-trip', dslFamily: 'c4' });
  // Start every run from the seeded C4 Context kinds.
  const created = await page.request.post(`${API_BASE_URL}/diagram-types/${typeId}/standards`, {
    data: { name: 'C4 round-trip', elementKinds: C4_CONTEXT_KINDS, connectorPolicy: 'any', requireKnownKinds: true },
  });
  expect(created.status()).toBe(201);
  expect((await page.request.post(`${API_BASE_URL}/standards/${(await created.json()).standard.id}/publish`)).ok()).toBe(true);

  await page.reload();
  await expect(page.getByTestId('standard-new')).toBeVisible();
  await page.getByTestId(`standards-type-${typeId}`).click();

  // Revise: tick Must be connected on every kind and raise kind-unconnected to Warning.
  await page.getByTestId('standard-view-active').click();
  await page.getByTestId('standard-view-edit').click();
  for (let i = 0; i < C4_CONTEXT_KINDS.length; i++) await page.getByTestId(`kind-connected-${i}`).check();
  await page.getByTestId('severity-kind-unconnected').selectOption('warning');
  expect(await formMatches(page)).toEqual(MATCHES);
  await publish(page);

  const revised = await activeStandard(page, typeId);
  expect(revised.rules.elementKinds.map((k) => k.match)).toEqual(MATCHES);
  expect(revised.rules.elementKinds.map((k) => k.requireConnection)).toEqual([true, true, true, true]);
  expect(revised.rules.severityOverrides).toEqual({ 'kind-unconnected': 'warning' });

  // Clone: the copy opens with the same kinds; a change to one kind lands on that kind only.
  await page.getByTestId(`standard-clone-${revised.id}`).click();
  await expect(page.getByTestId('kind-connected-0')).toBeVisible();
  expect(await formMatches(page)).toEqual(MATCHES);
  await page.getByTestId('kind-connected-0').uncheck();
  await publish(page);

  const cloned = await activeStandard(page, typeId);
  expect(cloned.version).toBeGreaterThan(revised.version);
  expect(cloned.rules.elementKinds.map((k) => k.match)).toEqual(MATCHES);
  expect(cloned.rules.elementKinds.map((k) => Boolean(k.requireConnection))).toEqual([false, true, true, true]);
});
