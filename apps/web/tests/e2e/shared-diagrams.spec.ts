import { expect, test, type Page } from '@playwright/test';

const API_BASE_URL = process.env.VITE_API_BASE_URL ?? 'http://localhost:3000';
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';
const GUEST_EMAIL = 'guest@example.com';
const GUEST_PASSWORD = 'guest-dev-password';

/**
 * Feature 008. Neither existing fixture user can represent this feature's own primary scenario —
 * a user with a diagram-level grant and NO project access at all. `admin` owns a project; the
 * seeded `architect` (project-visibility.spec.ts, sharing.spec.ts) is deliberately given a
 * permanent project-level grant by apps/api/src/seed/run.ts. `guest@example.com` is seeded
 * specifically for this suite with zero ownership and zero project-level grant (research.md §5),
 * so it must not be given either anywhere in this file.
 *
 * Tests here that only READ guest's state (nothing-shared cases) must run before any test that
 * shares a diagram with guest, since guest is a single persistent fixture account, not reset
 * between tests (workers: 1 makes this file's declaration order the actual run order).
 */

async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/');
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(password);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('sign-out')).toBeVisible();
}

async function createProject(page: Page, name: string): Promise<string> {
  const response = await page.request.post(`${API_BASE_URL}/projects`, { data: { name } });
  return (await response.json()).project.id;
}

async function createDiagram(page: Page, projectId: string, name: string): Promise<string> {
  const response = await page.request.post(`${API_BASE_URL}/projects/${projectId}/diagrams`, {
    data: { name, diagramTypeId: 'flowchart', initialDslContent: 'flowchart TD\n  A[Start]\n' },
  });
  return (await response.json()).diagram.id;
}

/**
 * Shares a diagram with the seeded guest account, acting as whoever `page` is signed in as.
 * Returns the grant id so callers can revoke it afterward (canvas-mt3) — `guest@example.com` is a
 * persistent fixture, not reset between tests, so a grant left behind here permanently changes
 * guest's state for every test that runs later (including this file's own first test, which
 * asserts guest has nothing shared).
 */
async function shareWithGuest(page: Page, diagramId: string, accessLevel: 'view' | 'comment' | 'edit'): Promise<string> {
  const lookup = await page.request.get(`${API_BASE_URL}/users/lookup?email=${encodeURIComponent(GUEST_EMAIL)}`);
  const { user } = await lookup.json();
  const response = await page.request.post(`${API_BASE_URL}/diagrams/${diagramId}/shares`, {
    data: { granteeUserId: user.id, accessLevel },
  });
  return (await response.json()).grant.id;
}

/** Mirrors accessibility.spec.ts's own finally-block cleanup for the same fixture (canvas-mt3). */
async function revokeGuestShare(page: Page, grantId: string): Promise<void> {
  await page.request.delete(`${API_BASE_URL}/shares/${grantId}`);
}

test('a user with nothing shared and no project access still sees the ordinary invitation', async ({ browser }) => {
  const guestContext = await browser.newContext();
  const guestPage = await guestContext.newPage();

  await signIn(guestPage, GUEST_EMAIL, GUEST_PASSWORD);
  await expect(guestPage.getByTestId('create-first-project')).toBeVisible();
  await expect(guestPage.getByTestId('shared-diagrams')).toHaveCount(0);

  await guestContext.close();
});

