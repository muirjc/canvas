import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, closeTestDb, resetDatabase, seedFlowchartDiagramType, seedProject, seedUser } from '../helpers/setup.js';

/**
 * Contract for canvas-8x1: renaming a diagram (PATCH /diagrams/:id/name), mirroring
 * project-management.test.ts's "Move diagram between projects" contract in style/structure —
 * the two other diagram-level PATCH routes gated by requireDiagramAccess('edit').
 */
describe('Rename diagram API contract', () => {
  let app: FastifyInstance;
  let ownerCookie: string;
  let ownerId: string;
  let outsiderCookie: string;
  let projectId: string;
  let diagramId: string;
  let originalDslContent: string;

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
    projectId = (await seedProject('Source', ownerId)).id;
    await seedUser({ email: 'outsider@example.com', password: 'outsider-pass' });
    ownerCookie = await login('owner@example.com', 'owner-pass');
    outsiderCookie = await login('outsider@example.com', 'outsider-pass');

    const createResponse = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/diagrams`,
      headers: { cookie: ownerCookie },
      payload: { name: 'Original Name', diagramTypeId: 'flowchart' },
    });
    diagramId = createResponse.json().diagram.id;
    originalDslContent = createResponse.json().diagram.dslContent;
  });

  it('lets a user with edit access rename the diagram, and the change persists', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/diagrams/${diagramId}/name`,
      headers: { cookie: ownerCookie },
      payload: { name: 'Renamed Diagram' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().diagram.name).toBe('Renamed Diagram');

    const getResponse = await app.inject({ method: 'GET', url: `/diagrams/${diagramId}`, headers: { cookie: ownerCookie } });
    expect(getResponse.json().diagram.name).toBe('Renamed Diagram');
  });

  it('rejects a user with only view access', async () => {
    const viewerId = (await seedUser({ email: 'viewer@example.com', password: 'viewer-pass' })).id;
    await app.inject({
      method: 'POST',
      url: `/diagrams/${diagramId}/shares`,
      headers: { cookie: ownerCookie },
      payload: { granteeUserId: viewerId, accessLevel: 'view' },
    });
    const viewerCookie = await login('viewer@example.com', 'viewer-pass');

    const response = await app.inject({
      method: 'PATCH',
      url: `/diagrams/${diagramId}/name`,
      headers: { cookie: viewerCookie },
      payload: { name: 'Hijacked' },
    });
    expect(response.statusCode).toBe(403);

    const getResponse = await app.inject({ method: 'GET', url: `/diagrams/${diagramId}`, headers: { cookie: ownerCookie } });
    expect(getResponse.json().diagram.name).toBe('Original Name');
  });

  it('rejects a user with no access to the diagram at all', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/diagrams/${diagramId}/name`,
      headers: { cookie: outsiderCookie },
      payload: { name: 'Hijacked' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('rejects a missing name', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/diagrams/${diagramId}/name`,
      headers: { cookie: ownerCookie },
      payload: {},
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a blank/whitespace-only name', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/diagrams/${diagramId}/name`,
      headers: { cookie: ownerCookie },
      payload: { name: '   ' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('returns 404 for a nonexistent diagram', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/diagrams/00000000-0000-0000-0000-000000000000/name',
      headers: { cookie: ownerCookie },
      payload: { name: 'Anything' },
    });
    expect(response.statusCode).toBe(404);
  });

  it('requires authentication', async () => {
    const response = await app.inject({ method: 'PATCH', url: `/diagrams/${diagramId}/name`, payload: { name: 'X' } });
    expect(response.statusCode).toBe(401);
  });

  it('does not touch dslContent or create a new version', async () => {
    const versionsBefore = await app.inject({
      method: 'GET',
      url: `/diagrams/${diagramId}/versions`,
      headers: { cookie: ownerCookie },
    });
    const versionCountBefore = versionsBefore.json().versions.length;

    const response = await app.inject({
      method: 'PATCH',
      url: `/diagrams/${diagramId}/name`,
      headers: { cookie: ownerCookie },
      payload: { name: 'Renamed Without New Version' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().diagram.dslContent).toBe(originalDslContent);

    const getResponse = await app.inject({ method: 'GET', url: `/diagrams/${diagramId}`, headers: { cookie: ownerCookie } });
    expect(getResponse.json().diagram.dslContent).toBe(originalDslContent);

    const versionsAfter = await app.inject({
      method: 'GET',
      url: `/diagrams/${diagramId}/versions`,
      headers: { cookie: ownerCookie },
    });
    expect(versionsAfter.json().versions.length).toBe(versionCountBefore);
  });
});
