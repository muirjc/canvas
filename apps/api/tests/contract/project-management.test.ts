import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, closeTestDb, resetDatabase, seedFlowchartDiagramType, seedProject, seedUser } from '../helpers/setup.js';

/**
 * Contract for canvas-228.3: renaming a project (PATCH /projects/:id) and moving a diagram to a
 * different project (PATCH /diagrams/:id/project) — the two other CRUD gaps canvas-228.1's
 * Projects screen was built to eventually close, alongside canvas-228.2's delete.
 */
describe('Project rename API contract', () => {
  let app: FastifyInstance;
  let ownerCookie: string;
  let ownerId: string;
  let otherUserCookie: string;
  let adminCookie: string;
  let projectId: string;

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

  beforeEach(async () => {
    await resetDatabase();
    await seedFlowchartDiagramType();
    ownerId = (await seedUser({ email: 'owner@example.com', password: 'owner-pass' })).id;
    projectId = (await seedProject('Original Name', ownerId)).id;
    await seedUser({ email: 'other@example.com', password: 'other-pass' });
    await seedUser({ email: 'admin@example.com', password: 'admin-pass', role: 'admin' });
    ownerCookie = await login('owner@example.com', 'owner-pass');
    otherUserCookie = await login('other@example.com', 'other-pass');
    adminCookie = await login('admin@example.com', 'admin-pass');
  });

  it('lets the owner rename their own project', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/projects/${projectId}`,
      headers: { cookie: ownerCookie },
      payload: { name: 'Renamed' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().project.name).toBe('Renamed');

    const getResponse = await app.inject({ method: 'GET', url: `/projects/${projectId}`, headers: { cookie: ownerCookie } });
    expect(getResponse.json().project.name).toBe('Renamed');
  });

  it('rejects rename from a user who is neither owner nor admin', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/projects/${projectId}`,
      headers: { cookie: otherUserCookie },
      payload: { name: 'Hijacked' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('rejects rename even with edit-level share access — ownership only, mirroring diagram delete', async () => {
    await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/shares`,
      headers: { cookie: ownerCookie },
      payload: { granteeUserId: (await seedUser({ email: 'editor@example.com', password: 'editor-pass' })).id, accessLevel: 'edit' },
    });
    const editorCookie = await login('editor@example.com', 'editor-pass');

    const response = await app.inject({
      method: 'PATCH',
      url: `/projects/${projectId}`,
      headers: { cookie: editorCookie },
      payload: { name: 'Hijacked' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('admin can rename a project they do not own', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/projects/${projectId}`,
      headers: { cookie: adminCookie },
      payload: { name: 'Renamed By Admin' },
    });
    expect(response.statusCode).toBe(200);
  });

  it('rejects an empty name', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/projects/${projectId}`,
      headers: { cookie: ownerCookie },
      payload: { name: '' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('returns 404 for a nonexistent project', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/projects/00000000-0000-0000-0000-000000000000',
      headers: { cookie: ownerCookie },
      payload: { name: 'Anything' },
    });
    expect(response.statusCode).toBe(404);
  });

  it('requires authentication', async () => {
    const response = await app.inject({ method: 'PATCH', url: `/projects/${projectId}`, payload: { name: 'X' } });
    expect(response.statusCode).toBe(401);
  });
});

describe('Move diagram between projects API contract', () => {
  let app: FastifyInstance;
  let ownerCookie: string;
  let ownerId: string;
  let outsiderCookie: string;
  let sourceProjectId: string;
  let destinationProjectId: string;
  let noAccessProjectId: string;
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

  beforeEach(async () => {
    await resetDatabase();
    await seedFlowchartDiagramType();
    ownerId = (await seedUser({ email: 'owner@example.com', password: 'owner-pass' })).id;
    sourceProjectId = (await seedProject('Source', ownerId)).id;
    destinationProjectId = (await seedProject('Destination', ownerId)).id;
    await seedUser({ email: 'outsider@example.com', password: 'outsider-pass' });
    noAccessProjectId = (await seedProject('No Access', (await seedUser({ email: 'stranger@example.com', password: 'stranger-pass' })).id)).id;
    ownerCookie = await login('owner@example.com', 'owner-pass');
    outsiderCookie = await login('outsider@example.com', 'outsider-pass');

    const createResponse = await app.inject({
      method: 'POST',
      url: `/projects/${sourceProjectId}/diagrams`,
      headers: { cookie: ownerCookie },
      payload: { name: 'Movable Diagram', diagramTypeId: 'flowchart' },
    });
    diagramId = createResponse.json().diagram.id;
  });

  it('moves a diagram to a project the user has edit access to', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/diagrams/${diagramId}/project`,
      headers: { cookie: ownerCookie },
      payload: { projectId: destinationProjectId },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().diagram.projectId).toBe(destinationProjectId);

    const sourceTree = await app.inject({ method: 'GET', url: `/projects/${sourceProjectId}/tree`, headers: { cookie: ownerCookie } });
    expect(sourceTree.json().tree.diagrams).toHaveLength(0);
    const destinationTree = await app.inject({ method: 'GET', url: `/projects/${destinationProjectId}/tree`, headers: { cookie: ownerCookie } });
    expect(destinationTree.json().tree.diagrams.map((d: { id: string }) => d.id)).toEqual([diagramId]);
  });

  it('rejects a user with no access to the diagram at all', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/diagrams/${diagramId}/project`,
      headers: { cookie: outsiderCookie },
      payload: { projectId: destinationProjectId },
    });
    expect(response.statusCode).toBe(403);
  });

  it('rejects moving into a project the user has no access to, even with edit access on the diagram', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/diagrams/${diagramId}/project`,
      headers: { cookie: ownerCookie },
      payload: { projectId: noAccessProjectId },
    });
    expect(response.statusCode).toBe(403);

    // Unchanged — the rejected move must not have partially applied.
    const getResponse = await app.inject({ method: 'GET', url: `/diagrams/${diagramId}`, headers: { cookie: ownerCookie } });
    expect(getResponse.json().diagram.projectId).toBe(sourceProjectId);
  });

  it('returns 404 for a nonexistent diagram', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/diagrams/00000000-0000-0000-0000-000000000000/project',
      headers: { cookie: ownerCookie },
      payload: { projectId: destinationProjectId },
    });
    expect(response.statusCode).toBe(404);
  });

  it('returns 404 for a nonexistent destination project', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/diagrams/${diagramId}/project`,
      headers: { cookie: ownerCookie },
      payload: { projectId: '00000000-0000-0000-0000-000000000000' },
    });
    expect(response.statusCode).toBe(404);
  });

  it('requires authentication', async () => {
    const response = await app.inject({ method: 'PATCH', url: `/diagrams/${diagramId}/project`, payload: { projectId: destinationProjectId } });
    expect(response.statusCode).toBe(401);
  });
});
