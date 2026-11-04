import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { expectSignedIn } from './auth-helpers';

const API_BASE_URL = process.env.VITE_API_BASE_URL ?? 'http://localhost:3000';

/**
 * canvas-2h2w.4: in-app notifications about access -- the header bell, its panel, and the "New" tag on
 * Shared with me. Serial: each step builds on the last. The recipient is a fresh user, so nothing else's
 * notifications are mixed in.
 */
test.describe.configure({ mode: 'serial', timeout: 90_000 });

const RUN = Date.now();
const PASSWORD = 'Granite-willow-saffron-64'; // gitleaks:allow
const MEMBER_NAME = `E2E Notified ${RUN}`;
const MEMBER_EMAIL = `e2e-user-${RUN}-notified@example.com`;
const PROJECT_NAME = `Notify project ${RUN}`;
const DIAGRAM_NAME = `Notify diagram ${RUN}`;

let adminCtx: BrowserContext;
let admin: Page;
let memberCtx: BrowserContext;
let member: Page;
let projectId = '';
let diagramId = '';
let memberId = '';

test.beforeAll(async ({ browser }) => {
  adminCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  admin = await adminCtx.newPage();
  await admin.goto('/');
  await admin.getByTestId('login-email').fill('admin@example.com');
  await admin.getByTestId('login-password').fill('admin-dev-password');
  await admin.getByTestId('login-submit').click();
  await expectSignedIn(admin);

  const user = await admin.request.post(`${API_BASE_URL}/admin/users`, { data: { email: MEMBER_EMAIL, name: MEMBER_NAME, role: 'architect' } });
  expect(user.status()).toBe(201);
  const body = await user.json();
  memberId = body.user.id;
  memberCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  expect((await memberCtx.request.post(`${API_BASE_URL}/auth/local/login`, { data: { email: MEMBER_EMAIL, password: body.temporaryPassword } })).status()).toBe(200);
  expect(
    (await memberCtx.request.post(`${API_BASE_URL}/auth/password`, { data: { currentPassword: body.temporaryPassword, newPassword: PASSWORD } })).status(),
  ).toBe(200);
  member = await memberCtx.newPage();

  projectId = (await (await admin.request.post(`${API_BASE_URL}/projects`, { data: { name: PROJECT_NAME } })).json()).project.id;
  // The diagram lives in a project the member isn't added to, so it is shared on its own.
  const otherProject = (await (await admin.request.post(`${API_BASE_URL}/projects`, { data: { name: `Notify other ${RUN}` } })).json()).project.id;
  diagramId = (
    await (
      await admin.request.post(`${API_BASE_URL}/projects/${otherProject}/diagrams`, {
        data: { name: DIAGRAM_NAME, diagramTypeId: 'flowchart', initialDslContent: 'flowchart TD\n  A[Start]\n' },
      })
    ).json()
  ).diagram.id;
});

test.afterAll(async () => {
  await memberCtx?.close();
  await adminCtx?.close();
});

test('a person added to a project and given a diagram sees the bell count and both sentences', async () => {
  expect((await admin.request.post(`${API_BASE_URL}/projects/${projectId}/shares`, { data: { granteeUserId: memberId, accessLevel: 'edit' } })).status()).toBeLessThan(300);
  expect((await admin.request.post(`${API_BASE_URL}/diagrams/${diagramId}/shares`, { data: { granteeUserId: memberId, accessLevel: 'comment' } })).status()).toBeLessThan(300);

  await member.goto('/');
  await expect(member.getByTestId('notifications-unread-count')).toHaveText('2');
  await expect(member.getByTestId('notifications-button')).toHaveAccessibleName('Notifications, 2 unread');

  await member.getByTestId('notifications-button').click();
  await expect(member.getByTestId('notifications-panel')).toBeVisible();
  const items = member.getByTestId('notification-item');
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText(`shared ${DIAGRAM_NAME} with you (Comment).`);
  await expect(items.nth(1)).toContainText(`added you to ${PROJECT_NAME} (Edit).`);
  await expect(items.nth(0)).toHaveAttribute('data-read', 'false');

  // Escape closes it.
  await member.keyboard.press('Escape');
  await expect(member.getByTestId('notifications-panel')).toHaveCount(0);
});

test('Shared with me marks the diagram New, and opening it marks it read', async () => {
  await member.getByTestId('nav-projects').click();
  await expect(member.getByTestId(`shared-new-${diagramId}`)).toBeVisible();
  await member.getByTestId(`open-shared-diagram-${diagramId}`).click();
  await expect(member).toHaveURL(new RegExp(`diagramId=${diagramId}`));
  await expect(member.getByTestId('notifications-unread-count')).toHaveText('1');
});

test('clicking a notification opens the project and marks it read', async () => {
  await member.getByTestId('notifications-button').click();
  await member.getByTestId('notification-item').filter({ hasText: PROJECT_NAME }).getByRole('link').click();
  await expect(member).toHaveURL(new RegExp(`projectId=${projectId}`));
  await expect(member.getByTestId('notifications-panel')).toHaveCount(0);
  await expect(member.getByTestId('notifications-unread-count')).toHaveCount(0);
});

test('Mark all as read clears the count, and a removal has nothing to open', async () => {
  expect((await admin.request.post(`${API_BASE_URL}/projects/${projectId}/shares`, { data: { granteeUserId: memberId, accessLevel: 'comment' } })).status()).toBeLessThan(300);
  await member.reload();
  await expect(member.getByTestId('notifications-unread-count')).toHaveText('1');
  await member.getByTestId('notifications-button').click();
  await expect(member.getByTestId('notification-item').first()).toContainText(`changed your access to ${PROJECT_NAME} from Edit to Comment.`);
  await member.getByTestId('notifications-mark-all-read').click();
  await expect(member.getByTestId('notifications-unread-count')).toHaveCount(0);
  await expect(member.getByTestId('notifications-mark-all-read')).toHaveCount(0);
  await expect(member.getByTestId('notification-item').first()).toHaveAttribute('data-read', 'true');
});
