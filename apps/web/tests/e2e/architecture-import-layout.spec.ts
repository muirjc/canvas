import { expect, test, type Page } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * jmuir-dtu.26: a fresh `architecture-beta` import (no front-matter) used to place every
 * service/group from a flat grid, and groups got no size, so a group box never enclosed its
 * services. Confirms the fix in the real interactive canvas after the real import flow; the
 * parser-level cases live in diagram-core's architecture-import-layout contract test.
 */

type Box = { x: number; y: number; width: number; height: number };

async function login(page: Page) {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await page.waitForURL('**/*');
}

async function importDsl(page: Page, name: string, source: string) {
  await page.getByTestId('import-diagram-button').click();
  await page.getByTestId('import-name').fill(name);
  await page.getByTestId('import-textarea').fill(source);
  await page.getByTestId('confirm-import').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
}

/** A container's rendered box: its own background <rect>, in page coordinates. */
async function containerBox(page: Page, id: string): Promise<Box> {
  const rect = page.locator(`[data-testid="container-${id}"] rect`).first();
  await expect(rect).toBeVisible();
  return (await rect.boundingBox())!;
}

/** A node's rendered box: its shape element (not the whole <g>, which can include affordances). */
async function nodeBox(page: Page, id: string): Promise<Box> {
  const shape = page.locator(`[data-testid="node-${id}"]`).locator('rect, ellipse, circle, polygon, path, image').first();
  await expect(shape).toBeVisible();
  return (await shape.boundingBox())!;
}

function encloses(parent: Box, child: Box): boolean {
  return (
    child.x >= parent.x &&
    child.y >= parent.y &&
    child.x + child.width <= parent.x + parent.width &&
    child.y + child.height <= parent.y + parent.height
  );
}

const MERMAID_DOCS_DSL = [
  'architecture-beta',
  '    group api(cloud)[API]',
  '',
  '    service db(database)[Database] in api',
  '    service disk1(disk)[Storage] in api',
  '    service disk2(disk)[Storage] in api',
  '    service server(server)[Server] in api',
  '',
  '    db:L -- R:server',
  '    disk1:T -- B:server',
  '    disk2:T -- B:db',
  '',
].join('\n');

const NESTED_DSL = [
  'architecture-beta',
  '    group cloud(cloud)[Cloud]',
  '    group vpc(cloud)[VPC] in cloud',
  '',
  '    service web(server)[Web] in vpc',
  '    service store(database)[Store] in vpc',
  '',
  '    web:R -- L:store',
  '',
].join('\n');

test('an imported architecture-beta group encloses its services and honors edge anchors', async ({ page }) => {
  await login(page);
  await importDsl(page, `Arch Layout ${Date.now()}`, MERMAID_DOCS_DSL);

  const api = await containerBox(page, 'api');
  const db = await nodeBox(page, 'db');
  const disk1 = await nodeBox(page, 'disk1');
  const disk2 = await nodeBox(page, 'disk2');
  const server = await nodeBox(page, 'server');

  for (const service of [db, disk1, disk2, server]) {
    expect(encloses(api, service)).toBe(true);
  }

  // `db:L -- R:server` puts db's left to server's right, i.e. db sits right of server.
  expect(db.x).toBeGreaterThan(server.x);
  // `disk1:T -- B:server` puts disk1's top to server's bottom, i.e. disk1 sits below server.
  expect(disk1.y).toBeGreaterThan(server.y);
});

test('an imported architecture-beta nested group renders inside its parent group', async ({ page }) => {
  await login(page);
  await importDsl(page, `Arch Nested Layout ${Date.now()}`, NESTED_DSL);

  const cloud = await containerBox(page, 'cloud');
  const vpc = await containerBox(page, 'vpc');

  expect(encloses(cloud, vpc)).toBe(true);
  expect(encloses(vpc, await nodeBox(page, 'web'))).toBe(true);
  expect(encloses(vpc, await nodeBox(page, 'store'))).toBe(true);
});

/**
 * jmuir-dtu.27: Mermaid's five built-in architecture icon names used to resolve to a library with
 * no such icons, so imported services drew no artwork. They now resolve to the bundled
 * `mermaid-architecture` library; the canvas draws resolved icon markup as an <image> with a
 * data: URI (canvas-8n7), fetched asynchronously, hence the web-first assertions.
 */
test('imported architecture-beta built-in icons render artwork on the canvas', async ({ page }) => {
  await login(page);
  await importDsl(
    page,
    `Arch Builtin Icons ${Date.now()}`,
    [
      'architecture-beta',
      '    service c(cloud)[Cloud]',
      '    service db(database)[Database]',
      '    service d(disk)[Disk]',
      '    service net(internet)[Internet]',
      '    service srv(server)[Server]',
      '',
    ].join('\n'),
  );

  for (const id of ['c', 'db', 'd', 'net', 'srv']) {
    const artwork = page.locator(`[data-testid="node-${id}"] image`);
    await expect(artwork).toHaveCount(1);
    await expect(artwork).toHaveAttribute('href', /^data:image\/svg\+xml;base64,.+/);
  }
});
