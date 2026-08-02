import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, closeTestDb, resetDatabase, seedFlowchartDiagramType, seedProject, seedUser } from '../helpers/setup.js';
import { getPool } from '../../src/db/pool.js';

/**
 * Contract for canvas-228.2: soft-deleting an empty project (DELETE /projects/:id) and admin
 * recovery (GET /admin/deleted-projects, POST /projects/:id/restore) — mirrors
 * diagram-delete-restore.test.ts exactly, since the feature mirrors that pattern exactly.
 */
describe('Project delete/restore API contract', () => {
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
    projectId = (await seedProject('Deletable Project', ownerId)).id;
    await seedUser({ email: 'other@example.com', password: 'other-pass' });
    await seedUser({ email: 'admin@example.com', password: 'admin-pass', role: 'admin' });
    ownerCookie = await login('owner@example.com', 'owner-pass');
    otherUserCookie = await login('other@example.com', 'other-pass');
    adminCookie = await login('admin@example.com', 'admin-pass');
  });

  it('rejects deletion from a user who is neither owner nor admin', async () => {
    const response = await app.inject({ method: 'DELETE', url: `/projects/${projectId}`, headers: { cookie: otherUserCookie } });
    expect(response.statusCode).toBe(403);
  });

  it('lets the owner soft-delete their own empty project', async () => {
    const response = await app.inject({ method: 'DELETE', url: `/projects/${projectId}`, headers: { cookie: ownerCookie } });
    expect(response.statusCode).toBe(204);

    // Immediately behaves as not-found for regular access.
    const getResponse = await app.inject({ method: 'GET', url: `/projects/${projectId}`, headers: { cookie: ownerCookie } });
    expect(getResponse.statusCode).toBe(404);
  });

  it('excludes a soft-deleted project from the project list', async () => {
    await app.inject({ method: 'DELETE', url: `/projects/${projectId}`, headers: { cookie: ownerCookie } });

    const response = await app.inject({ method: 'GET', url: '/projects', headers: { cookie: ownerCookie } });
    expect(response.json().projects).toEqual([]);
  });

  it('is idempotent — deleting an already-deleted project is a no-op success', async () => {
    await app.inject({ method: 'DELETE', url: `/projects/${projectId}`, headers: { cookie: ownerCookie } });
    const second = await app.inject({ method: 'DELETE', url: `/projects/${projectId}`, headers: { cookie: ownerCookie } });
    expect(second.statusCode).toBe(204);
  });

  it('admin can delete a project they do not own', async () => {
    const response = await app.inject({ method: 'DELETE', url: `/projects/${projectId}`, headers: { cookie: adminCookie } });
    expect(response.statusCode).toBe(204);
  });

  it('rejects deleting a project that still has a diagram, with a clear message', async () => {
    await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/diagrams`,
      headers: { cookie: ownerCookie },
      payload: { name: 'Still Here', diagramTypeId: 'flowchart' },
    });

    const response = await app.inject({ method: 'DELETE', url: `/projects/${projectId}`, headers: { cookie: ownerCookie } });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatch(/no diagrams/i);

    // Not a silent no-op — the project must still be there afterward.
    const getResponse = await app.inject({ method: 'GET', url: `/projects/${projectId}`, headers: { cookie: ownerCookie } });
    expect(getResponse.statusCode).toBe(200);
  });

  it('rejects deleting a project that still has a child project', async () => {
    await app.inject({
      method: 'POST',
      url: '/projects',
      headers: { cookie: ownerCookie },
      payload: { name: 'Child', parentProjectId: projectId },
    });

    const response = await app.inject({ method: 'DELETE', url: `/projects/${projectId}`, headers: { cookie: ownerCookie } });
    expect(response.statusCode).toBe(409);
  });

  it('returns 404 deleting a nonexistent project', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: '/projects/00000000-0000-0000-0000-000000000000',
      headers: { cookie: ownerCookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it('rejects a non-admin from listing or restoring deleted projects', async () => {
    await app.inject({ method: 'DELETE', url: `/projects/${projectId}`, headers: { cookie: ownerCookie } });

    const listResponse = await app.inject({ method: 'GET', url: '/admin/deleted-projects', headers: { cookie: ownerCookie } });
    expect(listResponse.statusCode).toBe(403);

    const restoreResponse = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/restore`,
      headers: { cookie: ownerCookie },
    });
    expect(restoreResponse.statusCode).toBe(403);
  });

  it('lists soft-deleted projects with metadata only', async () => {
    await app.inject({ method: 'DELETE', url: `/projects/${projectId}`, headers: { cookie: ownerCookie } });

    const response = await app.inject({ method: 'GET', url: '/admin/deleted-projects', headers: { cookie: adminCookie } });
    expect(response.statusCode).toBe(200);
    const entries = response.json().projects;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: projectId, name: 'Deletable Project', ownerId });
    expect(entries[0]).toHaveProperty('deletedAt');
  });

  it('admin can restore a soft-deleted project, and it records who/when', async () => {
    await app.inject({ method: 'DELETE', url: `/projects/${projectId}`, headers: { cookie: ownerCookie } });

    const restoreResponse = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/restore`,
      headers: { cookie: adminCookie },
    });
    expect(restoreResponse.statusCode).toBe(200);

    const getResponse = await app.inject({ method: 'GET', url: `/projects/${projectId}`, headers: { cookie: ownerCookie } });
    expect(getResponse.statusCode).toBe(200);

    const pool = getPool();
    const { rows } = await pool.query('SELECT restored_at, restored_by_user_id FROM projects WHERE id = $1', [projectId]);
    expect(rows[0].restored_at).not.toBeNull();
    expect(rows[0].restored_by_user_id).not.toBeNull();
  });

  it('reports a clear error restoring a project past its retention window', async () => {
    await app.inject({ method: 'DELETE', url: `/projects/${projectId}`, headers: { cookie: ownerCookie } });
    const pool = getPool();
    await pool.query("UPDATE projects SET deleted_at = now() - interval '31 days' WHERE id = $1", [projectId]);

    const response = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/restore`,
      headers: { cookie: adminCookie },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatch(/no longer available/i);
  });

  it('returns 404 restoring a project that was never deleted', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/restore`,
      headers: { cookie: adminCookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it('requires authentication', async () => {
    const response = await app.inject({ method: 'DELETE', url: `/projects/${projectId}` });
    expect(response.statusCode).toBe(401);
  });
});
