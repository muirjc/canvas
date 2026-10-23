import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { runMigrations } from '../../src/db/migrate.js';
import { getDb } from '../../src/db/client.js';
import { timeStep, totpCode } from '../../src/auth/totp.js';
import { buildTestApp, closeTestDb, resetDatabase, seedUser } from '../helpers/setup.js';

/** canvas-ez1.5: two-step verification (TOTP + recovery codes) for Canvas-password accounts. */
describe('MFA (canvas-ez1.5)', () => {
  let app: FastifyInstance; // mfaRequired false (the default test config)
  let strict: FastifyInstance; // mfaRequired true
  let adminCookie: string;
  const PW = 'Granite-meadow-lantern-81'; // gitleaks:allow
  const T0 = new Date('2026-06-01T12:00:10Z'); // 10s into a 30s step, so +-1 step never straddles a boundary

  type Inject = FastifyInstance['inject'];
  async function loginOn(a: FastifyInstance, email: string, password: string) {
    const res = await a.inject({ method: 'POST', url: '/auth/local/login', payload: { email, password } });
    const raw = res.headers['set-cookie'];
    return { res, cookie: (Array.isArray(raw) ? raw[0] : raw)?.split(';')[0] ?? '' };
  }
  const call = (a: FastifyInstance, method: 'GET' | 'POST', url: string, payload?: unknown, cookie?: string): ReturnType<Inject> =>
    a.inject({ method, url, payload: payload as object, headers: cookie ? { cookie } : {} });
  const verifyOn = (a: FastifyInstance, cookie: string, code: string) => call(a, 'POST', '/auth/mfa/verify', { code }, cookie);
  const currentCode = (secret: string, offset = 0) => totpCode(secret, timeStep(Date.now()) + offset);
  const badCode = (secret: string) => {
    const valid = [-1, 0, 1].map((o) => currentCode(secret, o));
    return ['000000', '111111', '222222'].find((c) => !valid.includes(c))!;
  };
  const idOf = async (email: string) => (await getDb().selectFrom('users').select('id').where('email', '=', email).executeTakeFirstOrThrow()).id;

  /** Enrols `email` (already seeded with PW) on `a`; returns the secret, recovery codes and the signed-in cookie. */
  async function enrol(a: FastifyInstance, email: string) {
    const { cookie } = await loginOn(a, email, PW);
    const start = await call(a, 'POST', '/auth/mfa/enroll', undefined, cookie);
    expect(start.statusCode).toBe(200);
    const secret = start.json().secret as string;
    const confirm = await call(a, 'POST', '/auth/mfa/enroll/confirm', { code: currentCode(secret) }, cookie);
    expect(confirm.statusCode).toBe(200);
    return { secret, recoveryCodes: confirm.json().recoveryCodes as string[], cookie };
  }

  /** Password step for an enrolled user; returns the pending-session cookie. */
  async function passwordStep(a: FastifyInstance, email: string) {
    const { res, cookie } = await loginOn(a, email, PW);
    expect(res.json()).toEqual({ mfaRequired: true });
    return cookie;
  }

  async function auditEvents() {
    const res = await call(app, 'GET', '/admin/audit?limit=200', undefined, adminCookie);
    expect(res.statusCode).toBe(200);
    return res.json().events as { event: string; actorEmail: string | null; targetEmail: string | null; detail: Record<string, unknown> | null }[];
  }

  beforeAll(async () => {
    app = await buildTestApp();
    strict = await buildApp({ config: { ...loadConfig({ NODE_ENV: 'test' }), allowLocalAuth: true, mfaRequired: true }, logger: false });
  });
  afterAll(async () => {
    await strict.close();
    await app.close();
    await closeTestDb();
  });
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    await resetDatabase();
    await seedUser({ email: 'admin@example.com', password: 'admin-pass', role: 'admin' }); // gitleaks:allow
    await seedUser({ email: 'ann@example.com', password: PW, role: 'architect' });
    await seedUser({ email: 'viewer@example.com', password: 'viewer-pass', role: 'viewer' }); // gitleaks:allow
    adminCookie = (await loginOn(app, 'admin@example.com', 'admin-pass')).cookie; // gitleaks:allow
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('enrolment', () => {
    it('enroll returns a secret; confirm with a correct code returns 10 recovery codes and enables MFA', async () => {
      const { cookie } = await loginOn(app, 'ann@example.com', PW);
      const start = await call(app, 'POST', '/auth/mfa/enroll', undefined, cookie);
      expect(start.statusCode).toBe(200);
      const { secret, otpauthUri } = start.json();
      expect(secret).toMatch(/^[A-Z2-7]{32}$/);
      expect(otpauthUri).toContain('otpauth://totp/');
      expect(otpauthUri).toContain(`secret=${secret}`);

      const confirm = await call(app, 'POST', '/auth/mfa/enroll/confirm', { code: currentCode(secret) }, cookie);
      expect(confirm.statusCode).toBe(200);
      const body = confirm.json();
      expect(body.recoveryCodes).toHaveLength(10);
      expect(new Set(body.recoveryCodes).size).toBe(10);
      for (const c of body.recoveryCodes) expect(c).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);
      expect(body.user).toMatchObject({ mfaEnabled: true, mustEnrollMfa: false });

      const users = (await call(app, 'GET', '/admin/users', undefined, adminCookie)).json().users as { email: string; mfaEnabled: boolean }[];
      expect(users.find((u) => u.email === 'ann@example.com')?.mfaEnabled).toBe(true);
      expect(users.find((u) => u.email === 'viewer@example.com')?.mfaEnabled).toBe(false);
    });

    it('confirm with a wrong code is 400 and leaves MFA off', async () => {
      const { cookie } = await loginOn(app, 'ann@example.com', PW);
      const { secret } = (await call(app, 'POST', '/auth/mfa/enroll', undefined, cookie)).json();
      const res = await call(app, 'POST', '/auth/mfa/enroll/confirm', { code: badCode(secret) }, cookie);
      expect(res.statusCode).toBe(400);
      expect((await loginOn(app, 'ann@example.com', PW)).res.json().user).toBeTruthy();
    });

    it('confirm before enroll is 400', async () => {
      const { cookie } = await loginOn(app, 'ann@example.com', PW);
      expect((await call(app, 'POST', '/auth/mfa/enroll/confirm', { code: '123456' }, cookie)).statusCode).toBe(400);
    });

    it('enrolling again once enabled is 409, for enroll and confirm', async () => {
      const { cookie, secret } = await enrol(app, 'ann@example.com');
      expect((await call(app, 'POST', '/auth/mfa/enroll', undefined, cookie)).statusCode).toBe(409);
      expect((await call(app, 'POST', '/auth/mfa/enroll/confirm', { code: currentCode(secret, 1) }, cookie)).statusCode).toBe(409);
    });

    it('restarting before confirming issues a new secret and the old one stops working', async () => {
      const { cookie } = await loginOn(app, 'ann@example.com', PW);
      const first = (await call(app, 'POST', '/auth/mfa/enroll', undefined, cookie)).json().secret as string;
      const second = (await call(app, 'POST', '/auth/mfa/enroll', undefined, cookie)).json().secret as string;
      expect(second).not.toBe(first);
      expect((await call(app, 'POST', '/auth/mfa/enroll/confirm', { code: currentCode(first) }, cookie)).statusCode).toBe(400);
      expect((await call(app, 'POST', '/auth/mfa/enroll/confirm', { code: currentCode(second) }, cookie)).statusCode).toBe(200);
    });

    it('enrol endpoints require authentication', async () => {
      expect((await call(app, 'POST', '/auth/mfa/enroll')).statusCode).toBe(401);
      expect((await call(app, 'POST', '/auth/mfa/enroll/confirm', { code: '123456' })).statusCode).toBe(401);
    });

    it('stores the secret encrypted, and never in the audit log', async () => {
      const { secret, recoveryCodes } = await enrol(app, 'ann@example.com');
      const row = await getDb().selectFrom('user_mfa').selectAll().executeTakeFirstOrThrow();
      expect(row.secret_encrypted).toMatch(/^v1:/);
      expect(row.secret_encrypted).not.toContain(secret);
      const hashes = JSON.stringify(await getDb().selectFrom('mfa_recovery_codes').selectAll().execute());
      for (const code of recoveryCodes) expect(hashes).not.toContain(code);

      await verifyOn(app, await passwordStep(app, 'ann@example.com'), currentCode(secret, 1));
      await verifyOn(app, await passwordStep(app, 'ann@example.com'), badCode(secret));
      const dump = JSON.stringify(await getDb().selectFrom('audit_events').selectAll().execute());
      expect(dump).not.toContain(secret);
      for (const code of recoveryCodes) expect(dump).not.toContain(code);
      expect(dump).not.toContain(currentCode(secret, 1));
    });
  });

  describe('required enrolment (mfaRequired: true)', () => {
    it('a signed-in user without MFA is told to enrol and is blocked until they do', async () => {
      const { res, cookie } = await loginOn(strict, 'ann@example.com', PW);
      expect(res.json().user).toMatchObject({ mustEnrollMfa: true, mfaEnabled: false });
      const blocked = await call(strict, 'GET', '/projects', undefined, cookie);
      expect(blocked.statusCode).toBe(403);
      expect(blocked.json().code).toBe('MFA_ENROLLMENT_REQUIRED');
      expect((await call(strict, 'GET', '/auth/me', undefined, cookie)).statusCode).toBe(200);

      const secret = (await call(strict, 'POST', '/auth/mfa/enroll', undefined, cookie)).json().secret as string;
      expect((await call(strict, 'POST', '/auth/mfa/enroll/confirm', { code: currentCode(secret) }, cookie)).statusCode).toBe(200);
      expect((await call(strict, 'GET', '/projects', undefined, cookie)).statusCode).toBe(200);
    });

    it('PASSWORD_CHANGE_REQUIRED takes precedence for a one-time-password user', async () => {
      const created = (await call(app, 'POST', '/admin/users', { email: 'otp@example.com', name: 'Otp', role: 'viewer' }, adminCookie)).json();
      const { res, cookie } = await loginOn(strict, 'otp@example.com', created.temporaryPassword);
      expect(res.json().user).toMatchObject({ mustChangePassword: true, mustEnrollMfa: true });
      const blocked = await call(strict, 'GET', '/projects', undefined, cookie);
      expect(blocked.statusCode).toBe(403);
      expect(blocked.json().code).toBe('PASSWORD_CHANGE_REQUIRED');

      const change = await call(strict, 'POST', '/auth/password', { currentPassword: created.temporaryPassword, newPassword: 'Velvet-orchard-signal-33' }, cookie); // gitleaks:allow
      expect(change.statusCode).toBe(200);
      const next = await call(strict, 'GET', '/projects', undefined, cookie);
      expect(next.statusCode).toBe(403);
      expect(next.json().code).toBe('MFA_ENROLLMENT_REQUIRED');
    });

    it('the default config does not require enrolment', async () => {
      const { res, cookie } = await loginOn(app, 'ann@example.com', PW);
      expect(res.json().user.mustEnrollMfa).toBe(false);
      expect((await call(app, 'GET', '/projects', undefined, cookie)).statusCode).toBe(200);
    });
  });

  describe('two-step sign-in', () => {
    it('the password step returns only {mfaRequired:true}: no user, and nothing is accessible', async () => {
      await enrol(app, 'ann@example.com');
      const { res, cookie } = await loginOn(app, 'ann@example.com', PW);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ mfaRequired: true });
      expect((await call(app, 'GET', '/auth/me', undefined, cookie)).statusCode).toBe(401);
      expect((await call(app, 'GET', '/projects', undefined, cookie)).statusCode).toBe(401);
    });

    // canvas-ao2: the pending (password done, code not yet) session counts as a session that arrived.
    it('/auth/session-check reports pending-mfa between the two steps', async () => {
      await enrol(app, 'ann@example.com');
      const pending = await passwordStep(app, 'ann@example.com');
      expect((await call(app, 'GET', '/auth/session-check', undefined, pending)).json()).toEqual({ session: 'pending-mfa' });
    });

    it('a current code completes sign-in', async () => {
      const { secret } = await enrol(app, 'ann@example.com');
      const pending = await passwordStep(app, 'ann@example.com');
      const res = await verifyOn(app, pending, currentCode(secret, 1));
      expect(res.statusCode).toBe(200);
      expect(res.json().user).toMatchObject({ email: 'ann@example.com', mfaEnabled: true, localAccount: true });
      const cookie = String(res.headers['set-cookie']).split(';')[0];
      expect((await call(app, 'GET', '/projects', undefined, cookie)).statusCode).toBe(200);
      expect((await call(app, 'GET', '/auth/me', undefined, cookie)).statusCode).toBe(200);
    });

    it('the same code cannot be used twice (replay), nor the one used to confirm enrolment', async () => {
      const { secret } = await enrol(app, 'ann@example.com');
      // Enrolment consumed the current step.
      expect((await verifyOn(app, await passwordStep(app, 'ann@example.com'), currentCode(secret))).statusCode).toBe(401);
      const next = currentCode(secret, 1);
      expect((await verifyOn(app, await passwordStep(app, 'ann@example.com'), next)).statusCode).toBe(200);
      expect((await verifyOn(app, await passwordStep(app, 'ann@example.com'), next)).statusCode).toBe(401);
    });

    it('a recovery code works once, then not again, and the remaining count drops', async () => {
      const { recoveryCodes } = await enrol(app, 'ann@example.com');
      const first = await verifyOn(app, await passwordStep(app, 'ann@example.com'), recoveryCodes[0]);
      expect(first.statusCode).toBe(200);
      expect(first.json().recoveryCodesRemaining).toBe(9);
      expect((await verifyOn(app, await passwordStep(app, 'ann@example.com'), recoveryCodes[0])).statusCode).toBe(401);
      const second = await verifyOn(app, await passwordStep(app, 'ann@example.com'), recoveryCodes[1].toUpperCase());
      expect(second.statusCode).toBe(200);
      expect(second.json().recoveryCodesRemaining).toBe(8);
    });

    it('wrong codes count toward lockout, and re-entering the password does not reset the count', async () => {
      const { secret } = await enrol(app, 'ann@example.com');
      const wrong = badCode(secret);
      expect((await verifyOn(app, await passwordStep(app, 'ann@example.com'), wrong)).statusCode).toBe(401);
      const pending = await passwordStep(app, 'ann@example.com');
      expect((await verifyOn(app, pending, wrong)).statusCode).toBe(401);
      // Password again (must not reset the counter), then the third wrong code.
      const third = await verifyOn(app, await passwordStep(app, 'ann@example.com'), wrong);
      expect(third.statusCode).toBe(423);
      expect((await loginOn(app, 'ann@example.com', PW)).res.statusCode).toBe(423);
      // Even the right code is refused once locked.
      expect((await verifyOn(app, pending, currentCode(secret, 1))).statusCode).toBe(423);
    });

    it('a successful second step resets the counter', async () => {
      const { secret } = await enrol(app, 'ann@example.com');
      const wrong = badCode(secret);
      await verifyOn(app, await passwordStep(app, 'ann@example.com'), wrong);
      await verifyOn(app, await passwordStep(app, 'ann@example.com'), wrong);
      expect((await verifyOn(app, await passwordStep(app, 'ann@example.com'), currentCode(secret, 1))).statusCode).toBe(200);
      await verifyOn(app, await passwordStep(app, 'ann@example.com'), wrong);
      expect((await verifyOn(app, await passwordStep(app, 'ann@example.com'), wrong)).statusCode).toBe(401);
    });

    it('a wrong password does not reveal anything about MFA', async () => {
      await enrol(app, 'ann@example.com');
      const res = await loginOn(app, 'ann@example.com', 'wrong-password-123'); // gitleaks:allow
      expect(res.res.statusCode).toBe(401);
      expect(res.res.json()).toEqual({ error: 'Invalid email or password' });
    });

    it('verify after 5 minutes pending is 401, even with the right code', async () => {
      const { secret } = await enrol(app, 'ann@example.com');
      const pending = await passwordStep(app, 'ann@example.com');
      vi.setSystemTime(new Date(T0.getTime() + 5 * 60_000 + 1000));
      const res = await verifyOn(app, pending, currentCode(secret, 1));
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toMatch(/timed out/i);
    });

    it('verify with no pending sign-in is 401', async () => {
      await enrol(app, 'ann@example.com');
      expect((await verifyOn(app, '', '123456')).statusCode).toBe(401);
      const { cookie } = await loginOn(app, 'viewer@example.com', 'viewer-pass'); // gitleaks:allow
      expect((await verifyOn(app, cookie, '123456')).statusCode).toBe(401);
    });

    it('a deactivated user cannot finish the second step', async () => {
      const { secret } = await enrol(app, 'ann@example.com');
      const pending = await passwordStep(app, 'ann@example.com');
      const id = await idOf('ann@example.com');
      await app.inject({ method: 'PATCH', url: `/admin/users/${id}`, payload: { active: false }, headers: { cookie: adminCookie } });
      expect((await verifyOn(app, pending, currentCode(secret, 1))).statusCode).toBe(401);
    });
  });

  describe('POST /admin/users/:id/reset-mfa', () => {
    it('ends sessions, removes MFA, and the next sign-in needs no code', async () => {
      const { cookie: annSession } = await enrol(app, 'ann@example.com');
      expect((await call(app, 'GET', '/auth/me', undefined, annSession)).statusCode).toBe(200);
      const id = await idOf('ann@example.com');

      const res = await call(app, 'POST', `/admin/users/${id}/reset-mfa`, undefined, adminCookie);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ reset: true });
      expect((await call(app, 'GET', '/auth/me', undefined, annSession)).statusCode).toBe(401);

      const users = (await call(app, 'GET', '/admin/users', undefined, adminCookie)).json().users as { email: string; mfaEnabled: boolean }[];
      expect(users.find((u) => u.email === 'ann@example.com')?.mfaEnabled).toBe(false);
      expect(await getDb().selectFrom('mfa_recovery_codes').selectAll().execute()).toHaveLength(0);

      const next = await loginOn(app, 'ann@example.com', PW);
      expect(next.res.json().user).toMatchObject({ email: 'ann@example.com', mfaEnabled: false });
    });

    it('with mfaRequired the user must enrol again afterwards', async () => {
      await enrol(app, 'ann@example.com');
      await call(app, 'POST', `/admin/users/${await idOf('ann@example.com')}/reset-mfa`, undefined, adminCookie);
      const { res, cookie } = await loginOn(strict, 'ann@example.com', PW);
      expect(res.json().user).toMatchObject({ mfaEnabled: false, mustEnrollMfa: true });
      expect((await call(strict, 'GET', '/projects', undefined, cookie)).json().code).toBe('MFA_ENROLLMENT_REQUIRED');
    });

    it('is 400 on your own account, 403 for non-admins, 401 unauthenticated, 404 unknown', async () => {
      const adminId = await idOf('admin@example.com');
      const annId = await idOf('ann@example.com');
      expect((await call(app, 'POST', `/admin/users/${adminId}/reset-mfa`, undefined, adminCookie)).statusCode).toBe(400);
      const viewer = (await loginOn(app, 'viewer@example.com', 'viewer-pass')).cookie; // gitleaks:allow
      expect((await call(app, 'POST', `/admin/users/${annId}/reset-mfa`, undefined, viewer)).statusCode).toBe(403);
      expect((await call(app, 'POST', `/admin/users/${annId}/reset-mfa`)).statusCode).toBe(401);
      expect((await call(app, 'POST', '/admin/users/00000000-0000-4000-8000-000000000000/reset-mfa', undefined, adminCookie)).statusCode).toBe(404);
    });

    it('does not exist when local auth is disabled', async () => {
      await runMigrations();
      const entra = await buildApp({ config: { ...loadConfig({ NODE_ENV: 'test' }), allowLocalAuth: false }, logger: false });
      try {
        const res = await entra.inject({ method: 'POST', url: `/admin/users/${await idOf('ann@example.com')}/reset-mfa` });
        expect(res.statusCode).toBe(404);
      } finally {
        await entra.close();
      }
    });
  });

  describe('audit', () => {
    it('records mfa_enrolled, mfa_reset, wrong_mfa_code and the sign-in method', async () => {
      const { secret, recoveryCodes } = await enrol(app, 'ann@example.com');
      await verifyOn(app, await passwordStep(app, 'ann@example.com'), badCode(secret));
      await verifyOn(app, await passwordStep(app, 'ann@example.com'), currentCode(secret, 1));
      await verifyOn(app, await passwordStep(app, 'ann@example.com'), recoveryCodes[0]);
      await call(app, 'POST', `/admin/users/${await idOf('ann@example.com')}/reset-mfa`, undefined, adminCookie);
      await loginOn(app, 'ann@example.com', PW);

      const events = await auditEvents();
      expect(events.find((e) => e.event === 'mfa_enrolled')).toMatchObject({ actorEmail: 'ann@example.com', targetEmail: 'ann@example.com' });
      expect(events.find((e) => e.event === 'mfa_reset')).toMatchObject({ actorEmail: 'admin@example.com', targetEmail: 'ann@example.com' });
      expect(events.find((e) => e.detail?.reason === 'wrong_mfa_code')).toMatchObject({ event: 'sign_in_failed', targetEmail: 'ann@example.com' });
      const methods = events.filter((e) => e.event === 'sign_in' && e.targetEmail === 'ann@example.com').map((e) => e.detail?.method);
      expect(methods).toEqual(expect.arrayContaining(['password+authenticator', 'password+recovery_code', 'password']));
    });
  });
});
