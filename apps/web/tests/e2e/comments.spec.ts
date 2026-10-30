import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { expectSignedIn } from './auth-helpers';
import { saveDsl } from './save-helpers';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const API_BASE_URL = process.env.VITE_API_BASE_URL ?? 'http://localhost:3000';
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * canvas-bw4: comments on a diagram -- general and pinned threads, replies, resolve/reopen, the
 * unread badge, who may edit/delete, the read-only view, and a pin whose shape was removed.
 * Serial: each case builds on the threads the earlier ones created.
 */
test.describe.configure({ mode: 'serial', timeout: 90_000 });

const RUN = Date.now();
const PASSWORD = 'Zebra-lantern-quartz-42'; // gitleaks:allow
const DSL = 'flowchart TD\n  a[Alpha] --> b[Beta]\n';
const GENERAL = `General note ${RUN}`;
const PINNED = `Pinned to Alpha ${RUN}`;
const REPLY = `Reply from commenter ${RUN}`;
const EDITED = `Reply edited ${RUN}`;

let adminCtx: BrowserContext;
let admin: Page;
let commenterCtx: BrowserContext;
let commenter: Page;
let viewerCtx: BrowserContext;
let viewer: Page;
let diagramId = '';
let pinnedId = '';
let generalId = '';

async function member(browser: Browser, suffix: string, level: 'comment' | 'view') {
  const email = `e2e-user-${RUN}-${suffix}@example.com`;
  const created = await admin.request.post(`${API_BASE_URL}/admin/users`, { data: { email, name: `E2E ${suffix} ${RUN}`, role: 'architect' } });
  expect(created.status()).toBe(201);
  const body = await created.json();
  const share = await admin.request.post(`${API_BASE_URL}/diagrams/${diagramId}/shares`, { data: { granteeUserId: body.user.id, accessLevel: level } });
  expect(share.status()).toBe(201);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  expect((await ctx.request.post(`${API_BASE_URL}/auth/local/login`, { data: { email, password: body.temporaryPassword } })).status()).toBe(200);
  expect((await ctx.request.post(`${API_BASE_URL}/auth/password`, { data: { currentPassword: body.temporaryPassword, newPassword: PASSWORD } })).status()).toBe(200);
  return { ctx, page: await ctx.newPage(), id: body.user.id as string };
}

async function open(page: Page) {
  await page.goto(`/?diagramId=${diagramId}`);
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
  await expect(page.getByTestId('node-b')).toBeVisible();
}

async function openComments(page: Page) {
  await page.getByTestId('rail-tab-comments').click();
  await expect(page.getByTestId('comments-panel')).toBeVisible();
}

const thread = (page: Page, text: string) => page.locator('[data-testid^="comment-thread-"]:not([data-testid*="-el-"])', { hasText: text });
const idOf = async (locator: ReturnType<Page['locator']>, prefix: string) => ((await locator.first().getAttribute('data-testid')) ?? '').replace(prefix, '');

async function post(page: Page, text: string) {
  await page.getByTestId('comment-new').fill(text);
  await page.getByTestId('comment-new-submit').click();
  await expect(thread(page, text)).toHaveCount(1);
}

async function a11y(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
}

test.beforeAll(async ({ browser }) => {
  adminCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  admin = await adminCtx.newPage();
  await admin.goto('/');
  await admin.getByTestId('login-email').fill(ADMIN_EMAIL);
  await admin.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await admin.getByTestId('login-submit').click();
  await expectSignedIn(admin);

  const created = await admin.request.post(`${API_BASE_URL}/projects/${PROJECT_ID}/diagrams`, { data: { name: `Comments ${RUN}`, diagramTypeId: 'flowchart' } });
  expect(created.status()).toBe(201);
  diagramId = (await created.json()).diagram.id;
  expect((await saveDsl(admin.request, API_BASE_URL, diagramId, DSL)).status()).toBe(200);

  const c = await member(browser, 'commenter', 'comment');
  commenterCtx = c.ctx;
  commenter = c.page;
  const v = await member(browser, 'viewer', 'view');
  viewerCtx = v.ctx;
  viewer = v.page;
});

test.afterAll(async () => {
  await adminCtx?.close();
  await commenterCtx?.close();
  await viewerCtx?.close();
});

test('the owner posts a general comment and one pinned to a shape; the pin opens the thread', async () => {
  await open(admin);
  await openComments(admin);
  await expect(admin.getByTestId('comments-empty')).toBeVisible();

  await post(admin, GENERAL);
  generalId = await idOf(thread(admin, GENERAL), 'comment-thread-');
  await expect(admin.getByTestId('comment-pin-selected')).toBeDisabled();

  await admin.getByTestId('node-a').click();
  await expect(admin.getByTestId('comment-pin-selected')).toBeEnabled();
  await admin.getByTestId('comment-pin-selected').check();
  await post(admin, PINNED);
  pinnedId = await idOf(thread(admin, PINNED), 'comment-thread-');
  await expect(thread(admin, PINNED)).toContainText('On: Alpha');
  await expect(thread(admin, GENERAL)).not.toContainText('On:');
  await expect(admin.getByTestId('comment-pin-a')).toBeVisible();

  // Clicking the pin from another tab opens Comments and highlights the thread.
  await admin.getByTestId('rail-tab-dsl').click();
  await expect(admin.getByTestId('comments-panel')).toBeHidden();
  await admin.getByTestId('comment-pin-a').click();
  await expect(admin.getByTestId('comments-panel')).toBeVisible();
  await expect(admin.getByTestId(`comment-thread-${pinnedId}`)).toHaveClass(/comment-thread--highlight/);
});

