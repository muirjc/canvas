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
    projectId = (await seedProject()).id;
    ownerId = (await seedUser({ email: 'owner@example.com', password: 'owner-pass' })).id;
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
