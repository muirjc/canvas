import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  buildTestApp,
  closeTestDb,
  resetDatabase,
  seedFlowchartDiagramType,
  seedProject,
  seedUser,
} from '../helpers/setup.js';
import { getPool } from '../../src/db/pool.js';

/**
 * Contract for diagram soft-delete/restore, per
 * specs/002-editing-lifecycle-enhancements/contracts/api-diagram-lifecycle.md. Covers User
 * Story 4 and its clarifications (FR-011–FR-015, FR-020, FR-021).
 */
describe('Diagram delete/restore API contract', () => {
  let app: FastifyInstance;
  let ownerCookie: string;
  let ownerId: string;
  let otherUserCookie: string;
  let adminCookie: string;
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
    ownerId = (await seedUser({ email: 'owner@example.com', password: 'owner-pass' })).id;
    // Owned by the acting user: projects became access-controlled in feature 007, so a
    // fixture project must name who works in it.
    projectId = (await seedProject('Test Project', ownerId)).id;
    await seedUser({ email: 'other@example.com', password: 'other-pass' });
    await seedUser({ email: 'admin@example.com', password: 'admin-pass', role: 'admin' });
    ownerCookie = await login('owner@example.com', 'owner-pass');
    otherUserCookie = await login('other@example.com', 'other-pass');
    adminCookie = await login('admin@example.com', 'admin-pass');

    const createResponse = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/diagrams`,
      headers: { cookie: ownerCookie },
      payload: { name: 'Deletable Diagram', diagramTypeId: 'flowchart' },
    });
    diagramId = createResponse.json().diagram.id;
  });

  it('rejects deletion from a user who is neither owner nor admin', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: `/diagrams/${diagramId}`,
      headers: { cookie: otherUserCookie },
    });
    expect(response.statusCode).toBe(403);
  });

  it('lets the owner soft-delete their own diagram', async () => {
    const response = await app.inject({ method: 'DELETE', url: `/diagrams/${diagramId}`, headers: { cookie: ownerCookie } });
    expect(response.statusCode).toBe(204);

    // Immediately behaves as not-found for the owner (FR-012).
    const getResponse = await app.inject({ method: 'GET', url: `/diagrams/${diagramId}`, headers: { cookie: ownerCookie } });
    expect(getResponse.statusCode).toBe(404);
  });

  it('is idempotent — deleting an already-deleted diagram is a no-op success', async () => {
    await app.inject({ method: 'DELETE', url: `/diagrams/${diagramId}`, headers: { cookie: ownerCookie } });
    const second = await app.inject({ method: 'DELETE', url: `/diagrams/${diagramId}`, headers: { cookie: ownerCookie } });
    expect(second.statusCode).toBe(204);
  });

  it('excludes a soft-deleted diagram from project search and the project tree', async () => {
    await app.inject({ method: 'DELETE', url: `/diagrams/${diagramId}`, headers: { cookie: ownerCookie } });

    const searchResponse = await app.inject({
      method: 'GET',
      url: `/projects/${projectId}/diagrams`,
      headers: { cookie: ownerCookie },
    });
    expect(searchResponse.json().diagrams).toHaveLength(0);

    const treeResponse = await app.inject({ method: 'GET', url: `/projects/${projectId}/tree`, headers: { cookie: ownerCookie } });
    expect(treeResponse.json().tree.diagrams).toHaveLength(0);
  });

  it('admin can delete a diagram they do not own', async () => {
    const response = await app.inject({ method: 'DELETE', url: `/diagrams/${diagramId}`, headers: { cookie: adminCookie } });
    expect(response.statusCode).toBe(204);
  });

  it('rejects a non-admin from listing or restoring deleted diagrams', async () => {
    await app.inject({ method: 'DELETE', url: `/diagrams/${diagramId}`, headers: { cookie: ownerCookie } });

    const listResponse = await app.inject({ method: 'GET', url: '/admin/deleted-diagrams', headers: { cookie: ownerCookie } });
    expect(listResponse.statusCode).toBe(403);

    const restoreResponse = await app.inject({
      method: 'POST',
      url: `/diagrams/${diagramId}/restore`,
      headers: { cookie: ownerCookie },
    });
    expect(restoreResponse.statusCode).toBe(403);
  });

  it('lists soft-deleted diagrams with metadata only — never dslContent (FR-020)', async () => {
    await app.inject({ method: 'DELETE', url: `/diagrams/${diagramId}`, headers: { cookie: ownerCookie } });

    const response = await app.inject({ method: 'GET', url: '/admin/deleted-diagrams', headers: { cookie: adminCookie } });
    expect(response.statusCode).toBe(200);
    const entries = response.json().diagrams;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: diagramId, name: 'Deletable Diagram', ownerId, projectId });
    expect(entries[0]).not.toHaveProperty('dslContent');
    expect(entries[0]).toHaveProperty('deletedAt');
  });

  it('admin can restore a soft-deleted diagram, and it records who/when (FR-021)', async () => {
    await app.inject({ method: 'DELETE', url: `/diagrams/${diagramId}`, headers: { cookie: ownerCookie } });

    const restoreResponse = await app.inject({
      method: 'POST',
      url: `/diagrams/${diagramId}/restore`,
      headers: { cookie: adminCookie },
    });
    expect(restoreResponse.statusCode).toBe(200);

    const getResponse = await app.inject({ method: 'GET', url: `/diagrams/${diagramId}`, headers: { cookie: ownerCookie } });
    expect(getResponse.statusCode).toBe(200);

    const pool = getPool();
    const { rows } = await pool.query('SELECT restored_at, restored_by_user_id FROM diagrams WHERE id = $1', [diagramId]);
    expect(rows[0].restored_at).not.toBeNull();
    expect(rows[0].restored_by_user_id).not.toBeNull();
  });

  it('reports a clear error restoring a diagram past its retention window (FR-015)', async () => {
    await app.inject({ method: 'DELETE', url: `/diagrams/${diagramId}`, headers: { cookie: ownerCookie } });
    // Simulate the retention window having elapsed.
    const pool = getPool();
    await pool.query("UPDATE diagrams SET deleted_at = now() - interval '31 days' WHERE id = $1", [diagramId]);

    const response = await app.inject({
      method: 'POST',
      url: `/diagrams/${diagramId}/restore`,
      headers: { cookie: adminCookie },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatch(/no longer available/i);
  });

  it('returns 404 restoring a diagram that was never deleted', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/diagrams/${diagramId}/restore`,
      headers: { cookie: adminCookie },
    });
    expect(response.statusCode).toBe(404);
  });
});

