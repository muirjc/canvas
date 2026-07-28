import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, closeTestDb, resetDatabase, seedUser } from '../helpers/setup.js';

/**
 * Feature 004, Foundational: the platform-wide AI chat enable/disable toggle (FR-020). Separate
 * from *which* AI provider is configured (research.md §5) — this is the admin-only, no-redeploy
 * governance switch SC-007 requires.
 */
describe('AI settings API contract', () => {
  let app: FastifyInstance;
  let adminCookie: string;
  let architectCookie: string;

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
    await seedUser({ email: 'architect@example.com', password: 'architect-pass' });

    const adminLogin = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email: 'admin@example.com', password: 'admin-pass' } });
    adminCookie = (Array.isArray(adminLogin.headers['set-cookie']) ? adminLogin.headers['set-cookie'][0] : adminLogin.headers['set-cookie'])!.split(';')[0];

    const architectLogin = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email: 'architect@example.com', password: 'architect-pass' } });
    architectCookie = (Array.isArray(architectLogin.headers['set-cookie']) ? architectLogin.headers['set-cookie'][0] : architectLogin.headers['set-cookie'])!.split(';')[0];
  });

  it('defaults to chatEnabled: false', async () => {
    const response = await app.inject({ method: 'GET', url: '/admin/ai-settings', headers: { cookie: adminCookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json().chatEnabled).toBe(false);
  });

  it('rejects a non-admin from reading or changing the setting', async () => {
    const getResponse = await app.inject({ method: 'GET', url: '/admin/ai-settings', headers: { cookie: architectCookie } });
    expect(getResponse.statusCode).toBe(403);

    const patchResponse = await app.inject({
      method: 'PATCH',
      url: '/admin/ai-settings',
      headers: { cookie: architectCookie },
      payload: { chatEnabled: true },
    });
    expect(patchResponse.statusCode).toBe(403);
  });

  it('lets an admin enable and disable AI chat, visible immediately on the next request', async () => {
    const enableResponse = await app.inject({
      method: 'PATCH',
      url: '/admin/ai-settings',
      headers: { cookie: adminCookie },
      payload: { chatEnabled: true },
    });
    expect(enableResponse.statusCode).toBe(200);
    expect(enableResponse.json().chatEnabled).toBe(true);

    const getResponse = await app.inject({ method: 'GET', url: '/admin/ai-settings', headers: { cookie: adminCookie } });
    expect(getResponse.json().chatEnabled).toBe(true);

    const disableResponse = await app.inject({
      method: 'PATCH',
      url: '/admin/ai-settings',
      headers: { cookie: adminCookie },
      payload: { chatEnabled: false },
    });
    expect(disableResponse.json().chatEnabled).toBe(false);
  });
});