test('a user with a diagram-level grant and no project access finds and opens it', async ({ browser }) => {
  const adminContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  const guestPage = await guestContext.newPage();

  await signIn(adminPage, ADMIN_EMAIL, ADMIN_PASSWORD);
  const projectId = await createProject(adminPage, `Shared Access Source ${Date.now()}`);
  const diagramName = `Shared Diagram ${Date.now()}`;
  const diagramId = await createDiagram(adminPage, projectId, diagramName);
  const grantId = await shareWithGuest(adminPage, diagramId, 'view');

  try {
    await signIn(guestPage, GUEST_EMAIL, GUEST_PASSWORD);
    await expect(guestPage.getByTestId(`shared-diagram-${diagramId}`)).toBeVisible();
    await expect(guestPage.getByTestId(`shared-diagram-project-${diagramId}`)).toContainText('Shared Access Source');

    // Regression guard (feature 007's FR-013a, narrowed): the project name must be inert text, not
    // a disguised link — the natural instinct is wrong here, since every other project reference in
    // this codebase IS a real link.
    const projectNameElement = guestPage.getByTestId(`shared-diagram-project-${diagramId}`);
    await expect(projectNameElement).not.toHaveJSProperty('tagName', 'A');
    const urlBeforeClick = guestPage.url();
    await projectNameElement.click();
    await expect(guestPage).toHaveURL(urlBeforeClick);

    await guestPage.getByTestId(`open-shared-diagram-${diagramId}`).click();
    await expect(guestPage.getByTestId('diagram-canvas')).toBeVisible();
  } finally {
    await revokeGuestShare(adminPage, grantId);
    await adminContext.close();
    await guestContext.close();
  }
});

test('a shared-diagram row identifies who granted access', async ({ browser }) => {
  const adminContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  const guestPage = await guestContext.newPage();

  await signIn(adminPage, ADMIN_EMAIL, ADMIN_PASSWORD);
  const projectId = await createProject(adminPage, `Sharer Identity Source ${Date.now()}`);
  const diagramId = await createDiagram(adminPage, projectId, `Sharer Identity Diagram ${Date.now()}`);
  const grantId = await shareWithGuest(adminPage, diagramId, 'view');

  try {
    await signIn(guestPage, GUEST_EMAIL, GUEST_PASSWORD);
    await expect(guestPage.getByTestId(`shared-diagram-shared-by-${diagramId}`)).toContainText('Admin');
  } finally {
    await revokeGuestShare(adminPage, grantId);
    await adminContext.close();
    await guestContext.close();
  }
});

test('the open action on a shared-diagram row is reachable and operable by keyboard alone', async ({ browser }) => {
  const adminContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  const guestPage = await guestContext.newPage();

  await signIn(adminPage, ADMIN_EMAIL, ADMIN_PASSWORD);
  const projectId = await createProject(adminPage, `Keyboard Reach ${Date.now()}`);
  const diagramId = await createDiagram(adminPage, projectId, `Keyboard Reach Diagram ${Date.now()}`);
  const grantId = await shareWithGuest(adminPage, diagramId, 'view');

  try {
    await signIn(guestPage, GUEST_EMAIL, GUEST_PASSWORD);
    const openTestId = `open-shared-diagram-${diagramId}`;
    await expect(guestPage.getByTestId(openTestId)).toBeVisible();

    // Walk the real tab order rather than calling .focus(), which would prove nothing about
    // whether a keyboard user can actually get there.
    let reached = false;
    for (let i = 0; i < 30 && !reached; i += 1) {
      await guestPage.keyboard.press('Tab');
      reached = await guestPage.evaluate((testId) => document.activeElement?.getAttribute('data-testid') === testId, openTestId);
    }
    expect(reached).toBe(true);

    await guestPage.keyboard.press('Enter');
    await expect(guestPage.getByTestId('diagram-canvas')).toBeVisible();
  } finally {
    await revokeGuestShare(adminPage, grantId);
    await adminContext.close();
    await guestContext.close();
  }
});

test('a user with a shared diagram and no projects no longer sees the false "no projects" invitation', async ({
  browser,
}) => {
  const adminContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  const guestPage = await guestContext.newPage();

  await signIn(adminPage, ADMIN_EMAIL, ADMIN_PASSWORD);
  const projectId = await createProject(adminPage, `Invitation Suppression Source ${Date.now()}`);
  const diagramId = await createDiagram(adminPage, projectId, `Invitation Suppression Diagram ${Date.now()}`);
  const grantId = await shareWithGuest(adminPage, diagramId, 'view');

  try {
    await signIn(guestPage, GUEST_EMAIL, GUEST_PASSWORD);
    await expect(guestPage.getByTestId('shared-diagrams')).toBeVisible();
    await expect(guestPage.getByTestId('create-first-project')).toHaveCount(0);
  } finally {
    await revokeGuestShare(adminPage, grantId);
    await adminContext.close();
    await guestContext.close();
  }
});
