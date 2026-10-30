import { generateKeyPairSync } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { getDb } from '../../src/db/client.js';
import { buildGitHubTestApp, githubTestConfig, startFakeGitHub, type FakeGitHub, type FakeRepo } from '../helpers/fake-github.js';
import { closeTestDb, resetDatabase, seedFlowchartDiagramType, seedProject, seedUser } from '../helpers/setup.js';

/**
 * canvas-3s5.1: linking a project to a GitHub repository + folder (admin only), against an
 * in-memory fake GitHub that verifies the App JWT and installation tokens.
 */
describe('GitHub project links (canvas-3s5.1)', () => {
  let fake: FakeGitHub;
  let app: FastifyInstance;
  let repo: FakeRepo;
  let adminCookie = '';
  let architectCookie = '';
  let projectId = '';
  let otherProjectId = '';

  async function login(email: string, password: string) {
    const res = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email, password } });
    return String(res.headers['set-cookie']).split(';')[0];
  }
  const call = (method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, cookie = adminCookie, payload?: unknown) =>
    app.inject({ method, url, headers: { cookie }, payload: payload as object });
  const link = (project: string, payload: Record<string, unknown>, cookie = adminCookie) => call('PUT', `/projects/${project}/github-link`, cookie, payload);

  beforeAll(async () => {
    fake = await startFakeGitHub();
    app = await buildGitHubTestApp(fake);
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
    await fake.stop();
  });
  beforeEach(async () => {
    await resetDatabase();
    fake.requests.length = 0;
    fake.installations.clear();
    fake.repos.clear();
    const installation = fake.addInstallation({ account: 'acme' });
    repo = fake.addRepo(installation.id, { name: 'architecture', defaultBranch: 'main' });
    fake.addRepo(installation.id, { name: 'other' });

    await seedUser({ email: 'admin@example.com', password: 'admin-pass', role: 'admin' }); // gitleaks:allow
    const architect = await seedUser({ email: 'architect@example.com', password: 'architect-pass', role: 'architect' }); // gitleaks:allow
    adminCookie = await login('admin@example.com', 'admin-pass'); // gitleaks:allow
    architectCookie = await login('architect@example.com', 'architect-pass'); // gitleaks:allow
    projectId = (await seedProject('Payments', architect.id)).id;
    otherProjectId = (await seedProject('Billing', architect.id)).id;
  });

  describe('status and repositories', () => {
    it('status lists the installations and authenticates with a valid App JWT', async () => {
      const res = await call('GET', '/admin/github/status');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ enabled: true, appId: '12345', installations: [{ account: 'acme', repositorySelection: 'selected' }] });
      expect(res.json().error).toBeUndefined();
      expect(fake.requests.find((r) => r.path === '/app/installations')?.auth).toBe('app');
    });

    it('status reports a GitHub problem instead of failing (App key GitHub does not recognise)', async () => {
      const config = githubTestConfig(fake);
      config.github!.privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
      const mismatched = await buildApp({ config, logger: false });
      const res = await mismatched.inject({ method: 'GET', url: '/admin/github/status', headers: { cookie: adminCookie } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ enabled: true, installations: [] });
      expect(res.json().error).toMatch(/Bad credentials/);
      await mismatched.close();
    });

    it('lists installed repositories only', async () => {
      const outside = fake.addInstallation({ id: 9999, account: 'stranger' });
      const hidden = fake.addRepo(outside.id, { name: 'hidden' });
      fake.removeRepoFromInstallation(hidden);
      const res = await call('GET', '/admin/github/repositories');
      expect(res.statusCode).toBe(200);
      const names = res.json().repositories.map((r: { fullName: string }) => r.fullName);
      expect(names).toEqual(['acme/architecture', 'acme/other']);
      expect(res.json().repositories[0]).toMatchObject({ id: repo.id, defaultBranch: 'main', installationId: expect.any(Number) });
    });

    it('status, repositories, links and the link test are admin-only', async () => {
      for (const [method, url] of [
        ['GET', '/admin/github/status'],
        ['GET', '/admin/github/repositories'],
        ['GET', '/admin/github/links'],
        ['POST', `/admin/github/links/${projectId}/test`],
      ] as const) {
        expect((await call(method, url, architectCookie)).statusCode, url).toBe(403);
      }
      expect((await app.inject({ method: 'GET', url: '/admin/github/status' })).statusCode).toBe(401);
    });
  });

  describe('PUT /projects/:id/github-link', () => {
    it('is admin only (an architect who owns the project gets 403)', async () => {
      const res = await link(projectId, { repoId: repo.id, folder: 'diagrams' }, architectCookie);
      expect(res.statusCode).toBe(403);
      expect((await call('DELETE', `/projects/${projectId}/github-link`, architectCookie)).statusCode).toBe(403);
    });

    it('links a project, defaulting the base branch to the repository default, and normalises the folder', async () => {
      const res = await link(projectId, { repoId: repo.id, folder: '/architecture//diagrams/' });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().link).toMatchObject({
        projectId,
        repoId: repo.id,
        repoFullName: 'acme/architecture',
        folder: 'architecture/diagrams',
        baseBranch: 'main',
        installationId: expect.any(Number),
        lastCheckError: null,
      });
      // The token used to check the branch is narrowed to that one repository.
      expect(fake.tokenRequests.at(-1)?.body.repository_ids).toEqual([repo.id]);
    });

    it('uses an explicit base branch when given and rejects a missing one with 400', async () => {
      fake.repos.get(repo.id)!.branches.set('develop', fake.headOf(repo, 'main'));
      const ok = await link(projectId, { repoId: repo.id, folder: 'diagrams', baseBranch: 'develop' });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().link.baseBranch).toBe('develop');

      const missing = await link(otherProjectId, { repoId: repo.id, folder: 'elsewhere', baseBranch: 'nope' });
      expect(missing.statusCode).toBe(400);
      expect(missing.json().error).toContain('nope');
    });

    it('only accepts repositories the App is installed on', async () => {
      const outside = fake.addInstallation({ account: 'stranger' });
      const hidden = fake.addRepo(outside.id, { name: 'hidden' });
      fake.removeRepoFromInstallation(hidden);
      expect((await link(projectId, { repoId: hidden.id, folder: 'diagrams' })).statusCode).toBe(400);
      expect((await link(projectId, { repoId: 424242, folder: 'diagrams' })).statusCode).toBe(400);
      expect((await call('GET', `/admin/github/links`)).json().links).toEqual([]);
    });

    it('rejects bad folders with 400 (traversal, reserved names, empty, odd characters)', async () => {
      for (const folder of ['..', 'a/../b', '../etc', '.github', '.github/workflows', 'docs/.git', '.canvas', '', '   ', '/', 'a b', 'a/\u0000b', 'a;b']) {
        const res = await link(projectId, { repoId: repo.id, folder });
        expect(res.statusCode, JSON.stringify(folder)).toBe(400);
      }
      expect((await link(projectId, { repoId: repo.id })).statusCode).toBe(400);
      expect((await link(projectId, { repoId: 'x', folder: 'a' })).statusCode).toBe(400);
      expect((await call('GET', `/admin/github/links`)).json().links).toEqual([]);
    });

    it('404s for an unknown project', async () => {
      expect((await link('00000000-0000-4000-8000-000000000000', { repoId: repo.id, folder: 'diagrams' })).statusCode).toBe(404);
    });

    it('refuses the same folder, or a nested one, for another project in the same repository (409)', async () => {
      expect((await link(projectId, { repoId: repo.id, folder: 'architecture' })).statusCode).toBe(200);
      for (const folder of ['architecture', 'architecture/billing', 'architecture/billing/deep']) {
        expect((await link(otherProjectId, { repoId: repo.id, folder })).statusCode, folder).toBe(409);
      }
      // ... and the parent of an existing folder too.
      expect((await link(projectId, { repoId: repo.id, folder: 'a/b' })).statusCode).toBe(200);
      expect((await link(otherProjectId, { repoId: repo.id, folder: 'a' })).statusCode).toBe(409);
      // A sibling that merely shares a prefix is fine.
      expect((await link(otherProjectId, { repoId: repo.id, folder: 'a-b' })).statusCode).toBe(200);
      expect((await link(otherProjectId, { repoId: repo.id, folder: 'billing' })).statusCode).toBe(200);
    });

    it('allows the same folder name in a different repository', async () => {
      const other = [...fake.repos.values()].find((r) => r.name === 'other')!;
      expect((await link(projectId, { repoId: repo.id, folder: 'diagrams' })).statusCode).toBe(200);
      expect((await link(otherProjectId, { repoId: other.id, folder: 'diagrams' })).statusCode).toBe(200);
    });

    it('re-PUT updates the same link in place (including moving it to a nested folder of its own)', async () => {
      const first = (await link(projectId, { repoId: repo.id, folder: 'one' })).json().link;
      const second = await link(projectId, { repoId: repo.id, folder: 'one/two' });
      expect(second.statusCode).toBe(200);
      expect(second.json().link).toMatchObject({ id: first.id, folder: 'one/two' });
      const rows = await getDb().selectFrom('github_links').select('id').execute();
      expect(rows).toHaveLength(1);
    });

    it('records an audit event', async () => {
      await link(projectId, { repoId: repo.id, folder: 'diagrams' });
      const events = await getDb().selectFrom('audit_events').select(['event', 'detail']).where('event', '=', 'github_link_set').execute();
      expect(events).toHaveLength(1);
      expect(String(events[0].detail)).toContain('acme/architecture');
    });
  });

  describe('listing, reading, deleting and testing', () => {
    it('lists links, shows a project member the link, and DELETE removes it', async () => {
      await link(projectId, { repoId: repo.id, folder: 'diagrams' });
      const list = await call('GET', '/admin/github/links');
      expect(list.json().links).toMatchObject([{ projectId, projectName: 'Payments', repoFullName: 'acme/architecture', folder: 'diagrams' }]);

      const member = await call('GET', `/projects/${projectId}/github-link`, architectCookie);
      expect(member.statusCode).toBe(200);
      expect(member.json()).toEqual({ enabled: true, link: { repoFullName: 'acme/architecture', folder: 'diagrams', baseBranch: 'main' } });

      expect((await call('DELETE', `/projects/${projectId}/github-link`)).statusCode).toBe(204);
      expect((await call('GET', `/projects/${projectId}/github-link`, architectCookie)).json()).toEqual({ enabled: true, link: null });
      expect((await call('DELETE', `/projects/${projectId}/github-link`)).statusCode).toBe(404);
      expect((await call('GET', '/admin/github/links')).json().links).toEqual([]);
      const events = await getDb().selectFrom('audit_events').select('event').where('event', '=', 'github_link_removed').execute();
      expect(events).toHaveLength(1);
    });

    // canvas-2h2w.1: every project is readable by everyone signed in, so its link is too.
    it('a user with no grant on the project can still read its link', async () => {
      await seedUser({ email: 'stranger@example.com', password: 'stranger-pass', role: 'architect' }); // gitleaks:allow
      const cookie = await login('stranger@example.com', 'stranger-pass'); // gitleaks:allow
      expect((await call('GET', `/projects/${projectId}/github-link`, cookie)).statusCode).toBe(200);
    });

    it('the link test passes every check, then fails once the repository leaves the installation', async () => {
      await link(projectId, { repoId: repo.id, folder: 'diagrams' });
      const ok = await call('POST', `/admin/github/links/${projectId}/test`);
      expect(ok.statusCode).toBe(200);
      expect(ok.json().ok).toBe(true);
      expect(ok.json().checks.map((c: { id: string; ok: boolean }) => [c.id, c.ok])).toEqual([
        ['installation', true],
        ['contents', true],
        ['pull_requests', true],
        ['repository', true],
        ['branch', true],
      ]);
      expect((await call('GET', '/admin/github/links')).json().links[0].lastCheckError).toBeNull();

      fake.removeRepoFromInstallation(repo);
      const bad = await call('POST', `/admin/github/links/${projectId}/test`);
      expect(bad.statusCode).toBe(200);
      expect(bad.json().ok).toBe(false);
      const failed = bad.json().checks.find((c: { ok: boolean }) => !c.ok);
      expect(failed).toMatchObject({ id: 'repository' });
      expect((await call('GET', '/admin/github/links')).json().links[0].lastCheckError).toContain('Repository');
    });

    it('the link test reports missing permissions and a deleted base branch', async () => {
      await link(projectId, { repoId: repo.id, folder: 'diagrams' });
      fake.installations.get(repo.installationId)!.permissions = { contents: 'read', pull_requests: 'read', metadata: 'read' };
      const readOnly = (await call('POST', `/admin/github/links/${projectId}/test`)).json();
      expect(readOnly.ok).toBe(false);
      expect(readOnly.checks.filter((c: { ok: boolean }) => !c.ok).map((c: { id: string }) => c.id)).toEqual(['contents', 'pull_requests']);

      fake.installations.get(repo.installationId)!.permissions = { contents: 'write', pull_requests: 'write', metadata: 'read' };
      fake.deleteBranch(repo, 'main');
      const noBranch = (await call('POST', `/admin/github/links/${projectId}/test`)).json();
      expect(noBranch.checks.find((c: { id: string }) => c.id === 'branch')).toMatchObject({ ok: false });
    });

    it('the link test reports an uninstalled App', async () => {
      await link(projectId, { repoId: repo.id, folder: 'diagrams' });
      fake.removeInstallation(repo.installationId);
      const res = (await call('POST', `/admin/github/links/${projectId}/test`)).json();
      expect(res.ok).toBe(false);
      expect(res.checks[0]).toMatchObject({ id: 'installation', ok: false });
    });

    it('the link test 404s when the project is not linked', async () => {
      expect((await call('POST', `/admin/github/links/${projectId}/test`)).statusCode).toBe(404);
    });

    it('follows a repository that was renamed on GitHub', async () => {
      await link(projectId, { repoId: repo.id, folder: 'diagrams' });
      fake.renameRepo(repo, 'architecture-v2');
      expect((await call('POST', `/admin/github/links/${projectId}/test`)).json().ok).toBe(true);
      expect((await call('GET', '/admin/github/links')).json().links[0].repoFullName).toBe('acme/architecture-v2');
    });
  });
});

