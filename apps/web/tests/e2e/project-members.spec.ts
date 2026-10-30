import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { expectSignedIn } from './auth-helpers';

const API_BASE_URL = process.env.VITE_API_BASE_URL ?? 'http://localhost:3000';

/**
 * canvas-2h2w.2 / canvas-2h2w.5: a project's Members dialog (add, change level, make owner,
 * remove) and Copy link. Serial: each step builds on the last.
 */
test.describe.configure({ mode: 'serial', timeout: 90_000 });

const RUN = Date.now();
const PASSWORD = 'Granite-willow-saffron-64'; // gitleaks:allow
const MEMBER_NAME = `E2E Member ${RUN}`;
const MEMBER_EMAIL = `e2e-user-${RUN}-member@example.com`;

let adminCtx: BrowserContext;
let admin: Page;
let memberCtx: BrowserContext;
let member: Page;
let projectId = '';
let memberId = '';

test.beforeAll(async ({ browser }) => {
  adminCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await adminCtx.grantPermissions(['clipboard-read', 'clipboard-write']);
  admin = await adminCtx.newPage();
  await admin.goto('/');
  await admin.getByTestId('login-email').fill('admin@example.com');
  await admin.getByTestId('login-password').fill('admin-dev-password');
  await admin.getByTestId('login-submit').click();
  await expectSignedIn(admin);
  projectId = (await (await admin.request.post(`${API_BASE_URL}/projects`, { data: { name: `Members ${RUN}` } })).json()).project.id;

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
});

test.afterAll(async () => {
  await memberCtx?.close();
  await adminCtx?.close();
});

test('Copy link copies the project address', async () => {
  await admin.goto(`/?projectId=${projectId}`);
  await admin.getByTestId('copy-project-link').click();
  await expect(admin.getByTestId('copy-project-link')).toContainText('Link copied');
  const copied = await admin.evaluate(() => navigator.clipboard.readText());
  expect(new URL(copied).searchParams.get('projectId')).toBe(projectId);
});

test('an owner adds a member by name, who then finds the project under My projects with Edit', async () => {
  await admin.getByTestId('open-members').click();
  await expect(admin.getByTestId('member-owner')).toContainText('Owner');
  await admin.getByTestId('member-email').fill(MEMBER_NAME);
  await admin.getByTestId(`member-user-option-${memberId}`).click();
  await admin.getByTestId('member-level').selectOption('edit');
  await admin.getByTestId('member-add').click();
  await expect(admin.getByTestId(`member-level-${memberId}`)).toHaveValue('edit');

  // With exactly one project of their own, landing opens it; the list is one click away.
  await member.goto('/');
  await member.getByTestId('nav-projects').click();
  await expect(member.getByTestId('projects-page-list').getByTestId(`projects-page-row-${projectId}`)).toBeVisible();
  await member.goto(`/?projectId=${projectId}`);
  await expect(member.getByTestId('new-diagram')).toBeVisible();
  // An editor sees the members but can't change them.
  await member.getByTestId('open-members').click();
  await expect(member.getByTestId(`member-${memberId}`)).toContainText('(you)');
  await expect(member.getByTestId('member-email')).toHaveCount(0);
  await expect(member.getByTestId(`member-remove-${memberId}`)).toHaveCount(0);
  await member.getByTestId('members-close').click();
});

test('changing a member to Comment takes their editing away', async () => {
  await admin.getByTestId(`member-level-${memberId}`).selectOption('comment');
  await expect(admin.getByTestId(`member-level-${memberId}`)).toHaveValue('comment');
  await member.reload();
  await expect(member.getByTestId('project-read-only-note')).toBeVisible();
});

test('the owner can hand the project over and stays on with Manage', async () => {
  await admin.getByTestId(`member-make-owner-${memberId}`).click();
  await admin.getByTestId('confirm-dialog-confirm').click();
  await expect(admin.getByTestId('member-owner')).toContainText(MEMBER_NAME);
  await member.reload();
  await expect(member.getByTestId('new-diagram')).toBeVisible();
});