test('the commenter sees the unread badge, which clears when the tab opens; replies and resolves', async () => {
  await open(commenter);
  await expect(commenter.getByTestId('comments-unread')).toHaveText('2');
  await openComments(commenter);
  await expect(commenter.getByTestId('comments-unread')).toHaveCount(0);
  await expect(thread(commenter, GENERAL)).toBeVisible();

  await commenter.getByTestId(`comment-reply-${pinnedId}`).click();
  await commenter.getByTestId(`comment-reply-input-${pinnedId}`).fill(REPLY);
  await commenter.getByTestId(`comment-reply-submit-${pinnedId}`).click();
  await expect(thread(commenter, PINNED)).toContainText(REPLY);

  // Resolving hides the thread behind "Show resolved (1)" and removes its pin.
  await expect(commenter.getByTestId('comment-pin-a')).toBeVisible();
  await commenter.getByTestId(`comment-resolve-${pinnedId}`).click();
  await expect(thread(commenter, PINNED)).toHaveCount(0);
  await expect(commenter.locator('label[for="comments-show-resolved"]')).toContainText('(1)');
  await expect(commenter.getByTestId('comment-pin-a')).toHaveCount(0);

  await commenter.getByTestId('comments-show-resolved').check();
  await expect(thread(commenter, PINNED)).toBeVisible();
  await expect(thread(commenter, PINNED)).toContainText('Resolved');
  await commenter.getByTestId(`comment-reopen-${pinnedId}`).click();
  await expect(thread(commenter, PINNED)).toBeVisible();
  await expect(commenter.getByTestId('comment-pin-a')).toBeVisible();
});

test('authors edit their own comments; others delete only what they may', async () => {
  await open(commenter);
  await openComments(commenter);
  const reply = commenter.locator('[data-testid^="comment-"]', { hasText: REPLY }).filter({ has: commenter.locator('[data-testid^="comment-edit-"]') }).last();
  const replyId = ((await reply.getAttribute('data-testid')) ?? '').replace('comment-', '');
  await commenter.getByTestId(`comment-edit-${replyId}`).click();
  await commenter.getByTestId(`comment-edit-input-${replyId}`).fill(EDITED);
  await commenter.getByTestId(`comment-edit-save-${replyId}`).click();
  await expect(thread(commenter, PINNED)).toContainText(EDITED);
  await expect(thread(commenter, PINNED)).toContainText('Edited');

  // No edit or delete on the admin's comments.
  const generalThread = thread(commenter, GENERAL);
  await expect(generalThread.locator('[data-testid^="comment-edit-"]')).toHaveCount(0);
  await expect(generalThread.locator('[data-testid^="comment-delete-"]')).toHaveCount(0);

  // The owner can delete the commenter's reply.
  await open(admin);
  await openComments(admin);
  await admin.getByTestId(`comment-delete-${replyId}`).click();
  await admin.getByTestId('confirm-dialog-confirm').click();
  await expect(thread(admin, PINNED)).toContainText('Comment deleted');
  await expect(thread(admin, PINNED)).not.toContainText(EDITED);
});

test('a view-only user reads threads but cannot comment', async () => {
  await open(viewer);
  await openComments(viewer);
  await expect(thread(viewer, GENERAL)).toBeVisible();
  await expect(thread(viewer, PINNED)).toBeVisible();
  await expect(viewer.getByTestId('comments-readonly')).toBeVisible();
  await expect(viewer.getByTestId('comment-new')).toHaveCount(0);
  await expect(viewer.getByTestId('comment-new-submit')).toHaveCount(0);
  await expect(viewer.locator('[data-testid^="comment-reply-"]')).toHaveCount(0);
  await expect(viewer.locator('[data-testid^="comment-resolve-"]')).toHaveCount(0);
});

test('the panel with threads and a composer passes axe', async () => {
  await open(admin);
  await openComments(admin);
  await expect(admin.getByTestId('comment-new')).toBeVisible();
  await a11y(admin);
});

test('removing the pinned shape leaves the thread reading "On a shape that was removed" with no pin', async () => {
  await open(admin);
  await admin.getByTestId('node-a').click();
  await admin.getByTestId('delete-selected').click();
  await admin.getByTestId('confirm-dialog-confirm').click();
  await expect(admin.getByTestId('node-a')).toHaveCount(0);
  await admin.getByTestId('save-diagram').click();
  await expect(admin.getByTestId('save-status')).toHaveAttribute('data-state', /saved|idle/);
  await openComments(admin);
  await expect(thread(admin, PINNED)).toContainText('On a shape that was removed');
  await expect(admin.getByTestId('comment-pin-a')).toHaveCount(0);
  await expect(thread(admin, GENERAL)).toBeVisible();
});

test('the comments panel is usable at 390px', async () => {
  await admin.setViewportSize({ width: 390, height: 844 });
  await open(admin);
  await openComments(admin);
  await expect(admin.getByTestId('comments-panel')).toBeVisible();
  const box = await admin.getByTestId('comments-panel').boundingBox();
  expect(box!.width).toBeLessThanOrEqual(390);
  const { scrollWidth, clientWidth } = await admin.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, 'page is wider than the viewport').toBeLessThanOrEqual(clientWidth);
  await admin.setViewportSize({ width: 1280, height: 900 });
});
