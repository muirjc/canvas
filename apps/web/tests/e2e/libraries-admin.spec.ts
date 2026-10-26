import { expect, test, type Page } from '@playwright/test';
import { deleteCustomDiagramType } from './diagram-type-helpers';

const API_BASE_URL = process.env.VITE_API_BASE_URL ?? 'http://localhost:3000';
const PROJECT_ID = process.env.E2E_PROJECT_ID;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';
const ARCHITECT_EMAIL = 'architect@example.com';
const ARCHITECT_PASSWORD = 'architect-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

async function signIn(page: Page, email: string, password: string, url: string) {
  await page.goto(url);
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(password);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('sign-out')).toBeVisible();
}

const svg = (fill: string, size = 24) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" rx="4" fill="${fill}"/></svg>`;

const unique = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

/** The resources a test creates, removed in afterAll even when an assertion failed part-way. */
const createdLibraries: { id: string; version: string }[] = [];
const createdTypeIds: string[] = [];
const createdDiagramIds: string[] = [];

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage();
  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD, '/');
  for (const id of createdDiagramIds) await page.request.delete(`${API_BASE_URL}/diagrams/${id}`);
  for (const lib of createdLibraries) await page.request.delete(`${API_BASE_URL}/admin/libraries/${lib.id}/${lib.version}`);
  for (const id of createdTypeIds) await deleteCustomDiagramType(page.request, id);
  await page.close();
});

async function createCustomType(page: Page): Promise<{ id: string; name: string }> {
  const name = `E2E Libraries Type ${unique()}`;
  const res = await page.request.post(`${API_BASE_URL}/admin/diagram-types`, {
    data: { name, dslFamily: 'flowchart', personas: ['Business', 'Enterprise', 'Solution', 'Technical'] },
  });
  expect(res.status()).toBe(201);
  const id = (await res.json()).diagramType.id as string;
  createdTypeIds.push(id);
  return { id, name };
}

async function importLibraryViaApi(page: Page, name: string, icons: { fileName: string; svg: string }[]) {
  const res = await page.request.post(`${API_BASE_URL}/admin/libraries/import-svg`, { data: { name, icons } });
  expect(res.status()).toBe(201);
  const library = (await res.json()).library as { id: string; version: string };
  createdLibraries.push({ id: library.id, version: library.version });
  return library;
}

async function createDiagramUsingIcon(page: Page, lib: { id: string; version: string }, iconId: string): Promise<{ id: string; name: string }> {
  const name = `E2E Library Usage ${unique()}`;
  const dsl = `---\ncanvas:\n  icons:\n    A:\n      libraryId: ${lib.id}\n      libraryVersion: '${lib.version}'\n      iconId: ${iconId}\n---\nflowchart TD\n  A[Thing]\n`;
  const res = await page.request.post(`${API_BASE_URL}/projects/${PROJECT_ID}/diagrams`, {
    data: { name, diagramTypeId: 'flowchart', initialDslContent: dsl },
  });
  expect(res.status()).toBe(201);
  const id = (await res.json()).diagram.id as string;
  createdDiagramIds.push(id);
  return { id, name };
}

async function searchPalette(page: Page, diagramTypeId: string, query = ''): Promise<string[]> {
  const res = await page.request.get(`${API_BASE_URL}/icons/search?diagramTypeId=${encodeURIComponent(diagramTypeId)}&query=${encodeURIComponent(query)}`);
  expect(res.ok()).toBe(true);
  return ((await res.json()).icons as { id: string }[]).map((i) => i.id);
}

async function openLibrary(page: Page, name: string) {
  await page.goto('/?admin=libraries');
  const row = page.locator('tr', { hasText: name });
  await row.getByRole('button', { name: `Open ${name}` }).click();
  await expect(page.getByTestId('library-detail')).toBeVisible();
}

