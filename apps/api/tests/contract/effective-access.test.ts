import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, closeTestDb, resetDatabase, seedFlowchartDiagramType, seedUser } from '../helpers/setup.js';

/**
 * canvas-2h2w.1 (docs/sharing-design.md, "Effective access"): a person's access is the HIGHEST of
 * open read (View), project membership (inherited downward), a diagram share, ownership (Manage)
 * and admin (Manage), then the viewer role caps it at Comment. Manage is a project level, and
 * only someone with Manage can give, change or remove it.
 */
describe('Effective access (canvas-2h2w.1)', () => {
  let app: FastifyInstance;
  const cookies: Record<string, string> = {};
  const ids: Record<string, string> = {};
  let projectId: string;
  let childId: string;
  let diagramId: string;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  async function login(email: string, password: string): Promise<string> {
    const response = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email, password } });
    const setCookie = response.headers['set-cookie'];
    return (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(';')[0];
  }

  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, who: string, payload?: unknown) =>
    app.inject({ method, url, headers: { cookie: cookies[who] }, ...(payload === undefined ? {} : { payload: payload as object }) });
  const diagramLevel = async (who: string, id = diagramId) => (await call('GET', `/diagrams/${id}`, who)).json().diagram.accessLevel;
  const share = (subject: 'projects' | 'diagrams', id: string, who: string, grantee: string, accessLevel: string) =>
    call('POST', `/${subject}/${id}/shares`, who, { granteeUserId: ids[grantee], accessLevel });

  beforeEach(async () => {
    await resetDatabase();
    await seedFlowchartDiagramType();
    const people: [string, 'admin' | 'architect' | 'viewer'][] = [
      ['owner', 'architect'],
      ['author', 'architect'],
      ['member', 'architect'],
      ['stranger', 'architect'],
      ['reader', 'viewer'],
      ['admin', 'admin'],
    ];
    for (const [name, role] of people) {
      ids[name] = (await seedUser({ email: `${name}@example.com`, password: `${name}-pass`, role })).id; // gitleaks:allow
      cookies[name] = await login(`${name}@example.com`, `${name}-pass`); // gitleaks:allow
    }
    projectId = (await call('POST', '/projects', 'owner', { name: 'Payments' })).json().project.id;
    childId = (await call('POST', '/projects', 'owner', { name: 'Payments child', parentProjectId: projectId })).json().project.id;
    // The diagram's author is not the project's owner: the author gets Edit on the project to create it.
    expect((await share('projects', projectId, 'owner', 'author', 'edit')).statusCode).toBe(201);
    diagramId = (await call('POST', `/projects/${projectId}/diagrams`, 'author', { name: 'Flow', diagramTypeId: 'flowchart' })).json().diagram.id;
  });

  describe('sources of access', () => {
    it('everyone signed in can read everything, at View, and View cannot comment', async () => {
      expect(await diagramLevel('stranger')).toBe('view');
      expect((await call('GET', `/projects/${projectId}/tree`, 'stranger')).statusCode).toBe(200);
      expect((await call('POST', `/diagrams/${diagramId}/comments`, 'stranger', { body: 'hi' })).statusCode).toBe(403);
    });

    it('owning the diagram, owning its project, and being an admin each give Manage', async () => {
      expect(await diagramLevel('author')).toBe('manage');
      expect(await diagramLevel('owner')).toBe('manage');
      expect(await diagramLevel('admin')).toBe('manage');
    });

    it('a project grant covers its diagrams and its child projects', async () => {
      await share('projects', projectId, 'owner', 'member', 'comment');
      expect(await diagramLevel('member')).toBe('comment');
      expect((await call('POST', `/diagrams/${diagramId}/comments`, 'member', { body: 'looks good' })).statusCode).toBe(201);
      const childDiagram = (await call('POST', `/projects/${childId}/diagrams`, 'owner', { name: 'Child flow', diagramTypeId: 'flowchart' })).json().diagram.id;
      expect(await diagramLevel('member', childDiagram)).toBe('comment');
    });

    it('a child-project grant gives nothing on the parent beyond View', async () => {
      await share('projects', childId, 'owner', 'member', 'edit');
      expect(await diagramLevel('member')).toBe('view');
    });

    it('the highest source wins, whichever of project or diagram grant is higher', async () => {
      await share('projects', projectId, 'owner', 'member', 'edit');
      await share('diagrams', diagramId, 'owner', 'member', 'view');
      expect(await diagramLevel('member')).toBe('edit');

      await share('projects', projectId, 'owner', 'member', 'view');
      await share('diagrams', diagramId, 'owner', 'member', 'edit');
      expect(await diagramLevel('member')).toBe('edit');
    });
  });

  describe('the viewer role caps at Comment', () => {
    it('a viewer given Edit gets Comment: they can comment but not save', async () => {
      await share('diagrams', diagramId, 'owner', 'reader', 'edit');
      expect(await diagramLevel('reader')).toBe('comment');
      expect((await call('POST', `/diagrams/${diagramId}/comments`, 'reader', { body: 'a note' })).statusCode).toBe(201);
      const version = (await call('GET', `/diagrams/${diagramId}`, 'reader')).json().diagram.currentVersionId;
      const save = await call('PATCH', `/diagrams/${diagramId}`, 'reader', { baseVersionId: version, dslContent: 'flowchart TD\n  A[x]\n' });
      expect(save.statusCode).toBe(403);
    });

    it('caps project access too, and a viewer cannot create projects', async () => {
      await share('projects', projectId, 'owner', 'reader', 'manage');
      const listed = (await call('GET', '/projects', 'reader')).json().projects.find((p: { id: string }) => p.id === projectId);
      expect(listed).toMatchObject({ accessLevel: 'comment', membership: 'member' });
      expect((await call('POST', `/projects/${projectId}/diagrams`, 'reader', { name: 'No', diagramTypeId: 'flowchart' })).statusCode).toBe(403);
      expect((await call('POST', '/projects', 'reader', { name: 'Mine' })).statusCode).toBe(403);
    });
  });

  describe('Manage', () => {
    it('is a project level only', async () => {
      expect((await share('projects', projectId, 'owner', 'member', 'manage')).statusCode).toBe(201);
      expect((await share('diagrams', diagramId, 'owner', 'member', 'manage')).statusCode).toBe(400);
      expect(await diagramLevel('member')).toBe('manage');
    });

    it('an editor cannot give Manage, promote themselves, or demote a manager', async () => {
      await share('projects', projectId, 'owner', 'member', 'manage');
      // 'author' has Edit on the project (beforeEach).
      expect((await share('projects', projectId, 'author', 'stranger', 'manage')).statusCode).toBe(403);
      expect((await share('projects', projectId, 'author', 'author', 'manage')).statusCode).toBe(403);
      expect((await share('projects', projectId, 'author', 'member', 'view')).statusCode).toBe(403);
      const managerGrant = (await call('GET', `/projects/${projectId}/shares`, 'author')).json().grants.find(
        (g: { granteeUserId: string }) => g.granteeUserId === ids.member,
      );
      expect((await call('DELETE', `/shares/${managerGrant.id}`, 'author')).statusCode).toBe(403);
      // Plain levels are still the editor's to give.
      expect((await share('projects', projectId, 'author', 'stranger', 'comment')).statusCode).toBe(201);
    });

    it('someone with Manage can give and remove Manage', async () => {
      await share('projects', projectId, 'owner', 'member', 'manage');
      expect((await share('projects', projectId, 'member', 'stranger', 'manage')).statusCode).toBe(201);
      const grant = (await call('GET', `/projects/${projectId}/shares`, 'member')).json().grants.find(
        (g: { granteeUserId: string }) => g.granteeUserId === ids.stranger,
      );
      expect((await call('DELETE', `/shares/${grant.id}`, 'member')).statusCode).toBe(204);
    });
  });

  it('GET /projects lists every project with the caller\'s level and membership', async () => {
    await share('projects', childId, 'owner', 'member', 'edit');
    const projects = (await call('GET', '/projects', 'member')).json().projects as { id: string; accessLevel: string; membership: string | null }[];
    expect(projects.find((p) => p.id === projectId)).toMatchObject({ accessLevel: 'view', membership: null });
    expect(projects.find((p) => p.id === childId)).toMatchObject({ accessLevel: 'edit', membership: 'member' });
    const admin = (await call('GET', '/projects', 'admin')).json().projects as { accessLevel: string; membership: string | null }[];
    expect(admin.every((p) => p.accessLevel === 'manage' && p.membership === null)).toBe(true);
  });
});
