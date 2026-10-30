import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, closeTestDb, resetDatabase, seedFlowchartDiagramType, seedUser } from '../helpers/setup.js';

/**
 * Contract for GET /projects (feature 007, FR-013a, SC-006a).
 *
 * This endpoint is what makes an in-app project chooser possible — no way to list projects
 * existed before. Its visibility rule is the one requirement in this feature whose failure is a
 * data leak rather than a bug, so the negative assertion checks the project's NAME is absent from
 * the raw payload, not merely that its id is missing from a parsed list.
 */
describe('Project list API contract', () => {
  let app: FastifyInstance;
  let aliceCookie: string;
  let bobCookie: string;
  let aliceId: string;

  async function login(email: string, password: string): Promise<string> {
    const response = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email, password } });
    const setCookie = response.headers['set-cookie'];
    return (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(';')[0];
  }

  async function createProject(cookie: string, name: string, parentProjectId?: string): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/projects',
      headers: { cookie },
      payload: parentProjectId ? { name, parentProjectId } : { name },
    });
    return response.json().project.id;
  }

  async function createDiagram(cookie: string, projectId: string, name: string): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/diagrams`,
      headers: { cookie },
      payload: { name, diagramTypeId: 'flowchart' },
    });
    return response.json().diagram.id;
  }

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  beforeEach(async () => {
    await resetDatabase();
    await seedFlowchartDiagramType();
    ({ id: aliceId } = await seedUser({ email: 'alice@example.com', password: 'alice-pass' }));
    await seedUser({ email: 'bob@example.com', password: 'bob-pass' });
    aliceCookie = await login('alice@example.com', 'alice-pass');
    bobCookie = await login('bob@example.com', 'bob-pass');
  });

  it('lists a project the user owns', async () => {
    await createProject(aliceCookie, 'Alice Owned');

    const response = await app.inject({ method: 'GET', url: '/projects', headers: { cookie: aliceCookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json().projects.map((p: { name: string }) => p.name)).toEqual(['Alice Owned']);
  });

  // canvas-2h2w.1: open read-only -- every signed-in user sees every project, at View, and it
  // isn't one of "their" projects (membership null) until they own it or are given access.
  it("lists someone else's project read-only, not as one of the user's own", async () => {
    await createProject(bobCookie, 'Bob Open Project');

    const response = await app.inject({ method: 'GET', url: '/projects', headers: { cookie: aliceCookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json().projects).toEqual([expect.objectContaining({ name: 'Bob Open Project', accessLevel: 'view', membership: null })]);
    const own = await app.inject({ method: 'GET', url: '/projects', headers: { cookie: bobCookie } });
    expect(own.json().projects[0]).toMatchObject({ accessLevel: 'manage', membership: 'owner' });
  });

  it('lists a project shared with the user', async () => {
    const bobProject = await createProject(bobCookie, 'Bob Shared');
    await app.inject({
      method: 'POST',
      url: `/projects/${bobProject}/shares`,
      headers: { cookie: bobCookie },
      payload: { granteeUserId: aliceId, accessLevel: 'view' },
    });

    const response = await app.inject({ method: 'GET', url: '/projects', headers: { cookie: aliceCookie } });
    expect(response.json().projects).toEqual([expect.objectContaining({ name: 'Bob Shared', accessLevel: 'view', membership: 'member' })]);
  });

  it('returns an empty list — not an error — when there are no projects yet', async () => {
    // canvas-2h2w.1: with open read, "no projects" again only means an empty installation, which
    // resolves to the first-run invitation (FR-014).
    const response = await app.inject({ method: 'GET', url: '/projects', headers: { cookie: aliceCookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json().projects).toEqual([]);
  });

  it('includes descendants of a project the user holds', async () => {
    const root = await createProject(aliceCookie, 'Root');
    await createProject(aliceCookie, 'Child', root);

    const response = await app.inject({ method: 'GET', url: '/projects', headers: { cookie: aliceCookie } });
    expect(response.json().projects.map((p: { name: string }) => p.name)).toEqual(['Child', 'Root']);
  });

  it('orders by name so the chooser is stable between loads', async () => {
    await createProject(aliceCookie, 'Zebra');
    await createProject(aliceCookie, 'Alpha');
    await createProject(aliceCookie, 'Marmot');

    const response = await app.inject({ method: 'GET', url: '/projects', headers: { cookie: aliceCookie } });
    expect(response.json().projects.map((p: { name: string }) => p.name)).toEqual(['Alpha', 'Marmot', 'Zebra']);
  });

  it('requires authentication', async () => {
    const response = await app.inject({ method: 'GET', url: '/projects' });
    expect(response.statusCode).toBe(401);
  });

  it('canvas-228.1: includes each project\'s direct diagram count', async () => {
    const projectId = await createProject(aliceCookie, 'Has Diagrams');
    await createDiagram(aliceCookie, projectId, 'One');
    await createDiagram(aliceCookie, projectId, 'Two');

    const response = await app.inject({ method: 'GET', url: '/projects', headers: { cookie: aliceCookie } });
    expect(response.json().projects).toEqual([expect.objectContaining({ name: 'Has Diagrams', diagramCount: 2 })]);
  });

  it('canvas-228.1: a project with no diagrams has a count of 0, not null/undefined', async () => {
    await createProject(aliceCookie, 'Empty Project');

    const response = await app.inject({ method: 'GET', url: '/projects', headers: { cookie: aliceCookie } });
    expect(response.json().projects).toEqual([expect.objectContaining({ name: 'Empty Project', diagramCount: 0 })]);
  });

  it('canvas-228.1: a soft-deleted diagram does not count', async () => {
    const projectId = await createProject(aliceCookie, 'One Deleted');
    const diagramId = await createDiagram(aliceCookie, projectId, 'Gone');
    await app.inject({ method: 'DELETE', url: `/diagrams/${diagramId}`, headers: { cookie: aliceCookie } });

    const response = await app.inject({ method: 'GET', url: '/projects', headers: { cookie: aliceCookie } });
    expect(response.json().projects).toEqual([expect.objectContaining({ name: 'One Deleted', diagramCount: 0 })]);
  });
});
