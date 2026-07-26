import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, closeTestDb, resetDatabase, seedUser } from '../helpers/setup.js';

/**
 * Contract for admin user/role management, per
 * specs/001-diagramming-platform/contracts/api-projects-sharing-admin.md. Covers User Story 6
 * (FR-022, FR-023).
 */
describe('Admin users API contract', () => {
  let app: FastifyInstance;
  let adminCookie: string;
  let architectCookie: string;
  let architectId: string;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  beforeEach(async () => {
    await resetDatabase();
    await seedUser({ email: 'admin@example.com', password: 'admin-pass', role: 'admin' });
    architectId = (await seedUser({ email: 'architect@example.com', password: 'architect-pass' })).id;

    const adminLogin = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email: 'admin@example.com', password: 'admin-pass' } });
    adminCookie = (Array.isArray(adminLogin.headers['set-cookie']) ? adminLogin.headers['set-cookie'][0] : adminLogin.headers['set-cookie'])!.split(';')[0];

    const architectLogin = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email: 'architect@example.com', password: 'architect-pass' } });
    architectCookie = (Array.isArray(architectLogin.headers['set-cookie']) ? architectLogin.headers['set-cookie'][0] : architectLogin.headers['set-cookie'])!.split(';')[0];
  });

  it('rejects a non-admin from listing users', async () => {
    const response = await app.inject({ method: 'GET', url: '/admin/users', headers: { cookie: architectCookie } });
    expect(response.statusCode).toBe(403);
  });

  it('lists users for an admin', async () => {
    const response = await app.inject({ method: 'GET', url: '/admin/users', headers: { cookie: adminCookie } });
    expect(response.statusCode).toBe(200);
    const emails = response.json().users.map((u: { email: string }) => u.email);
    expect(emails).toContain('architect@example.com');
  });

  it('promotes a user to admin', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/admin/users/${architectId}`,
      headers: { cookie: adminCookie },
      payload: { role: 'admin' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().user.role).toBe('admin');
  });

  it('deactivates a user', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/admin/users/${architectId}`,
      headers: { cookie: adminCookie },
      payload: { active: false },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().user.active).toBe(false);
  });

  it('returns an aggregated overview for the admin console', async () => {
    const response = await app.inject({ method: 'GET', url: '/admin/overview', headers: { cookie: adminCookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json().overview).toHaveProperty('userCount');
    expect(response.json().overview).toHaveProperty('standardsCount');
    expect(response.json().overview).toHaveProperty('libraryCount');
  });
});
