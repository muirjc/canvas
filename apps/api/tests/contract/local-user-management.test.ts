import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { runMigrations } from '../../src/db/migrate.js';
import { buildTestApp, closeTestDb, resetDatabase, seedUser } from '../helpers/setup.js';

/**
 * canvas-ez1.2: admin-managed local accounts -- create user with a one-time password, forced
 * password change, self-service change, admin reset, and session teardown on reset/deactivate.
 */
describe('Local user management (canvas-ez1.2)', () => {
  let app: FastifyInstance;
  let adminCookie: string;
  let adminId: string;
  const OTP = /^[a-zA-Z2-9]{4}(-[a-zA-Z2-9]{4}){3}$/;

  async function login(email: string, password: string) {
    const res = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email, password } });
    const raw = res.headers['set-cookie'];
    const cookie = (Array.isArray(raw) ? raw[0] : raw)?.split(';')[0] ?? '';
    return { res, cookie };
  }

  const get = (url: string, cookie?: string) => app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });
  const post = (url: string, payload: unknown, cookie?: string) =>
    app.inject({ method: 'POST', url, payload: payload as object, headers: cookie ? { cookie } : {} });

  async function createUser(email: string, role = 'architect') {
    const res = await post('/admin/users', { email, name: 'New Person', role }, adminCookie);
    expect(res.statusCode).toBe(201);
    return res.json() as { user: { id: string; email: string }; temporaryPassword: string };
  }

  /** Create a user and complete the forced password change; returns the settled cookie. */
  async function activatedUser(email: string, password: string) {
    const created = await createUser(email);
    const { cookie } = await login(email, created.temporaryPassword);
    const change = await post('/auth/password', { currentPassword: created.temporaryPassword, newPassword: password }, cookie);
    expect(change.statusCode).toBe(200);
    return { id: created.user.id, cookie };
  }

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  beforeEach(async () => {
    await resetDatabase();
    adminId = (await seedUser({ email: 'admin@example.com', password: 'admin-pass', role: 'admin' })).id;
    await seedUser({ email: 'architect@example.com', password: 'architect-pass', role: 'architect' });
    await seedUser({ email: 'viewer@example.com', password: 'viewer-pass', role: 'viewer' });
    adminCookie = (await login('admin@example.com', 'admin-pass')).cookie;
  });

  describe('POST /admin/users', () => {
    it('creates a user and returns a one-time password', async () => {
      const res = await post('/admin/users', { email: 'new@example.com', name: 'New Person', role: 'viewer' }, adminCookie);
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.temporaryPassword).toMatch(OTP);
      expect(body.user).toMatchObject({ email: 'new@example.com', name: 'New Person', role: 'viewer', active: true });
      expect(body.user.id).toBeTruthy();
    });

    it('lowercases and trims the email', async () => {
      const res = await post('/admin/users', { email: '  Mixed.Case@Example.COM ', name: 'M', role: 'viewer' }, adminCookie);
      expect(res.statusCode).toBe(201);
      expect(res.json().user.email).toBe('mixed.case@example.com');
    });

    it('rejects a duplicate email with 409, case-insensitively', async () => {
      expect((await post('/admin/users', { email: 'dup@example.com', name: 'A', role: 'viewer' }, adminCookie)).statusCode).toBe(201);
      expect((await post('/admin/users', { email: 'DUP@example.com', name: 'B', role: 'viewer' }, adminCookie)).statusCode).toBe(409);
      expect((await post('/admin/users', { email: 'architect@example.com', name: 'B', role: 'viewer' }, adminCookie)).statusCode).toBe(409);
    });

    it('rejects an invalid email with 400', async () => {
      for (const email of ['not-an-email', 'a@b', '']) {
        const res = await post('/admin/users', { email, name: 'X', role: 'viewer' }, adminCookie);
        expect(res.statusCode, email).toBe(400);
      }
    });

    it('rejects an unknown role with 400', async () => {
      const res = await post('/admin/users', { email: 'r@example.com', name: 'X', role: 'superuser' }, adminCookie);
      expect(res.statusCode).toBe(400);
    });

    it('is forbidden to architects and viewers, and requires authentication', async () => {
      const payload = { email: 'x@example.com', name: 'X', role: 'viewer' };
      const architect = (await login('architect@example.com', 'architect-pass')).cookie;
      const viewer = (await login('viewer@example.com', 'viewer-pass')).cookie;
      expect((await post('/admin/users', payload, architect)).statusCode).toBe(403);
      expect((await post('/admin/users', payload, viewer)).statusCode).toBe(403);
      expect((await post('/admin/users', payload)).statusCode).toBe(401);
    });

    it('does not exist when local auth is disabled', async () => {
      await runMigrations();
      const entraApp = await buildApp({ config: { ...loadConfig({ NODE_ENV: 'test' }), allowLocalAuth: false }, logger: false });
      try {
        const payload = { email: 'x@example.com', name: 'X', role: 'viewer' };
        expect((await entraApp.inject({ method: 'POST', url: '/admin/users', payload })).statusCode).toBe(404);
        expect((await entraApp.inject({ method: 'POST', url: `/admin/users/${adminId}/reset-password` })).statusCode).toBe(404);
        // The routes that exist regardless are untouched.
        expect((await entraApp.inject({ method: 'GET', url: '/admin/users' })).statusCode).toBe(401);
      } finally {
        await entraApp.close();
      }
    });
  });

  describe('first sign-in with a one-time password', () => {
    it('flags mustChangePassword and blocks every non-/auth route until changed', async () => {
      const created = await createUser('first@example.com');
      const { res, cookie } = await login('first@example.com', created.temporaryPassword);
      expect(res.statusCode).toBe(200);
      expect(res.json().user).toMatchObject({ mustChangePassword: true, localAccount: true });

      const blocked = await get('/projects', cookie);
      expect(blocked.statusCode).toBe(403);
      expect(blocked.json().code).toBe('PASSWORD_CHANGE_REQUIRED');

      const me = await get('/auth/me', cookie);
      expect(me.statusCode).toBe(200);
      expect(me.json().user.mustChangePassword).toBe(true);
    });

    it('signs in case-insensitively on email', async () => {
      const created = await createUser('casey@example.com');
      expect((await login('CASEY@Example.com', created.temporaryPassword)).res.statusCode).toBe(200);
    });

    it('does not flag accounts that never had a one-time password', async () => {
      const { res, cookie } = await login('architect@example.com', 'architect-pass');
      expect(res.json().user.mustChangePassword).toBe(false);
      expect((await get('/projects', cookie)).statusCode).toBe(200);
    });
  });

  describe('POST /auth/password', () => {
    let tempPassword: string;
    let cookie: string;
    const EMAIL = 'changer@example.com';

    beforeEach(async () => {
      const created = await createUser(EMAIL);
      tempPassword = created.temporaryPassword;
      cookie = (await login(EMAIL, tempPassword)).cookie;
    });

    const change = (currentPassword: string, newPassword: string, c = cookie) =>
      post('/auth/password', { currentPassword, newPassword }, c);

    it('requires authentication', async () => {
      expect((await change(tempPassword, 'a-fine-new-password', '')).statusCode).toBe(401);
    });

    it('rejects a wrong current password', async () => {
      const res = await change('wrong-current-pass', 'a-fine-new-password');
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/current password/i);
    });

    it('rejects a too-short new password', async () => {
      const res = await change(tempPassword, 'short1');
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/at least 12/);
    });

    it('rejects a common password', async () => {
      const res = await change(tempPassword, 'password12345');
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/too common/);
    });

    it('rejects a password containing the email local part', async () => {
      const res = await change(tempPassword, 'my-Changer-secret-1');
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/email/);
    });

    it('rejects a new password equal to the current one', async () => {
      const res = await change(tempPassword, tempPassword);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/different/);
    });

    it('a rejected change leaves the gate and the old password in place', async () => {
      await change(tempPassword, 'short1');
      expect((await get('/projects', cookie)).statusCode).toBe(403);
      expect((await login(EMAIL, tempPassword)).res.statusCode).toBe(200);
    });

    it('succeeds, clears mustChangePassword and unblocks the session', async () => {
      const res = await change(tempPassword, 'a-fine-new-password');
      expect(res.statusCode).toBe(200);
      expect(res.json().user.mustChangePassword).toBe(false);
      expect((await get('/projects', cookie)).statusCode).toBe(200);
      expect((await get('/auth/me', cookie)).json().user.mustChangePassword).toBe(false);
    });

    it('swaps which password signs in', async () => {
      await change(tempPassword, 'a-fine-new-password');
      expect((await login(EMAIL, tempPassword)).res.statusCode).toBe(401);
      const fresh = await login(EMAIL, 'a-fine-new-password');
      expect(fresh.res.statusCode).toBe(200);
      expect(fresh.res.json().user.mustChangePassword).toBe(false);
    });

    it("ends the user's other sessions but keeps the current one", async () => {
      const other = (await login(EMAIL, tempPassword)).cookie;
      expect(other).not.toBe(cookie);
      expect((await get('/auth/me', other)).statusCode).toBe(200);

      expect((await change(tempPassword, 'a-fine-new-password')).statusCode).toBe(200);

      expect((await get('/auth/me', other)).statusCode).toBe(401);
      expect((await get('/auth/me', cookie)).statusCode).toBe(200);
    });

    it("does not end other users' sessions", async () => {
      const adminStill = await get('/auth/me', adminCookie);
      expect(adminStill.statusCode).toBe(200);
      await change(tempPassword, 'a-fine-new-password');
      expect((await get('/auth/me', adminCookie)).statusCode).toBe(200);
    });
  });

  describe('POST /admin/users/:id/reset-password', () => {
    it('returns a one-time password, ends the target sessions and forces a change', async () => {
      const target = await activatedUser('target@example.com', 'orig-secret-phrase-1');
      expect((await get('/projects', target.cookie)).statusCode).toBe(200);

      const res = await post(`/admin/users/${target.id}/reset-password`, undefined, adminCookie);
      expect(res.statusCode).toBe(200);
      const { temporaryPassword } = res.json();
      expect(temporaryPassword).toMatch(OTP);

      expect((await get('/projects', target.cookie)).statusCode).toBe(401);
      expect((await login('target@example.com', 'orig-secret-phrase-1')).res.statusCode).toBe(401);

      const next = await login('target@example.com', temporaryPassword);
      expect(next.res.statusCode).toBe(200);
      expect(next.res.json().user.mustChangePassword).toBe(true);
      expect((await get('/projects', next.cookie)).statusCode).toBe(403);
    });

    it('keeps the admin signed in', async () => {
      const target = await activatedUser('target@example.com', 'orig-secret-phrase-1');
      await post(`/admin/users/${target.id}/reset-password`, undefined, adminCookie);
      expect((await get('/auth/me', adminCookie)).statusCode).toBe(200);
    });

    it('creates credentials for a user who had none', async () => {
      const { getDb } = await import('../../src/db/client.js');
      const { randomUUID } = await import('node:crypto');
      const id = randomUUID();
      await getDb().insertInto('users').values({ id, name: 'Sso Person', email: 'sso@example.com', role: 'viewer' }).execute();

      const list = (await get('/admin/users', adminCookie)).json().users as { email: string; hasPassword: boolean }[];
      expect(list.find((u) => u.email === 'sso@example.com')?.hasPassword).toBe(false);

      const res = await post(`/admin/users/${id}/reset-password`, undefined, adminCookie);
      expect(res.statusCode).toBe(200);
      const signIn = await login('sso@example.com', res.json().temporaryPassword);
      expect(signIn.res.statusCode).toBe(200);
      expect(signIn.res.json().user.mustChangePassword).toBe(true);

      const after = (await get('/admin/users', adminCookie)).json().users as { email: string; hasPassword: boolean }[];
      expect(after.find((u) => u.email === 'sso@example.com')?.hasPassword).toBe(true);
    });

    it('rejects resetting your own account with 400', async () => {
      const res = await post(`/admin/users/${adminId}/reset-password`, undefined, adminCookie);
      expect(res.statusCode).toBe(400);
      expect((await login('admin@example.com', 'admin-pass')).res.statusCode).toBe(200);
    });

    it('404s for an unknown id', async () => {
      const res = await post('/admin/users/00000000-0000-4000-8000-000000000000/reset-password', undefined, adminCookie);
      expect(res.statusCode).toBe(404);
    });

    it('is forbidden to non-admins and requires authentication', async () => {
      const architect = (await login('architect@example.com', 'architect-pass')).cookie;
      const url = `/admin/users/${adminId}/reset-password`;
      expect((await post(url, undefined, architect)).statusCode).toBe(403);
      expect((await post(url, undefined)).statusCode).toBe(401);
      expect((await login('admin@example.com', 'admin-pass')).res.statusCode).toBe(200);
    });
  });

  describe('user admin side effects', () => {
    it('deactivating a user ends their sessions and blocks sign-in', async () => {
      const target = await activatedUser('leaver@example.com', 'orig-secret-phrase-2');
      expect((await get('/projects', target.cookie)).statusCode).toBe(200);

      const res = await app.inject({ method: 'PATCH', url: `/admin/users/${target.id}`, payload: { active: false }, headers: { cookie: adminCookie } });
      expect(res.statusCode).toBe(200);

      expect((await get('/projects', target.cookie)).statusCode).toBe(401);
      expect((await login('leaver@example.com', 'orig-secret-phrase-2')).res.statusCode).toBe(401);
    });

    it('a role change does not end the sessions', async () => {
      const target = await activatedUser('stayer@example.com', 'orig-secret-phrase-3');
      await app.inject({ method: 'PATCH', url: `/admin/users/${target.id}`, payload: { role: 'viewer' }, headers: { cookie: adminCookie } });
      expect((await get('/auth/me', target.cookie)).statusCode).toBe(200);
    });

    it('GET /admin/users reports hasPassword per user', async () => {
      const { getDb } = await import('../../src/db/client.js');
      const { randomUUID } = await import('node:crypto');
      await getDb().insertInto('users').values({ id: randomUUID(), name: 'No Pw', email: 'nopw@example.com', role: 'viewer' }).execute();
      await createUser('haspw@example.com');

      const users = (await get('/admin/users', adminCookie)).json().users as { email: string; hasPassword: boolean }[];
      const byEmail = Object.fromEntries(users.map((u) => [u.email, u.hasPassword]));
      expect(byEmail['admin@example.com']).toBe(true);
      expect(byEmail['haspw@example.com']).toBe(true);
      expect(byEmail['nopw@example.com']).toBe(false);
    });
  });
});