/**
 * Feature canvas-23t.3: the deleted-diagrams admin listing previously showed raw owner/project
 * UUIDs with no cap or search. `listDeletedDiagrams` now resolves owner/project *names* via a
 * join, bounds the response by default (mirroring version.service.ts's own
 * DEFAULT_VERSION_LIMIT/hasMore pattern — see versions.test.ts's "default cap and search"
 * describe block, which this mirrors), and supports searching by diagram, owner, or project name.
 */
describe('Deleted diagrams listing: names, search, and cap (canvas-23t.3)', () => {
  let app: FastifyInstance;
  let adminCookie: string;
  let aliceId: string;
  let bobId: string;
  let apolloProjectId: string;
  let zetaProjectId: string;

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
    aliceId = (await seedUser({ email: 'alice@example.com', name: 'Alice Anderson', password: 'alice-pass' })).id;
    bobId = (await seedUser({ email: 'bob@example.com', name: 'Bob Baker', password: 'bob-pass' })).id;
    await seedUser({ email: 'admin@example.com', password: 'admin-pass', role: 'admin' });
    apolloProjectId = (await seedProject('Project Apollo', aliceId)).id;
    zetaProjectId = (await seedProject('Project Zeta', bobId)).id;
    adminCookie = await login('admin@example.com', 'admin-pass');
  });

  async function createAndDeleteDiagram(name: string, projectId: string, ownerEmail: string, ownerPassword: string): Promise<string> {
    const ownerCookie = await login(ownerEmail, ownerPassword);
    const createResponse = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/diagrams`,
      headers: { cookie: ownerCookie },
      payload: { name, diagramTypeId: 'flowchart' },
    });
    const id = createResponse.json().diagram.id;
    await app.inject({ method: 'DELETE', url: `/diagrams/${id}`, headers: { cookie: ownerCookie } });
    return id;
  }

  it('resolves owner and project names, not just raw ids', async () => {
    const diagramId = await createAndDeleteDiagram('Flowchart One', apolloProjectId, 'alice@example.com', 'alice-pass');

    const response = await app.inject({ method: 'GET', url: '/admin/deleted-diagrams', headers: { cookie: adminCookie } });
    expect(response.statusCode).toBe(200);
    const entry = response.json().diagrams.find((d: { id: string }) => d.id === diagramId);
    expect(entry).toMatchObject({
      ownerId: aliceId,
      ownerName: 'Alice Anderson',
      projectId: apolloProjectId,
      projectName: 'Project Apollo',
    });
  });

  it('search (q=) matches diagram name, owner name, or project name', async () => {
    const flowchartOneId = await createAndDeleteDiagram('Flowchart One', apolloProjectId, 'alice@example.com', 'alice-pass');
    const diagramTwoId = await createAndDeleteDiagram('Diagram Two', zetaProjectId, 'bob@example.com', 'bob-pass');

    async function searchIds(q: string): Promise<string[]> {
      const response = await app.inject({
        method: 'GET',
        url: `/admin/deleted-diagrams?q=${encodeURIComponent(q)}`,
        headers: { cookie: adminCookie },
      });
      expect(response.statusCode).toBe(200);
      return response.json().diagrams.map((d: { id: string }) => d.id);
    }

    // By diagram name.
    expect(await searchIds('Flowchart')).toEqual([flowchartOneId]);
    // By owner name.
    expect(await searchIds('Bob Baker')).toEqual([diagramTwoId]);
    // By project name.
    expect(await searchIds('Zeta')).toEqual([diagramTwoId]);
    // Case-insensitive substring, and no match returns an empty array rather than an error.
    expect(await searchIds('apollo')).toEqual([flowchartOneId]);
    expect(await searchIds('zzzznomatch')).toEqual([]);
  });

  it('caps results at the given limit and reports hasMore, without a "more" signal when everything fits', async () => {
    const id1 = await createAndDeleteDiagram('Diagram One', apolloProjectId, 'alice@example.com', 'alice-pass');
    const id2 = await createAndDeleteDiagram('Diagram Two', apolloProjectId, 'alice@example.com', 'alice-pass');
    const id3 = await createAndDeleteDiagram('Diagram Three', apolloProjectId, 'alice@example.com', 'alice-pass');

    const capped = await app.inject({
      method: 'GET',
      url: '/admin/deleted-diagrams?limit=2',
      headers: { cookie: adminCookie },
    });
    expect(capped.statusCode).toBe(200);
    const cappedBody = capped.json();
    expect(cappedBody.diagrams).toHaveLength(2);
    expect(cappedBody.hasMore).toBe(true);
    // Newest-deleted first, mirroring listDiagramVersions' own ordering.
    expect(cappedBody.diagrams.map((d: { id: string }) => d.id)).toEqual([id3, id2]);

    const uncapped = await app.inject({
      method: 'GET',
      url: '/admin/deleted-diagrams?limit=10',
      headers: { cookie: adminCookie },
    });
    const uncappedBody = uncapped.json();
    expect(uncappedBody.diagrams).toHaveLength(3);
    expect(uncappedBody.hasMore).toBe(false);
    expect(uncappedBody.diagrams.map((d: { id: string }) => d.id)).toEqual(
      expect.arrayContaining([id1, id2, id3]),
    );
  });
});
