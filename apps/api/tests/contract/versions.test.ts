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
    const architect = await seedUser({ email: 'architect@example.com', password: 'architect-pass' });
    // Owned by the acting user: projects became access-controlled in feature 007, so a
    // fixture project must name who works in it.
    projectId = (await seedProject('Test Project', architect.id)).id;
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

/**
 * Feature 006, User Story 5: version history is bounded by default and searchable.
 *
 * The listing query previously returned every version with no bound, so a long-lived diagram
 * produced an unbounded response — capping only in the UI would have hidden that rather than
 * fixed it (research §9).
 */
describe('Diagram version listing: default cap and search', () => {
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
    const architect = await seedUser({ email: 'architect@example.com', password: 'architect-pass' });
    // Owned by the acting user: projects became access-controlled in feature 007, so a
    // fixture project must name who works in it.
    projectId = (await seedProject('Test Project', architect.id)).id;
    const response = await app.inject({
      method: 'POST',
      url: '/auth/local/login',
      payload: { email: 'architect@example.com', password: 'architect-pass' },
    });
    const setCookie = response.headers['set-cookie'];
    sessionCookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(';')[0];
  });

  /** Creates a diagram and saves it `saves` further times, yielding saves+1 versions. */
  async function diagramWithVersions(saves: number): Promise<string> {
    const created = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/diagrams`,
      headers: { cookie: sessionCookie },
      payload: { name: 'History', diagramTypeId: 'flowchart', initialDslContent: 'flowchart TD\n  A[V1]\n' },
    });
    const id = created.json().diagram.id;
    for (let i = 2; i <= saves + 1; i += 1) {
      await app.inject({
        method: 'PATCH',
        url: `/diagrams/${id}`,
        headers: { cookie: sessionCookie },
        payload: { dslContent: `flowchart TD\n  A[V${i}]\n` },
      });
    }
    return id;
  }

  async function listVersions(diagramId: string, query = '') {
    return app.inject({
      method: 'GET',
      url: `/diagrams/${diagramId}/versions${query}`,
      headers: { cookie: sessionCookie },
    });
  }

  it('returns at most five versions by default, however many exist', async () => {
    const id = await diagramWithVersions(9); // 10 versions
    const body = (await listVersions(id)).json();
    expect(body.versions).toHaveLength(5);
    // Newest first is unchanged.
    expect(body.versions[0].sequenceNumber).toBe(10);
  });

  it('signals that older versions exist beyond those returned', async () => {
    const id = await diagramWithVersions(9);
    expect((await listVersions(id)).json().hasMore).toBe(true);
  });

  it('returns all versions with no "more exist" signal when there are five or fewer', async () => {
    // The boundary the spec calls out: exactly five must not imply hidden versions.
    const id = await diagramWithVersions(4); // 5 versions
    const body = (await listVersions(id)).json();
    expect(body.versions).toHaveLength(5);
    expect(body.hasMore).toBe(false);
  });

  it('finds an older version by search that the default response omits', async () => {
    const id = await diagramWithVersions(9);
    const defaults = (await listVersions(id)).json().versions.map((v: { sequenceNumber: number }) => v.sequenceNumber);
    expect(defaults).not.toContain(2);

    const found = (await listVersions(id, '?q=2')).json().versions;
    expect(found.some((v: { sequenceNumber: number }) => v.sequenceNumber === 2)).toBe(true);
  });

  it('a version found by search is restorable exactly as a recent one is', async () => {
    const id = await diagramWithVersions(9);
    const target = (await listVersions(id, '?q=2')).json().versions.find(
      (v: { sequenceNumber: number }) => v.sequenceNumber === 2,
    );
    const restore = await app.inject({
      method: 'POST',
      url: `/diagrams/${id}/versions/${target.id}/restore`,
      headers: { cookie: sessionCookie },
    });
    expect(restore.statusCode).toBe(200);
  });

  it('returns an empty result rather than an error when a search matches nothing', async () => {
    const id = await diagramWithVersions(3);
    const response = await listVersions(id, '?q=zzzznomatch');
    expect(response.statusCode).toBe(200);
    expect(response.json().versions).toEqual([]);
  });

  it('honours an explicit limit', async () => {
    const id = await diagramWithVersions(9);
    expect((await listVersions(id, '?limit=2')).json().versions).toHaveLength(2);
  });

  it('still requires access to the diagram', async () => {
    const id = await diagramWithVersions(1);
    const response = await app.inject({ method: 'GET', url: `/diagrams/${id}/versions` });
    expect(response.statusCode).toBe(401);
  });
});
