import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, closeTestDb, resetDatabase, seedFlowchartDiagramType, seedUser } from '../helpers/setup.js';

/**
 * Contract for Project/Folder create/get/tree, per
 * specs/001-diagramming-platform/contracts/api-projects-sharing-admin.md. Covers User Story 4.
 */
describe('Projects API contract', () => {
  let app: FastifyInstance;
  let sessionCookie: string;

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
    await seedUser({ email: 'architect@example.com', password: 'architect-pass' });
    const response = await app.inject({
      method: 'POST',
      url: '/auth/local/login',
      payload: { email: 'architect@example.com', password: 'architect-pass' },
    });
    const setCookie = response.headers['set-cookie'];
    sessionCookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(';')[0];
  });

  it('creates a root project and fetches it', async () => {
    const createResponse = await app.inject({
      method: 'POST',
      url: '/projects',
      headers: { cookie: sessionCookie },
      payload: { name: 'Root Project' },
    });
    expect(createResponse.statusCode).toBe(201);
    const { project } = createResponse.json();
    expect(project.parentProjectId).toBeNull();

    const getResponse = await app.inject({ method: 'GET', url: `/projects/${project.id}`, headers: { cookie: sessionCookie } });
    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.json().project.name).toBe('Root Project');
  });

  it('rejects a child project with a non-existent parent', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/projects',
      headers: { cookie: sessionCookie },
      payload: { name: 'Orphan', parentProjectId: '00000000-0000-0000-0000-000000000000' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('builds a nested tree including diagrams at each level', async () => {
    const root = (
      await app.inject({ method: 'POST', url: '/projects', headers: { cookie: sessionCookie }, payload: { name: 'Root' } })
    ).json().project;
    const child = (
      await app.inject({
        method: 'POST',
        url: '/projects',
        headers: { cookie: sessionCookie },
        payload: { name: 'Child', parentProjectId: root.id },
      })
    ).json().project;
    await app.inject({
      method: 'POST',
      url: `/projects/${child.id}/diagrams`,
      headers: { cookie: sessionCookie },
      payload: { name: 'Nested Diagram', diagramTypeId: 'flowchart' },
    });

    const treeResponse = await app.inject({ method: 'GET', url: `/projects/${root.id}/tree`, headers: { cookie: sessionCookie } });
    expect(treeResponse.statusCode).toBe(200);
    const tree = treeResponse.json().tree;
    expect(tree.id).toBe(root.id);
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0].id).toBe(child.id);
    expect(tree.children[0].diagrams).toHaveLength(1);
    expect(tree.children[0].diagrams[0].name).toBe('Nested Diagram');
  });

  it('searches diagrams within a project by name and type', async () => {
    const project = (
      await app.inject({ method: 'POST', url: '/projects', headers: { cookie: sessionCookie }, payload: { name: 'Search Test' } })
    ).json().project;
    await app.inject({
      method: 'POST',
      url: `/projects/${project.id}/diagrams`,
      headers: { cookie: sessionCookie },
      payload: { name: 'Order Flow', diagramTypeId: 'flowchart' },
    });
    await app.inject({
      method: 'POST',
      url: `/projects/${project.id}/diagrams`,
      headers: { cookie: sessionCookie },
      payload: { name: 'Payment Flow', diagramTypeId: 'flowchart' },
    });

    const response = await app.inject({
      method: 'GET',
      url: `/projects/${project.id}/diagrams?query=Order`,
      headers: { cookie: sessionCookie },
    });
    expect(response.statusCode).toBe(200);
    const diagrams = response.json().diagrams;
    expect(diagrams).toHaveLength(1);
    expect(diagrams[0].name).toBe('Order Flow');
  });
});