describe('GitHub routes when the integration is not configured (canvas-3s5.1)', () => {
  let app: FastifyInstance;
  let adminCookie = '';
  let projectId = '';
  let diagramId = '';

  beforeAll(async () => {
    app = await buildGitHubTestApp(null);
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });
  beforeEach(async () => {
    await resetDatabase();
    const admin = await seedUser({ email: 'admin@example.com', password: 'admin-pass', role: 'admin' }); // gitleaks:allow
    const res = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email: 'admin@example.com', password: 'admin-pass' } }); // gitleaks:allow
    adminCookie = String(res.headers['set-cookie']).split(';')[0];
    projectId = (await seedProject('P', admin.id)).id;
    await seedFlowchartDiagramType();
    diagramId = (await app.inject({ method: 'POST', url: `/projects/${projectId}/diagrams`, headers: { cookie: adminCookie }, payload: { name: 'D', diagramTypeId: 'flowchart' } })).json().diagram.id;
  });

  const call = (method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { cookie: adminCookie }, payload: payload as object });

  it('reports enabled: false and never throws', async () => {
    expect((await call('GET', '/admin/github/status')).json()).toEqual({ enabled: false, installations: [] });
    expect((await call('GET', `/projects/${projectId}/github-link`)).json()).toEqual({ enabled: false, link: null });

    const submission = await call('GET', `/diagrams/${diagramId}/submission`);
    expect(submission.statusCode).toBe(200);
    expect(submission.json()).toMatchObject({ enabled: false, link: null, current: null, changesSinceSubmitting: false, canSubmit: { allowed: false, reason: 'github_disabled' } });
  });

  it('answers github_disabled (409) for every route that needs GitHub', async () => {
    const calls: [Parameters<typeof call>[0], string, unknown?][] = [
      ['GET', '/admin/github/repositories'],
      ['POST', `/admin/github/links/${projectId}/test`],
      ['PUT', `/projects/${projectId}/github-link`, { repoId: 1, folder: 'diagrams' }],
      ['POST', `/diagrams/${diagramId}/submissions`],
    ];
    for (const [method, url, payload] of calls) {
      const res = await call(method, url, payload);
      expect(res.statusCode, `${method} ${url}`).toBe(409);
      expect(res.json().code).toBe('github_disabled');
    }
    expect((await call('GET', '/admin/github/links')).json()).toEqual({ links: [] });
    expect((await call('DELETE', `/projects/${projectId}/github-link`)).statusCode).toBe(404);
  });
});