test('admin imports SVG icons into a custom library, assigns it to a palette, retires an icon and deletes the library', async ({ page }) => {
  const libraryName = `E2E Icons ${Date.now()}`;
  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD, '/?admin=overview');
  // A custom type of our own: assigning a palette to a BUILT-IN type would mark it admin-edited
  // in the developer's database for good.
  const type = await createCustomType(page);

  // The Overview card opens the page.
  await page.getByTestId('overview-card-libraries').click();
  await expect(page).toHaveURL(/admin=libraries/);
  await expect(page.getByRole('heading', { level: 1, name: 'Libraries' })).toBeVisible();
  await expect(page).toHaveTitle('Libraries – Admin – Canvas');
  await expect(page.getByTestId('libraries-page')).toBeVisible();
  await expect(page.getByTestId('library-row-aws-icons@2024.1')).toBeVisible();
  await expect(page.getByTestId('library-origin-aws-icons@2024.1')).toHaveText('Built-in');
  await expect(page.getByTestId('library-delete-aws-icons@2024.1')).toHaveCount(0);

  // Import two generated SVGs; the dialog previews both before anything is saved, and flags a bad file.
  await page.getByTestId('libraries-import').click();
  await expect(page.getByTestId('library-import-dialog')).toBeVisible();
  await page.getByTestId('library-import-name').fill(libraryName);
  await page.getByTestId('library-import-files').setInputFiles([
    { name: 'red-box.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(svg('#d33')) },
    { name: 'blue-box.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(svg('#36c', 100)) },
    { name: 'notes.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('this is not an svg') },
  ]);
  await expect(page.getByTestId('library-import-preview-0').locator('img')).toBeVisible();
  await expect(page.getByTestId('library-import-preview-1').locator('img')).toBeVisible();
  await expect(page.getByTestId('library-import-error-2')).toBeVisible();
  await expect(page.getByTestId('library-import-summary')).toContainText('2 of 3');
  await page.getByTestId('library-import-save').click();

  // Saving opens the new library's detail with both icons.
  const detail = page.getByTestId('library-detail');
  await expect(detail).toBeVisible();
  await expect(detail.getByRole('heading', { level: 1, name: libraryName })).toBeVisible();
  await expect(page.getByTestId('library-icon-red-box')).toBeVisible();
  await expect(page.getByTestId('library-icon-blue-box')).toBeVisible();
  await expect(page.getByTestId('library-icon-grid').locator('li')).toHaveCount(2);

  // Offer it in the custom type's palette.
  await page.getByTestId(`library-palette-${type.id}`).check();
  await page.getByTestId('library-palette-save').click();
  await expect(page.getByTestId('library-palette-message')).toHaveText('Palette saved.');
  // Hold on to the library so a failed assertion below still cleans it up.
  await page.getByTestId('library-back').click();
  const row = page.locator('tr', { hasText: libraryName });
  const testId = (await row.getAttribute('data-testid'))!;
  const rowKey = testId.replace('library-row-', '');
  const [libId, libVersion] = rowKey.split('@');
  createdLibraries.push({ id: libId, version: libVersion });

  // End to end: the icons now come back from the palette search for that diagram type...
  await expect.poll(() => searchPalette(page, type.id)).toEqual(expect.arrayContaining(['red-box', 'blue-box']));
  expect(await searchPalette(page, type.id, 'blue')).toEqual(['blue-box']);
  // ...and not for the built-in flowchart type.
  expect(await searchPalette(page, 'flowchart')).not.toContain('red-box');

  await row.getByRole('button', { name: `Open ${libraryName}` }).click();
  await expect(page.getByTestId('library-detail')).toBeVisible();

  // Search narrows the grid.
  await page.getByTestId('library-search').fill('blue');
  await expect(page.getByTestId('library-icon-red-box')).toHaveCount(0);
  await page.getByTestId('library-search').fill('');

  // Retiring hides the icon until "Show retired" -- and takes it out of the palette.
  await page.getByTestId('library-icon-retire-red-box').click();
  await expect(page.getByTestId('library-icon-red-box')).toHaveCount(0);
  await expect.poll(() => searchPalette(page, type.id)).toEqual(['blue-box']);
  await page.getByTestId('library-show-retired').check();
  await expect(page.getByTestId('library-icon-red-box')).toBeVisible();
  await expect(page.getByTestId('library-icon-retired-red-box')).toBeVisible();

  // Back on the list the library shows its counts and palette type.
  await page.getByTestId('library-back').click();
  const listRow = page.locator('tr', { hasText: libraryName });
  await expect(listRow).toContainText('2');
  await expect(listRow).toContainText('1 retired');
  await expect(listRow).toContainText(type.name);

  // Clean up: an unused custom library can be deleted.
  await page.getByTestId(`library-delete-${rowKey}`).click();
  await page.getByTestId('library-delete-confirm-button').click();
  await expect(page.getByTestId(testId)).toHaveCount(0);

  // Its palette entries went with it.
  expect(await searchPalette(page, type.id)).toEqual([]);
});

test('admin imports a library from a manifest, rejects bad manifests, adds icons and edits an icon', async ({ page }) => {
  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD, '/?admin=libraries');
  const id = `e2e-manifest-${unique()}`;
  createdLibraries.push({ id, version: '1' });
  const manifest = {
    id,
    version: '1',
    icons: [
      { id: 'gear', displayName: 'Gear', category: 'Tools', keywords: ['cog'], assetRef: '<g><rect x="4" y="4" width="40" height="40" fill="#c33"/></g>' },
      { id: 'bolt', displayName: 'Bolt', category: 'Tools', keywords: [], assetRef: '<g><rect x="10" y="10" width="28" height="28" fill="#33c"/></g>' },
    ],
  };
  const asFile = (name: string, content: string) => ({ name, mimeType: 'application/json', buffer: Buffer.from(content) });

  await page.getByTestId('libraries-import').click();
  await page.getByTestId('library-import-mode-manifest').click();
  const fileInput = page.getByTestId('library-import-manifest-file');

  // Not JSON, then JSON without icons: each is explained before anything is sent.
  await fileInput.setInputFiles(asFile('broken.json', '{ nope'));
  await expect(page.getByTestId('library-import-manifest-error')).toContainText("isn't valid JSON");
  await expect(page.getByTestId('library-import-save')).toBeDisabled();
  await fileInput.setInputFiles(asFile('empty.json', JSON.stringify({ id, version: '1', icons: [] })));
  await expect(page.getByTestId('library-import-manifest-error')).toContainText('no icons');
  await expect(page.getByTestId('library-import-save')).toBeDisabled();

  // Well-formed but the server refuses it (upper-case id): the server's reason is shown, nothing is created.
  await fileInput.setInputFiles(asFile('bad-id.json', JSON.stringify({ ...manifest, id: 'Bad Id' })));
  await expect(page.getByTestId('library-import-manifest-summary')).toContainText('2 icons');
  await page.getByTestId('library-import-save').click();
  await expect(page.getByTestId('library-import-error')).toContainText('lower-case');
  await expect(page.getByTestId('library-import-dialog')).toBeVisible();

  // The valid manifest imports and opens its detail.
  await fileInput.setInputFiles(asFile('good.json', JSON.stringify(manifest)));
  await expect(page.getByTestId('library-import-manifest-summary')).toContainText(`${id}@1 with 2 icons`);
  await page.getByTestId('library-import-name').fill('E2E Manifest Library');
  await page.getByTestId('library-import-save').click();
  await expect(page.getByTestId('library-detail').getByRole('heading', { level: 1, name: 'E2E Manifest Library' })).toBeVisible();
  await expect(page.getByTestId('library-icon-gear')).toContainText('Tools');
  await expect(page.getByTestId('library-icon-gear')).toContainText('cog');
  await expect(page.getByTestId('library-icon-grid').locator('li')).toHaveCount(2);

  // Importing the same id and version again is a conflict, not a silent overwrite.
  await page.getByTestId('library-back').click();
  await page.getByTestId('libraries-import').click();
  await page.getByTestId('library-import-mode-manifest').click();
  await page.getByTestId('library-import-manifest-file').setInputFiles(asFile('good.json', JSON.stringify(manifest)));
  await page.getByTestId('library-import-save').click();
  await expect(page.getByTestId('library-import-error')).toContainText('already exists');
  await page.getByTestId('library-import-cancel').click();

  // Add icons to the custom library.
  await openLibrary(page, 'E2E Manifest Library');
  await page.getByTestId('library-add-icons').click();
  await expect(page.getByTestId('library-add-dialog')).toBeVisible();
  await expect(page.getByTestId('library-add-save')).toBeDisabled();
  await page.getByTestId('library-add-files').setInputFiles([{ name: 'green-box.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(svg('#3a3')) }]);
  await expect(page.getByTestId('library-import-preview-0').locator('img')).toBeVisible();
  await page.getByTestId('library-add-save').click();
  await expect(page.getByTestId('library-add-dialog')).toHaveCount(0);
  await expect(page.getByTestId('library-icon-green-box')).toBeVisible();
  await expect(page.getByTestId('library-icon-grid').locator('li')).toHaveCount(3);

  // Edit an icon: rename, recategorise, new keywords and new artwork.
  const art = page.getByTestId('library-icon-gear').locator('img');
  const artBefore = await art.getAttribute('src');
  await page.getByTestId('library-icon-edit-gear').click();
  const dialog = page.getByTestId('library-icon-edit-dialog');
  await expect(page.getByTestId('library-icon-edit-name')).toHaveValue('Gear');
  await page.getByTestId('library-icon-edit-name').fill('Cog Wheel');
  await page.getByTestId('library-icon-edit-category').fill('Machinery');
  await page.getByTestId('library-icon-edit-keywords').fill('machine, teeth');
  await page.getByTestId('library-icon-edit-file').setInputFiles({ name: 'new.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(svg('#0a0', 60)) });
  await expect(dialog.getByAltText('Preview of the new artwork')).toBeVisible();
  await page.getByTestId('library-icon-edit-save').click();
  await expect(dialog).toHaveCount(0);
  const tile = page.getByTestId('library-icon-gear');
  await expect(tile).toContainText('Cog Wheel');
  await expect(tile).toContainText('Machinery');
  await expect(tile).toContainText('machine, teeth');
  await expect.poll(() => art.getAttribute('src')).not.toBe(artBefore);

  // An unusable replacement file blocks saving and says why.
  await page.getByTestId('library-icon-edit-gear').click();
  await page.getByTestId('library-icon-edit-file').setInputFiles({ name: 'bad.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('not an svg') });
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(page.getByTestId('library-icon-edit-save')).toBeDisabled();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);

  // Remove an unused icon.
  await page.getByTestId('library-icon-delete-green-box').click();
  await page.getByTestId('library-icon-delete-confirm-button').click();
  await expect(page.getByTestId('library-icon-green-box')).toHaveCount(0);
  await expect(page.getByTestId('library-icon-grid').locator('li')).toHaveCount(2);
});

test('an icon or library that a diagram uses cannot be deleted, and the blocking diagrams are listed', async ({ page }) => {
  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD, '/?admin=libraries');
  const name = `E2E In Use ${unique()}`;
  const lib = await importLibraryViaApi(page, name, [
    { fileName: 'used.svg', svg: svg('#d33') },
    { fileName: 'spare.svg', svg: svg('#36c') },
  ]);
  const diagram = await createDiagramUsingIcon(page, lib, 'used');

  await openLibrary(page, name);
  await expect(page.getByTestId('library-icon-used-used')).toHaveText('Used by 1 diagram');
  await expect(page.getByTestId('library-icon-used-spare')).toHaveText('Not used');

  // Deleting the icon in use names the diagram, which links to it.
  await page.getByTestId('library-icon-delete-used').click();
  await page.getByTestId('library-icon-delete-confirm-button').click();
  const iconError = page.getByTestId('library-icon-delete-error');
  await expect(iconError).toContainText('1 diagram uses this icon');
  const iconLink = iconError.getByTestId('library-in-use-diagrams').getByRole('link', { name: diagram.name });
  await expect(iconLink).toHaveAttribute('href', `?projectId=${PROJECT_ID}&diagramId=${diagram.id}`);
  // The link really opens that diagram.
  await iconLink.click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
  await openLibrary(page, name);
  await expect(page.getByTestId('library-icon-used')).toBeVisible();

  // The unused icon is not blocked.
  await page.getByTestId('library-icon-delete-spare').click();
  await page.getByTestId('library-icon-delete-confirm-button').click();
  await expect(page.getByTestId('library-icon-spare')).toHaveCount(0);

  // Deleting the whole library is blocked the same way.
  await page.getByTestId('library-back').click();
  const key = `${lib.id}@${lib.version}`;
  await expect(page.getByTestId(`library-used-${key}`)).toHaveText('Used by 1 diagram');
  await page.getByTestId(`library-delete-${key}`).click();
  await page.getByTestId('library-delete-confirm-button').click();
  const libError = page.getByTestId('library-delete-error');
  await expect(libError).toContainText('1 diagram uses this library');
  await expect(libError.getByRole('link', { name: diagram.name })).toHaveAttribute('href', `?projectId=${PROJECT_ID}&diagramId=${diagram.id}`);
  await page.getByTestId('library-delete-cancel').click();
  await expect(page.getByTestId(`library-row-${key}`)).toBeVisible();

  // Once the diagram is deleted, nothing blocks the library any more.
  const del = await page.request.delete(`${API_BASE_URL}/diagrams/${diagram.id}`);
  expect(del.ok()).toBe(true);
  await page.reload();
  await expect(page.getByTestId(`library-used-${key}`)).toHaveText('No diagrams');
  await page.getByTestId(`library-delete-${key}`).click();
  await page.getByTestId('library-delete-confirm-button').click();
  await expect(page.getByTestId(`library-row-${key}`)).toHaveCount(0);
});

test('a non-admin cannot reach the libraries page', async ({ page }) => {
  await signIn(page, ARCHITECT_EMAIL, ARCHITECT_PASSWORD, `/?projectId=${PROJECT_ID}&admin=libraries`);
  await expect(page.getByTestId('libraries-page')).toHaveCount(0);
  await expect(page.getByTestId('admin-shell')).toHaveCount(0);
  await expect(page.getByTestId('new-diagram')).toBeVisible();
});
