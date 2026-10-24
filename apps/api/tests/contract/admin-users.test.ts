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

  /** Regression test (canvas-jtm.3): a personas-only PATCH (no role/active) used to 500 —
   *  "syntax error at or near 'where'" — found via manual verification, not by this suite, since
   *  the two tests above each always set role or active and never personas alone. The bug was in
   *  updateUser's Kysely conversion: with both role and active omitted, `.set({role: undefined,
   *  active: undefined})` compiled to a completely empty SET clause. */
  it('sets personas without touching role or active', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/admin/users/${architectId}`,
      headers: { cookie: adminCookie },
      payload: { personas: ['Solution', 'Technical'] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().user).toMatchObject({ role: 'architect', active: true, personas: ['Solution', 'Technical'] });
  });

  describe('personas (canvas-2sk)', () => {
    const patch = (payload: unknown) =>
      app.inject({ method: 'PATCH', url: `/admin/users/${architectId}`, headers: { cookie: adminCookie }, payload: payload as object });
    const listed = async () =>
      ((await app.inject({ method: 'GET', url: '/admin/users', headers: { cookie: adminCookie } })).json().users as { id: string; personas: string[] }[]).find(
        (u) => u.id === architectId,
      )!.personas;

    it('sets, replaces and clears personas, and the user list reflects each change', async () => {
      expect((await patch({ personas: ['Business', 'Enterprise'] })).json().user.personas).toEqual(['Business', 'Enterprise']);
      expect(await listed()).toEqual(['Business', 'Enterprise']);
      expect((await patch({ personas: ['Technical'] })).json().user.personas).toEqual(['Technical']);
      expect(await listed()).toEqual(['Technical']);
      const cleared = await patch({ personas: [] });
      expect(cleared.statusCode).toBe(200);
      expect(cleared.json().user.personas).toEqual([]);
      expect(await listed()).toEqual([]);
    });

    it('accepts all four personas', async () => {
      const all = ['Business', 'Enterprise', 'Solution', 'Technical'];
      expect((await patch({ personas: all })).json().user.personas).toEqual(all);
    });

    it('keeps the order given', async () => {
      expect((await patch({ personas: ['Technical', 'Business'] })).json().user.personas).toEqual(['Technical', 'Business']);
    });

    it('rejects an unknown persona, a duplicate, five items, or a non-array with 400, changing nothing', async () => {
      await patch({ personas: ['Solution'] });
      for (const bad of [['Wizard'], ['Business', 'Business'], ['Business', 'Enterprise', 'Solution', 'Technical', 'Business'], 'Business', [1], ['business']]) {
        expect((await patch({ personas: bad })).statusCode, JSON.stringify(bad)).toBe(400);
      }
      expect(await listed()).toEqual(['Solution']);
    });

    it('createLocalUser stores the personas it is given, and rejects bad ones', async () => {
      const ok = await app.inject({
        method: 'POST',
        url: '/admin/users',
        headers: { cookie: adminCookie },
        payload: { email: 'persona.person@example.com', name: 'P', role: 'viewer', personas: ['Enterprise', 'Solution'] },
      });
      expect(ok.statusCode).toBe(201);
      expect(ok.json().user.personas).toEqual(['Enterprise', 'Solution']);
      const users = (await app.inject({ method: 'GET', url: '/admin/users', headers: { cookie: adminCookie } })).json().users as { email: string; personas: string[] }[];
      expect(users.find((u) => u.email === 'persona.person@example.com')?.personas).toEqual(['Enterprise', 'Solution']);

      const bad = await app.inject({
        method: 'POST',
        url: '/admin/users',
        headers: { cookie: adminCookie },
        payload: { email: 'bad.persona@example.com', name: 'B', role: 'viewer', personas: ['Wizard'] },
      });
      expect(bad.statusCode).toBe(400);
    });

    it("an admin's persona change reaches a signed-in user on their next /auth/me (page load), without signing in again", async () => {
      // architect's session was created in beforeEach, before any persona was assigned.
      await patch({ personas: ['Technical'] });
      const live = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: architectCookie } });
      expect(live.json().user.personas).toEqual(['Technical']);
      await patch({ personas: [] });
      expect((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: architectCookie } })).json().user.personas).toEqual([]);
    });
  });

  it('returns an aggregated overview for the admin console', async () => {
    const response = await app.inject({ method: 'GET', url: '/admin/overview', headers: { cookie: adminCookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json().overview).toHaveProperty('userCount');
    expect(response.json().overview).toHaveProperty('standardsCount');
    expect(response.json().overview).toHaveProperty('libraryCount');
  });
});
