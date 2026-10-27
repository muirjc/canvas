import { expect, test } from '@playwright/test';
import { openStandardsAdmin } from './standards-admin-helpers';
import { ensureCustomDiagramType } from './diagram-type-helpers';
import { PROJECT_ID } from './standards-v2-helpers';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * canvas-syd: a C4 kind's role fixes which shapes it can be drawn as. The Shapes checkboxes only
 * offer what the role allows (plus anything already ticked), and a leftover shape is flagged and
 * blocks saving. Uses a throwaway custom C4 type and an unsaved draft, so no built-in standard changes.
 */
const TYPE_NAME = 'E2E C4 role shapes';
const SYSTEM_SHAPES = ['rectangle', 'cylinder', 'stadium'];
const ALL_SHAPES_TO_CHECK = ['rectangle', 'rounded-rectangle', 'cylinder', 'stadium', 'person'];

test('c4 kind: shapes follow the role; a leftover shape is flagged until unticked', async ({ page }) => {
  await openStandardsAdmin(page);
  const typeId = await ensureCustomDiagramType(page.request, { name: TYPE_NAME, dslFamily: 'c4' });
  await page.reload();
  await page.getByTestId(`standards-type-${typeId}`).click();

  await page.getByTestId('standard-new').click();
  await page.getByTestId('standard-name-input').fill('Role shapes');
  await page.getByTestId('kind-add').click();
  await page.getByTestId('kind-label-0').fill('Person');

  const shape = (s: string) => page.getByTestId(`kind-shape-0-${s}`);
  const expectOffered = async (offered: string[]) => {
    for (const s of ALL_SHAPES_TO_CHECK) await expect(shape(s)).toHaveCount(offered.includes(s) ? 1 : 0);
  };

  // Person role offers only person.
  await page.getByTestId('kind-role-0').selectOption('person');
  await expectOffered(['person']);
  await shape('person').check();
  await expect(page.getByTestId('error-elementKinds[0].shapes')).toHaveCount(0);
  await expect(page.getByTestId('standard-save')).toBeEnabled();

  // Switching to system offers system shapes, keeps the ticked person, and flags it.
  await page.getByTestId('kind-role-0').selectOption('system');
  await expectOffered([...SYSTEM_SHAPES, 'person']);
  await expect(shape('person')).toBeChecked();
  await expect(page.getByTestId('error-elementKinds[0].shapes')).toContainText(
    `A C4 system element can't be drawn as "person"; system elements use rectangle, cylinder, stadium.`,
  );
  await expect(page.getByTestId('standard-save')).toBeDisabled();

  // Unticking it clears the error, and person is no longer offered.
  // Not .uncheck(): the checkbox is removed from the DOM as soon as it is unticked.
  await shape('person').click();
  await expect(page.getByTestId('error-elementKinds[0].shapes')).toHaveCount(0);
  await expectOffered(SYSTEM_SHAPES);
  await expect(page.getByTestId('standard-save')).toBeEnabled();
});
