import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, closeTestDb, resetDatabase, seedFlowchartDiagramType, seedProject, seedUser } from '../helpers/setup.js';

/**
 * Contract for canvas-hbk: a diagram's free-text description (PATCH /diagrams/:id/description)
 * plus the ownerName/description fields now returned by GET /diagrams/:id and
 * POST /projects/:id/diagrams. Mirrors diagram-rename.test.ts's style/structure — the closest
 * precedent: a similarly-shaped PATCH /diagrams/:id/<field> route with the same access model.
 */
describe('Diagram description and ownerName API contract', () => {
  let app: FastifyInstance;
  let ownerCookie: string;
  let ownerId: string;
  let outsiderCookie: string;
  let projectId: string;
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
    ownerId = (await seedUser({ email: 'owner@example.com', password: 'owner-pass', name: 'Ozzy Owner' })).id;
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
  });

  it('createDiagram returns description: null and the resolved ownerName', async () => {
    const createResponse = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/diagrams`,
      headers: { cookie: ownerCookie },
      payload: { name: 'Another Diagram', diagramTypeId: 'flowchart' },
    });
    expect(createResponse.statusCode).toBe(201);
    const { diagram } = createResponse.json();
    expect(diagram.description).toBeNull();
    expect(diagram.ownerName).toBe('Ozzy Owner');
  });

  it('GET /diagrams/:id returns description: null and the resolved ownerName for a freshly created diagram', async () => {
    const response = await app.inject({ method: 'GET', url: `/diagrams/${diagramId}`, headers: { cookie: ownerCookie } });
    expect(response.statusCode).toBe(200);
    const { diagram } = response.json();
    expect(diagram.description).toBeNull();
    expect(diagram.ownerName).toBe('Ozzy Owner');
  });

  it('lets a user with edit access set the description, and the change persists', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/diagrams/${diagramId}/description`,
      headers: { cookie: ownerCookie },
      payload: { description: 'A diagram describing the checkout flow.' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().diagram.description).toBe('A diagram describing the checkout flow.');

    const getResponse = await app.inject({ method: 'GET', url: `/diagrams/${diagramId}`, headers: { cookie: ownerCookie } });
    expect(getResponse.json().diagram.description).toBe('A diagram describing the checkout flow.');
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
      url: `/diagrams/${diagramId}/description`,
      headers: { cookie: viewerCookie },
      payload: { description: 'Hijacked description' },
    });
    expect(response.statusCode).toBe(403);

    const getResponse = await app.inject({ method: 'GET', url: `/diagrams/${diagramId}`, headers: { cookie: ownerCookie } });
    expect(getResponse.json().diagram.description).toBeNull();
  });

  it('rejects a user with no access to the diagram at all', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/diagrams/${diagramId}/description`,
      headers: { cookie: outsiderCookie },
      payload: { description: 'Hijacked description' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('accepts an empty string, clearing the description back to null', async () => {
    const setResponse = await app.inject({
      method: 'PATCH',
      url: `/diagrams/${diagramId}/description`,
      headers: { cookie: ownerCookie },
      payload: { description: 'Set first' },
    });
    expect(setResponse.statusCode).toBe(200);
    expect(setResponse.json().diagram.description).toBe('Set first');

    const clearResponse = await app.inject({
      method: 'PATCH',
      url: `/diagrams/${diagramId}/description`,
      headers: { cookie: ownerCookie },
      payload: { description: '' },
    });
    expect(clearResponse.statusCode).toBe(200);
    expect(clearResponse.json().diagram.description).toBeNull();

    const getResponse = await app.inject({ method: 'GET', url: `/diagrams/${diagramId}`, headers: { cookie: ownerCookie } });
    expect(getResponse.json().diagram.description).toBeNull();
  });

  it('rejects a non-string description with 400', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/diagrams/${diagramId}/description`,
      headers: { cookie: ownerCookie },
      payload: { description: 12345 },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a missing description with 400', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/diagrams/${diagramId}/description`,
      headers: { cookie: ownerCookie },
      payload: {},
    });
    expect(response.statusCode).toBe(400);
  });

  it('returns 404 for a nonexistent diagram', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/diagrams/00000000-0000-0000-0000-000000000000/description',
      headers: { cookie: ownerCookie },
      payload: { description: 'Anything' },
    });
    expect(response.statusCode).toBe(404);
  });

  it('requires authentication', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/diagrams/${diagramId}/description`,
      payload: { description: 'X' },
    });
    expect(response.statusCode).toBe(401);
  });
});
