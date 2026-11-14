import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { expectSignedIn } from './auth-helpers';
import { saveDsl } from './save-helpers';

const API_BASE_URL = process.env.VITE_API_BASE_URL ?? 'http://localhost:3000';

/**
 * canvas-8uh1.6: frames -- a diagram can show other diagrams in frames. Embed through the picker, see the inner
 * drawing and title, save and reload; Open goes to the inner diagram; a frame of a diagram in the bin says so;
 * dragging moves the frame (saved in the front matter); the Links tab lists the frames and removes one.
 */
test.describe.configure({ mode: 'serial', timeout: 120_000 });

const RUN = Date.now();
const OUTER_NAME = `Outer ${RUN}`;
const INNER_NAME = `Inner ${RUN}`;

let adminCtx: BrowserContext;
let admin: Page;
let projectId = '';
let outerId = '';
let innerId = '';

async function createDiagram(name: string, dsl: string): Promise<string> {
  const created = await admin.request.post(`${API_BASE_URL}/projects/${projectId}/diagrams`, { data: { name, diagramTypeId: 'flowchart' } });
  expect(created.status()).toBe(201);
  const id = (await created.json()).diagram.id as string;
  expect((await saveDsl(admin.request, API_BASE_URL, id, dsl)).status()).toBe(200);
  return id;
}

async function open(page: Page, diagramId: string): Promise<void> {
  await page.goto(`/?diagramId=${diagramId}`);
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
}

async function save(page: Page): Promise<void> {
  await page.getByTestId('save-diagram').click();
  await expect(page.getByTestId('save-status')).toHaveText('Saved');
}

async function savedDsl(id: string): Promise<string> {
  return (await (await admin.request.get(`${API_BASE_URL}/diagrams/${id}`)).json()).diagram.dslContent as string;
}

/** The first frame's saved x and y, read from the front matter. */
function framePosition(dsl: string): { x: number; y: number } {
  const match = dsl.match(/frames:[\s\S]*?\bx: (-?\d+)\s+y: (-?\d+)/);
  expect(match, `frames in front matter of:\n${dsl}`).not.toBeNull();
  return { x: Number(match![1]), y: Number(match![2]) };
}

const frames = (page: Page) => page.locator('[data-testid^="diagram-frame-"]');

test.beforeAll(async ({ browser }) => {
  adminCtx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  admin = await adminCtx.newPage();
  await admin.goto('/');
  await admin.getByTestId('login-email').fill('admin@example.com');
  await admin.getByTestId('login-password').fill('admin-dev-password');
  await admin.getByTestId('login-submit').click();
  await expectSignedIn(admin);

  projectId = (await (await admin.request.post(`${API_BASE_URL}/projects`, { data: { name: `Frames ${RUN}` } })).json()).project.id;
  innerId = await createDiagram(INNER_NAME, 'graph TD\n  X[Inner box] --> Y[Other box]\n');
  outerId = await createDiagram(OUTER_NAME, 'graph TD\n  A[Alpha] --> B[Beta]\n');
});

test.afterAll(async () => {
  await adminCtx?.close();
});

test('embed a saved diagram through the picker, see its drawing and title, save, reload and still see it', async () => {
  await open(admin, outerId);
  await expect(frames(admin)).toHaveCount(0);
  await admin.getByTestId('embed-diagram').click();

  await expect(admin.getByTestId('link-picker')).toBeVisible();
  await expect(admin.getByTestId('link-picker')).toContainText('Embed a diagram');
  await expect(admin.getByTestId('link-picker-create')).toHaveText('Create and embed');
  await admin.getByTestId('link-picker-project').selectOption(projectId);
  await admin.getByTestId('link-picker-search').fill(INNER_NAME);
  // The diagram being edited is never offered.
  await expect(admin.getByTestId(`link-picker-result-${outerId}`)).toHaveCount(0);
  await admin.getByTestId(`link-picker-result-${innerId}`).click();
  await expect(admin.getByTestId('link-picker')).toBeHidden();

  const frame = frames(admin);
  await expect(frame).toHaveCount(1);
  await expect(frame).toHaveAttribute('data-status', 'available');
  await expect(frame).toContainText(INNER_NAME);
  await expect(frame.locator('image')).toHaveAttribute('href', /^data:image\/svg\+xml;base64,/);
  await save(admin);

  expect(await savedDsl(outerId)).toContain(innerId);

  await admin.reload();
  await expect(admin.getByTestId('diagram-canvas')).toBeVisible();
  await expect(frames(admin)).toHaveCount(1);
  await expect(frames(admin)).toHaveAttribute('data-status', 'available');
  await expect(frames(admin)).toContainText(INNER_NAME);
  await expect(frames(admin).locator('image')).toBeVisible();
  // The frame is drawn beside the shapes, which are still there.
  await expect(admin.getByTestId('node-A')).toBeVisible();
});

