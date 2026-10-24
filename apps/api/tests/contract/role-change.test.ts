import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, closeTestDb, resetDatabase, seedUser } from '../helpers/setup.js';

/**
 * canvas-18c: the session holds the role from sign-in and access checks read it there, so a role
 * change used to take effect only at the next sign-in -- a demoted admin kept admin rights. A role
 * change now ends the user's sessions. Also: the last active admin can't be demoted or deactivated.
 */
describe('role changes take effect immediately (canvas-18c)', () => {
  let app: FastifyInstance;
  const PASSWORD = 'role-change-pass-1'; // gitleaks:allow -- made-up test password

  async function login(email: string): Promise<string> {
    const res = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email, password: PASSWORD } });
    expect(res.statusCode).toBe(200);
    return String(res.headers['set-cookie']).split(';')[0];
  }
  const patch = (id: string, body: object, cookie: string) =>
    app.inject({ method: 'PATCH', url: `/admin/users/${id}`, payload: body, headers: { cookie } });
  const adminUsers = (cookie: string) => app.inject({ method: 'GET', url: '/admin/users', headers: { cookie } });

  beforeAll(async () => {
    app = await buildTestApp();
  });
  beforeEach(async () => {
    await resetDatabase();
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  it("a demoted admin's existing session loses admin access at once", async () => {
    await seedUser({ email: 'boss@example.com', role: 'admin', password: PASSWORD });
    const second = await seedUser({ email: 'second@example.com', role: 'admin', password: PASSWORD });
    const bossCookie = await login('boss@example.com');
    const secondCookie = await login('second@example.com');
    expect((await adminUsers(secondCookie)).statusCode).toBe(200);

    expect((await patch(second.id, { role: 'viewer' }, bossCookie)).statusCode).toBe(200);
    expect((await adminUsers(secondCookie)).statusCode).toBe(401); // session ended
    // Signing in again gives the new role.
    const fresh = await login('second@example.com');
    expect((await adminUsers(fresh)).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: fresh } })).json().user.role).toBe('viewer');
  });

  it('a promotion also ends the session, and the new sign-in has the new role', async () => {
    await seedUser({ email: 'boss@example.com', role: 'admin', password: PASSWORD });
    const viewer = await seedUser({ email: 'v@example.com', role: 'viewer', password: PASSWORD });
    const bossCookie = await login('boss@example.com');
    const viewerCookie = await login('v@example.com');
    expect((await patch(viewer.id, { role: 'architect' }, bossCookie)).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: viewerCookie } })).statusCode).toBe(401);
    const fresh = await login('v@example.com');
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: fresh } })).json().user.role).toBe('architect');
  });

  it('a personas-only change keeps the session', async () => {
    await seedUser({ email: 'boss@example.com', role: 'admin', password: PASSWORD });
    const user = await seedUser({ email: 'u@example.com', role: 'architect', password: PASSWORD });
    const bossCookie = await login('boss@example.com');
    const userCookie = await login('u@example.com');
    expect((await patch(user.id, { personas: ['Technical'] }, bossCookie)).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: userCookie } })).statusCode).toBe(200);
  });

  it('the last active admin cannot be demoted or deactivated -- including by themselves', async () => {
    const boss = await seedUser({ email: 'boss@example.com', role: 'admin', password: PASSWORD });
    const bossCookie = await login('boss@example.com');
    const demote = await patch(boss.id, { role: 'architect' }, bossCookie);
    expect(demote.statusCode).toBe(409);
    expect(demote.json().error).toMatch(/only active admin/);
    expect((await patch(boss.id, { active: false }, bossCookie)).statusCode).toBe(409);
    // Nothing changed, and the session survives.
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: bossCookie } })).json().user.role).toBe('admin');
  });

  it('with another active admin, demoting or deactivating an admin works; an inactive admin does not count', async () => {
    const boss = await seedUser({ email: 'boss@example.com', role: 'admin', password: PASSWORD });
    const other = await seedUser({ email: 'other@example.com', role: 'admin', password: PASSWORD });
    const bossCookie = await login('boss@example.com');
    expect((await patch(other.id, { active: false }, bossCookie)).statusCode).toBe(200);
    // other is now inactive, so boss is the last ACTIVE admin.
    expect((await patch(boss.id, { role: 'viewer' }, bossCookie)).statusCode).toBe(409);
    // Reactivate other; now boss may step down (and is signed out by it).
    expect((await patch(other.id, { active: true }, bossCookie)).statusCode).toBe(200);
    expect((await patch(boss.id, { role: 'viewer' }, bossCookie)).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: bossCookie } })).statusCode).toBe(401);
  });
});
