import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, closeTestDb, resetDatabase, seedFlowchartDiagramType, seedProject, seedUser } from '../helpers/setup.js';

/**
 * Contract for diagram version list + restore, per
 * specs/001-diagramming-platform/contracts/api-diagrams.md. Covers User Story 4 (FR-017:
 * versions are append-only; "restoring" creates a new version, never rewrites history).
 */
describe('Diagram versions API contract', () => {
  let app: FastifyInstance;
  let sessionCookie: string;
  let projectId: string;

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
    projectId = (await seedProject()).id;
    await seedUser({ email: 'architect@example.com', password: 'architect-pass' });
    const response = await app.inject({
      method: 'POST',
      url: '/auth/local/login',
      payload: { email: 'architect@example.com', password: 'architect-pass' },
    });
    const setCookie = response.headers['set-cookie'];
    sessionCookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(';')[0];
  });

  it('lists versions newest-first and restoring an old one appends a new version (no rewrite)', async () => {
    const createResponse = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/diagrams`,
      headers: { cookie: sessionCookie },
      payload: { name: 'Versioned', diagramTypeId: 'flowchart', initialDslContent: 'flowchart TD\n  A[V1]\n' },
    });
    const diagram = createResponse.json().diagram;

    await app.inject({
      method: 'PATCH',
      url: `/diagrams/${diagram.id}`,
      headers: { cookie: sessionCookie },
      payload: { dslContent: 'flowchart TD\n  A[V2]\n' },
    });
    await app.inject({
      method: 'PATCH',
      url: `/diagrams/${diagram.id}`,
      headers: { cookie: sessionCookie },
      payload: { dslContent: 'flowchart TD\n  A[V3]\n' },
    });

    const listResponse = await app.inject({ method: 'GET', url: `/diagrams/${diagram.id}/versions`, headers: { cookie: sessionCookie } });
    expect(listResponse.statusCode).toBe(200);
    const versions = listResponse.json().versions;
    expect(versions).toHaveLength(3);
    expect(versions[0].sequenceNumber).toBe(3); // newest first
    const v1 = versions[2];
    expect(v1.sequenceNumber).toBe(1);

    const restoreResponse = await app.inject({
      method: 'POST',
      url: `/diagrams/${diagram.id}/versions/${v1.id}/restore`,
      headers: { cookie: sessionCookie },
    });
    expect(restoreResponse.statusCode).toBe(200);
    expect(restoreResponse.json().diagram.dslContent).toContain('V1');

    const versionsAfterRestore = (
      await app.inject({ method: 'GET', url: `/diagrams/${diagram.id}/versions`, headers: { cookie: sessionCookie } })
    ).json().versions;
    // Restoring appended a 4th version — it did not delete or rewrite versions 1-3.
    expect(versionsAfterRestore).toHaveLength(4);
    expect(versionsAfterRestore[0].sequenceNumber).toBe(4);
  });

  it('returns 404 restoring a version id that does not belong to the diagram', async () => {
    const createResponse = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/diagrams`,
      headers: { cookie: sessionCookie },
      payload: { name: 'D1', diagramTypeId: 'flowchart' },
    });
    const diagram = createResponse.json().diagram;

    const response = await app.inject({
      method: 'POST',
      url: `/diagrams/${diagram.id}/versions/00000000-0000-0000-0000-000000000000/restore`,
      headers: { cookie: sessionCookie },
    });
    expect(response.statusCode).toBe(404);
  });
});
