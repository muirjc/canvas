import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { runMigrations } from '../../src/db/migrate.js';
import { getDb } from '../../src/db/client.js';
import { buildTestApp, closeTestDb, resetDatabase, seedUser } from '../helpers/setup.js';

/** canvas-ez1.4: three-strikes account lockout, the audit log, and the per-IP sign-in rate limit. */
describe('Lockout and audit (canvas-ez1.4)', () => {
  let app: FastifyInstance;
  let adminCookie: string;
  let adminId: string;
  const PW = 'Granite-meadow-lantern-81';
  const WRONG = 'definitely-not-it-9';

  async function loginOn(a: FastifyInstance, email: string, password: string, headers: Record<string, string> = {}) {
    const res = await a.inject({ method: 'POST', url: '/auth/local/login', payload: { email, password }, headers });
    const raw = res.headers['set-cookie'];
    return { res, cookie: (Array.isArray(raw) ? raw[0] : raw)?.split(';')[0] ?? '' };
  }
  const login = (email: string, password: string) => loginOn(app, email, password);
  const get = (url: string, cookie?: string) => app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });
  const post = (url: string, payload?: unknown, cookie?: string) =>
    app.inject({ method: 'POST', url, payload: payload as object, headers: cookie ? { cookie } : {} });

  async function audit(query = '') {
    const res = await get(`/admin/audit${query}`, adminCookie);
    expect(res.statusCode).toBe(200);
    return res.json().events as {
      id: string;
      occurredAt: string;
      event: string;
      actorEmail: string | null;
      targetEmail: string | null;
      ip: string | null;
      detail: Record<string, unknown> | null;
    }[];
  }

  async function wrongTimes(email: string, n: number) {
    const codes: number[] = [];
    for (let i = 0; i < n; i++) codes.push((await login(email, WRONG)).res.statusCode);
    return codes;
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
    await seedUser({ email: 'victim@example.com', password: PW, role: 'architect' });
    await seedUser({ email: 'viewer@example.com', password: 'viewer-pass', role: 'viewer' });
    adminCookie = (await login('admin@example.com', 'admin-pass')).cookie;
  });

  const idOf = async (email: string) => (await getDb().selectFrom('users').select('id').where('email', '=', email).executeTakeFirstOrThrow()).id;

  describe('lockout', () => {
    it('two wrong then correct succeeds and resets the counter', async () => {
      expect(await wrongTimes('victim@example.com', 2)).toEqual([401, 401]);
      expect((await login('victim@example.com', PW)).res.statusCode).toBe(200);
      // The counter was reset: two more wrong attempts and a correct one are still fine.
      expect(await wrongTimes('victim@example.com', 2)).toEqual([401, 401]);
      expect((await login('victim@example.com', PW)).res.statusCode).toBe(200);
    });

    it('the third consecutive wrong password locks: 423, then even the correct password gets 423', async () => {
      expect(await wrongTimes('victim@example.com', 3)).toEqual([401, 401, 423]);
      const correct = await login('victim@example.com', PW);
      expect(correct.res.statusCode).toBe(423);
      expect(correct.res.json().error).toMatch(/locked/i);
      expect(correct.cookie).toBe('');
    });

    it('locking ends the user’s existing sessions', async () => {
      const existing = (await login('victim@example.com', PW)).cookie;
      expect((await get('/auth/me', existing)).statusCode).toBe(200);
      await wrongTimes('victim@example.com', 3);
      expect((await get('/auth/me', existing)).statusCode).toBe(401);
    });

    it('listUsers reports locked', async () => {
      await wrongTimes('victim@example.com', 3);
      const users = (await get('/admin/users', adminCookie)).json().users as { email: string; locked: boolean }[];
      expect(users.find((u) => u.email === 'victim@example.com')?.locked).toBe(true);
      expect(users.find((u) => u.email === 'viewer@example.com')?.locked).toBe(false);
    });

    it('admin unlock lets the correct password in again, and resets the counter', async () => {
      await wrongTimes('victim@example.com', 3);
      const id = await idOf('victim@example.com');
      const res = await post(`/admin/users/${id}/unlock`, undefined, adminCookie);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ unlocked: true });
      // Counter is back to zero: two wrongs don't lock again.
      expect(await wrongTimes('victim@example.com', 2)).toEqual([401, 401]);
      expect((await login('victim@example.com', PW)).res.statusCode).toBe(200);
    });

    it('unlocking an unlocked account reports false and records no audit row', async () => {
      const id = await idOf('victim@example.com');
      const res = await post(`/admin/users/${id}/unlock`, undefined, adminCookie);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ unlocked: false });
      expect((await audit()).filter((e) => e.event === 'account_unlocked')).toHaveLength(0);
    });

    it('unlock: 403 for non-admins, 401 unauthenticated, 404 for an unknown id', async () => {
      const id = await idOf('victim@example.com');
      const viewer = (await login('viewer@example.com', 'viewer-pass')).cookie;
      expect((await post(`/admin/users/${id}/unlock`, undefined, viewer)).statusCode).toBe(403);
      expect((await post(`/admin/users/${id}/unlock`)).statusCode).toBe(401);
      expect((await post('/admin/users/00000000-0000-4000-8000-000000000000/unlock', undefined, adminCookie)).statusCode).toBe(404);
    });

    it('unlock route does not exist when local auth is disabled', async () => {
      await runMigrations();
      const entra = await buildApp({ config: { ...loadConfig({ NODE_ENV: 'test' }), allowLocalAuth: false }, logger: false });
      try {
        expect((await entra.inject({ method: 'POST', url: `/admin/users/${adminId}/unlock` })).statusCode).toBe(404);
      } finally {
        await entra.close();
      }
    });

    it('an admin password reset also unlocks the account', async () => {
      await wrongTimes('victim@example.com', 3);
      const id = await idOf('victim@example.com');
      const reset = await post(`/admin/users/${id}/reset-password`, undefined, adminCookie);
      expect(reset.statusCode).toBe(200);
      const signIn = await login('victim@example.com', reset.json().temporaryPassword);
      expect(signIn.res.statusCode).toBe(200);
      expect(signIn.res.json().user.mustChangePassword).toBe(true);
      const users = (await get('/admin/users', adminCookie)).json().users as { email: string; locked: boolean }[];
      expect(users.find((u) => u.email === 'victim@example.com')?.locked).toBe(false);
    });

    it('an inactive user with the correct password is told the account is deactivated (403), and it does not count toward lockout', async () => {
      const id = await idOf('victim@example.com');
      await app.inject({ method: 'PATCH', url: `/admin/users/${id}`, payload: { active: false }, headers: { cookie: adminCookie } });
      for (let i = 0; i < 5; i++) {
        const { res } = await login('victim@example.com', PW);
        expect(res.statusCode).toBe(403);
        expect(res.json().error).toMatch(/deactivated/);
      }
      // A wrong password on a deactivated account still gets the generic answer.
      expect((await login('victim@example.com', 'Not-the-password-123')).res.statusCode).toBe(401); // gitleaks:allow -- made-up test password
      const users = (await get('/admin/users', adminCookie)).json().users as { email: string; locked: boolean }[];
      expect(users.find((u) => u.email === 'victim@example.com')?.locked).toBe(false);
      await app.inject({ method: 'PATCH', url: `/admin/users/${id}`, payload: { active: true }, headers: { cookie: adminCookie } });
      expect((await login('victim@example.com', PW)).res.statusCode).toBe(200);
    });

    it('wrong current password on /auth/password counts, including earlier failed sign-ins, and ends the session', async () => {
      await wrongTimes('victim@example.com', 1);
      const { cookie } = await login('victim@example.com', PW); // success resets the counter
      await wrongTimes('victim@example.com', 1);
      const change = (current: string) =>
        post('/auth/password', { currentPassword: current, newPassword: 'Velvet-orchard-signal-33' }, cookie); // gitleaks:allow -- made-up test passwords
      // 1 failed sign-in + 1 wrong current = 2; the next wrong current is the third.
      expect((await change(WRONG)).statusCode).toBe(400);
      const locked = await change(WRONG);
      expect(locked.statusCode).toBe(423);
      expect(locked.json().error).toMatch(/locked/i);
      expect((await get('/auth/me', cookie)).statusCode).toBe(401);
      expect((await login('victim@example.com', PW)).res.statusCode).toBe(423);
    });

    it('a successful password change clears the failed-attempt counter', async () => {
      const { cookie } = await login('victim@example.com', PW);
      const change = (current: string, next: string) => post('/auth/password', { currentPassword: current, newPassword: next }, cookie);
      expect((await change(WRONG, 'Velvet-orchard-signal-33')).statusCode).toBe(400);
      expect((await change(WRONG, 'Velvet-orchard-signal-33')).statusCode).toBe(400);
      expect((await change(PW, 'Velvet-orchard-signal-33')).statusCode).toBe(200);
      expect((await change('Velvet-orchard-signal-33', 'Marble-harbour-violin-77')).statusCode).toBe(200);
    });
  });

  describe('audit log', () => {
    it('records the sign-in events with actor, target and ip', async () => {
      await login('victim@example.com', PW);
      await login('nobody@example.com', WRONG);
      await login('victim@example.com', WRONG);
      const events = await audit();
      const signIn = events.find((e) => e.event === 'sign_in' && e.targetEmail === 'victim@example.com')!;
      expect(signIn).toMatchObject({ actorEmail: 'victim@example.com', targetEmail: 'victim@example.com', detail: { method: 'password' } });
      expect(signIn.ip).toBeTruthy();
      const unknown = events.find((e) => e.detail?.reason === 'unknown_email')!;
      expect(unknown).toMatchObject({ event: 'sign_in_failed', actorEmail: null, targetEmail: null, detail: { email: 'nobody@example.com' } });
      const wrong = events.find((e) => e.detail?.reason === 'wrong_password')!;
      expect(wrong).toMatchObject({ event: 'sign_in_failed', targetEmail: 'victim@example.com' });
    });

    it('records locked, inactive, account_locked and account_unlocked', async () => {
      await wrongTimes('victim@example.com', 3);
      await login('victim@example.com', PW); // locked
      const id = await idOf('victim@example.com');
      await post(`/admin/users/${id}/unlock`, undefined, adminCookie);
      await app.inject({ method: 'PATCH', url: `/admin/users/${id}`, payload: { active: false }, headers: { cookie: adminCookie } });
      await login('victim@example.com', PW); // inactive

      const events = await audit('?limit=200');
      const reasons = events.filter((e) => e.event === 'sign_in_failed').map((e) => e.detail?.reason);
      expect(reasons).toEqual(expect.arrayContaining(['wrong_password', 'locked', 'inactive']));
      expect(events.filter((e) => e.event === 'account_locked')).toHaveLength(1);
      const unlocked = events.find((e) => e.event === 'account_unlocked')!;
      expect(unlocked).toMatchObject({ actorEmail: 'admin@example.com', targetEmail: 'victim@example.com' });
    });

    it('records password_changed, password_change_failed, password_reset, user_created and user_updated', async () => {
      const created = (await post('/admin/users', { email: 'new.person@example.com', name: 'N', role: 'viewer' }, adminCookie)).json();
      const id = await idOf('victim@example.com');
      await app.inject({ method: 'PATCH', url: `/admin/users/${id}`, payload: { role: 'viewer', active: true }, headers: { cookie: adminCookie } });
      await post(`/admin/users/${id}/reset-password`, undefined, adminCookie);
      const viewer = await login('viewer@example.com', 'viewer-pass');
      await post('/auth/password', { currentPassword: WRONG, newPassword: 'Velvet-orchard-signal-33' }, viewer.cookie); // gitleaks:allow -- made-up test passwords
      await post('/auth/password', { currentPassword: 'viewer-pass', newPassword: 'Velvet-orchard-signal-33' }, viewer.cookie); // gitleaks:allow -- made-up test passwords

      const events = await audit('?limit=200');
      const by = (name: string) => events.find((e) => e.event === name)!;
      expect(by('user_created')).toMatchObject({ actorEmail: 'admin@example.com', targetEmail: 'new.person@example.com', detail: { role: 'viewer' } });
      expect(by('user_updated')).toMatchObject({ actorEmail: 'admin@example.com', targetEmail: 'victim@example.com', detail: { role: 'viewer', active: true } });
      expect(by('password_reset')).toMatchObject({ actorEmail: 'admin@example.com', targetEmail: 'victim@example.com' });
      expect(by('password_change_failed')).toMatchObject({ actorEmail: 'viewer@example.com', detail: { reason: 'wrong_password' } });
      expect(by('password_changed')).toMatchObject({ actorEmail: 'viewer@example.com', targetEmail: 'viewer@example.com' });
      expect(created.user.email).toBe('new.person@example.com');
    });

    it('never stores a password anywhere in an audit row', async () => {
      const created = (await post('/admin/users', { email: 'new.person@example.com', name: 'N', role: 'viewer' }, adminCookie)).json();
      const reset = (await post(`/admin/users/${await idOf('victim@example.com')}/reset-password`, undefined, adminCookie)).json();
      await login('victim@example.com', WRONG);
      await login('nobody@example.com', 'typed-into-wrong-field-1');
      const viewer = await login('viewer@example.com', 'viewer-pass');
      await post('/auth/password', { currentPassword: WRONG, newPassword: 'Velvet-orchard-signal-33' }, viewer.cookie); // gitleaks:allow -- made-up test passwords
      await post('/auth/password', { currentPassword: 'viewer-pass', newPassword: 'Velvet-orchard-signal-33' }, viewer.cookie); // gitleaks:allow -- made-up test passwords

      const rows = await getDb().selectFrom('audit_events').selectAll().execute();
      expect(rows.length).toBeGreaterThan(5);
      const dump = JSON.stringify(rows);
      for (const secret of [PW, WRONG, 'admin-pass', 'viewer-pass', 'typed-into-wrong-field-1', 'Velvet-orchard-signal-33', created.temporaryPassword, reset.temporaryPassword]) {
        expect(dump).not.toContain(secret);
      }
    });

    describe('GET /admin/audit', () => {
      it('is admin only', async () => {
        const viewer = (await login('viewer@example.com', 'viewer-pass')).cookie;
        expect((await get('/admin/audit', viewer)).statusCode).toBe(403);
        expect((await get('/admin/audit')).statusCode).toBe(401);
      });

      it('lists newest first', async () => {
        await login('first@example.com', WRONG);
        await login('second@example.com', WRONG);
        const events = await audit();
        expect(events[0].detail?.email).toBe('second@example.com');
        expect(events[1].detail?.email).toBe('first@example.com');
      });

      it('honours limit and rejects out-of-range values', async () => {
        for (let i = 0; i < 4; i++) await login(`u${i}@example.com`, WRONG);
        expect(await audit('?limit=2')).toHaveLength(2);
        expect((await get('/admin/audit?limit=0', adminCookie)).statusCode).toBe(400);
        expect((await get('/admin/audit?limit=201', adminCookie)).statusCode).toBe(400);
      });

      it('pages backwards with before', async () => {
        await login('a@example.com', WRONG);
        await login('b@example.com', WRONG);
        await login('c@example.com', WRONG);
        const page1 = await audit('?limit=1');
        expect(page1[0].detail?.email).toBe('c@example.com');
        const page2 = await audit(`?limit=1&before=${encodeURIComponent(page1[0].occurredAt)}`);
        expect(page2[0].detail?.email).toBe('b@example.com');
        const page3 = await audit(`?limit=200&before=${encodeURIComponent(page2[0].occurredAt)}`);
        expect(page3.map((e) => e.id)).not.toContain(page1[0].id);
        expect(page3.map((e) => e.id)).not.toContain(page2[0].id);
        expect(page3.some((e) => e.detail?.email === 'a@example.com')).toBe(true);
      });

      it('filters by userId on either side of the event', async () => {
        await wrongTimes('victim@example.com', 1);
        await login('viewer@example.com', 'viewer-pass');
        const victimId = await idOf('victim@example.com');
        const events = await audit(`?userId=${victimId}&limit=200`);
        expect(events.length).toBeGreaterThan(0);
        expect(events.every((e) => e.targetEmail === 'victim@example.com' || e.actorEmail === 'victim@example.com')).toBe(true);
        // Admin-side events targeting the user are included too.
        await post(`/admin/users/${victimId}/reset-password`, undefined, adminCookie);
        expect((await audit(`?userId=${victimId}&limit=200`)).some((e) => e.event === 'password_reset')).toBe(true);
      });
    });
  });

  describe('rate limit', () => {
    let limited: FastifyInstance;
    beforeAll(async () => {
      limited = await buildApp({ config: { ...loadConfig({ NODE_ENV: 'test' }), allowLocalAuth: true, loginRateLimitPerMinute: 3 }, logger: false });
    });
    afterAll(async () => {
      await limited.close();
    });

    const xff = (value: string) => ({ 'x-forwarded-for': value });

    it('refuses the 4th attempt from one address with 429, even with the right password', async () => {
      const codes: number[] = [];
      for (let i = 0; i < 3; i++) codes.push((await loginOn(limited, 'nobody@example.com', WRONG, xff('10.0.1.1'))).res.statusCode);
      expect(codes).toEqual([401, 401, 401]);
      expect((await loginOn(limited, 'viewer@example.com', 'viewer-pass', xff('10.0.1.1'))).res.statusCode).toBe(429);
    });

    it('allows a different last X-Forwarded-For entry', async () => {
      for (let i = 0; i < 4; i++) await loginOn(limited, 'nobody@example.com', WRONG, xff('10.0.2.1'));
      expect((await loginOn(limited, 'viewer@example.com', 'viewer-pass', xff('10.0.2.2'))).res.statusCode).toBe(200);
    });

    it('is not evaded by spoofing only the first X-Forwarded-For entry', async () => {
      const codes: number[] = [];
      for (let i = 0; i < 4; i++) codes.push((await loginOn(limited, 'nobody@example.com', WRONG, xff(`spoof-${i}, 10.0.3.1`))).res.statusCode);
      expect(codes).toEqual([401, 401, 401, 429]);
    });

    it('the default test config (entra mode) is unlimited', async () => {
      for (let i = 0; i < 30; i++) {
        expect((await login('nobody@example.com', WRONG)).res.statusCode).toBe(401);
      }
    });
  });
});