test('Open goes to the inner diagram', async () => {
  await open(admin, outerId);
  await expect(frames(admin)).toHaveAttribute('data-status', 'available');
  await frames(admin).locator('[data-testid^="frame-open-"]').click();
  await expect(admin).toHaveURL(new RegExp(`diagramId=${innerId}`));
  await expect(admin.getByTestId('node-X')).toBeVisible();
});

test('dragging a frame moves it, and the new place is saved', async () => {
  await open(admin, outerId);
  await expect(frames(admin)).toHaveAttribute('data-status', 'available');
  const before = framePosition(await savedDsl(outerId));

  // Select the frame by its header, then drag it.
  const box = (await frames(admin).locator('rect').first().boundingBox())!;
  const startX = box.x + 20;
  const startY = box.y + 10;
  await admin.mouse.move(startX, startY);
  await admin.mouse.down();
  await admin.mouse.move(startX + 60, startY + 90, { steps: 8 });
  await admin.mouse.up();
  await expect(admin.locator('[data-testid^="frame-resize-"]')).toBeVisible();
  const after = (await frames(admin).locator('rect').first().boundingBox())!;
  expect(Math.round(after.x - box.x)).toBeGreaterThan(40);
  expect(Math.round(after.y - box.y)).toBeGreaterThan(60);

  await save(admin);
  const moved = framePosition(await savedDsl(outerId));
  expect(moved.x).toBeGreaterThan(before.x + 40);
  expect(moved.y).toBeGreaterThan(before.y + 60);
});

test('a frame of a diagram in the bin says so and has no Open', async () => {
  const doomedId = await createDiagram(`Doomed ${RUN}`, 'graph TD\n  Z[Z]\n');
  const hostId = await createDiagram(`Host ${RUN}`, [
    '---',
    'canvas:',
    '  frames:',
    '    - id: frame1',
    `      diagramId: ${doomedId}`,
    '      x: 40',
    '      y: 40',
    '      width: 300',
    '      height: 200',
    '---',
    'graph TD',
    '  A[Alpha]',
    '',
  ].join('\n'));

  await open(admin, hostId);
  await expect(admin.getByTestId('diagram-frame-frame1')).toHaveAttribute('data-status', 'available');

  expect((await admin.request.delete(`${API_BASE_URL}/diagrams/${doomedId}`)).status()).toBe(204);
  await open(admin, hostId);
  await expect(admin.getByTestId('diagram-frame-frame1')).toHaveAttribute('data-status', 'deleted');
  await expect(admin.getByTestId('frame-placeholder-frame1')).toHaveText('Deleted (in the bin)');
  await expect(admin.getByTestId('frame-open-frame1')).toHaveCount(0);
  await expect(admin.getByTestId('diagram-frame-frame1').locator('image')).toHaveCount(0);

  await admin.getByTestId('rail-tab-links').click();
  await expect(admin.getByTestId('frame-row-frame1')).toHaveAttribute('data-status', 'deleted');
  await expect(admin.getByTestId('frame-row-frame1')).toContainText('Deleted (in the bin)');
  await expect(admin.getByTestId('frame-row-open-frame1')).toHaveCount(0);
});

test('the Links tab lists the frame and removes it', async () => {
  await open(admin, outerId);
  await admin.getByTestId('rail-tab-links').click();
  const row = admin.locator('[data-testid^="frame-row-"][data-status]');
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute('data-status', 'available');
  await expect(row).toContainText(INNER_NAME);

  await row.locator('[data-testid^="frame-row-remove-"]').click();
  await expect(frames(admin)).toHaveCount(0);
  await expect(row).toHaveCount(0);
  await expect(admin.getByTestId('node-A')).toBeVisible();
  await save(admin);
  expect(await savedDsl(outerId)).not.toContain('frames:');
  await admin.reload();
  await expect(admin.getByTestId('diagram-canvas')).toBeVisible();
  await expect(frames(admin)).toHaveCount(0);
});

test('Delete removes a selected frame', async () => {
  await open(admin, outerId);
  await admin.getByTestId('embed-diagram').click();
  await admin.getByTestId('link-picker-project').selectOption(projectId);
  await admin.getByTestId('link-picker-search').fill(INNER_NAME);
  await admin.getByTestId(`link-picker-result-${innerId}`).click();
  await expect(frames(admin)).toHaveCount(1);

  const box = (await frames(admin).locator('rect').first().boundingBox())!;
  await admin.mouse.click(box.x + 20, box.y + 10);
  await expect(admin.getByTestId('remove-frame')).toBeVisible();
  await admin.keyboard.press('Delete');
  await expect(frames(admin)).toHaveCount(0);
  await expect(admin.getByTestId('node-A')).toBeVisible();
});
