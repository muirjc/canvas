import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, closeTestDb, resetDatabase, seedFlowchartDiagramType, seedProject, seedUser } from '../helpers/setup.js';

/**
 * Contract for ShareGrant CRUD + access resolution, per
 * specs/001-diagramming-platform/contracts/api-projects-sharing-admin.md. Covers User Story 6.
 */
describe('Sharing API contract', () => {
  let app: FastifyInstance;
  let ownerCookie: string;
  let ownerId: string;
  let granteeId: string;
  let granteeCookie: string;
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
    projectId = (await seedProject()).id;
    ownerId = (await seedUser({ email: 'owner@example.com', password: 'owner-pass' })).id;
    granteeId = (await seedUser({ email: 'grantee@example.com', password: 'grantee-pass' })).id;
    ownerCookie = await login('owner@example.com', 'owner-pass');
    granteeCookie = await login('grantee@example.com', 'grantee-pass');

    const createResponse = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/diagrams`,
      headers: { cookie: ownerCookie },
      payload: { name: 'Shared Diagram', diagramTypeId: 'flowchart', initialDslContent: 'flowchart TD\n  A[Start]\n' },
    });
    diagramId = createResponse.json().diagram.id;
  });

  it('blocks a user with no grant from viewing or editing the diagram', async () => {
    const getResponse = await app.inject({ method: 'GET', url: `/diagrams/${diagramId}`, headers: { cookie: granteeCookie } });
    expect(getResponse.statusCode).toBe(403);
  });

  it('grants view access; the grantee can view but not edit', async () => {
    const grantResponse = await app.inject({
      method: 'POST',
      url: `/diagrams/${diagramId}/shares`,
      headers: { cookie: ownerCookie },
      payload: { granteeUserId: granteeId, accessLevel: 'view' },
    });
    expect(grantResponse.statusCode).toBe(201);

    const getResponse = await app.inject({ method: 'GET', url: `/diagrams/${diagramId}`, headers: { cookie: granteeCookie } });
    expect(getResponse.statusCode).toBe(200);

    const patchResponse = await app.inject({
      method: 'PATCH',
      url: `/diagrams/${diagramId}`,
      headers: { cookie: granteeCookie },
      payload: { dslContent: 'flowchart TD\n  A[Changed]\n' },
    });
    expect(patchResponse.statusCode).toBe(403);
    expect(patchResponse.json().error).toContain('edit');
  });

  it('upgrading the grant to edit allows the previously-blocked edit', async () => {
    await app.inject({
      method: 'POST',
      url: `/diagrams/${diagramId}/shares`,
      headers: { cookie: ownerCookie },
      payload: { granteeUserId: granteeId, accessLevel: 'view' },
    });
    await app.inject({
      method: 'POST',
      url: `/diagrams/${diagramId}/shares`,
      headers: { cookie: ownerCookie },
      payload: { granteeUserId: granteeId, accessLevel: 'edit' },
    });

    const patchResponse = await app.inject({
      method: 'PATCH',
      url: `/diagrams/${diagramId}`,
      headers: { cookie: granteeCookie },
      payload: { dslContent: 'flowchart TD\n  A[Changed]\n' },
    });
    expect(patchResponse.statusCode).toBe(200);
  });

  it('a diagram-level grant overrides an inherited project-level grant (most-specific wins)', async () => {
    await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/shares`,
      headers: { cookie: ownerCookie },
      payload: { granteeUserId: granteeId, accessLevel: 'edit' },
    });
    await app.inject({
      method: 'POST',
      url: `/diagrams/${diagramId}/shares`,
      headers: { cookie: ownerCookie },
      payload: { granteeUserId: granteeId, accessLevel: 'view' },
    });

    const patchResponse = await app.inject({
      method: 'PATCH',
      url: `/diagrams/${diagramId}`,
      headers: { cookie: granteeCookie },
      payload: { dslContent: 'flowchart TD\n  A[Changed]\n' },
    });
    expect(patchResponse.statusCode).toBe(403); // diagram-level "view" overrides project-level "edit"
  });

  it('revoking a grant removes access again', async () => {
    const grantResponse = await app.inject({
      method: 'POST',
      url: `/diagrams/${diagramId}/shares`,
      headers: { cookie: ownerCookie },
      payload: { granteeUserId: granteeId, accessLevel: 'view' },
    });
    const grantId = grantResponse.json().grant.id;

    const revokeResponse = await app.inject({ method: 'DELETE', url: `/shares/${grantId}`, headers: { cookie: ownerCookie } });
    expect(revokeResponse.statusCode).toBe(204);

    const getResponse = await app.inject({ method: 'GET', url: `/diagrams/${diagramId}`, headers: { cookie: granteeCookie } });
    expect(getResponse.statusCode).toBe(403);
  });

  it('rejects sharing to a non-existent user', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/diagrams/${diagramId}/shares`,
      headers: { cookie: ownerCookie },
      payload: { granteeUserId: '00000000-0000-0000-0000-000000000000', accessLevel: 'view' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('a nonexistent diagram still 404s rather than 403ing through the access-control layer', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/diagrams/00000000-0000-0000-0000-000000000000',
      headers: { cookie: ownerCookie },
    });
    expect(response.statusCode).toBe(404);
  });
});
