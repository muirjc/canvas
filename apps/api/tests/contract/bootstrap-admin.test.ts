import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapAdmin } from '../../src/seed/bootstrap-admin.js';
import { getDb } from '../../src/db/client.js';
import { dbBoolean, fromDbBoolean } from '../../src/db/sql-helpers.js';
import { buildTestApp, closeTestDb, resetDatabase } from '../helpers/setup.js';

/** canvas-ez1.3: first-admin bootstrap (create) and lone-admin recovery (reset) for AUTH_MODE=local. */
describe('bootstrap-admin', () => {
  let app: FastifyInstance;
  const EMAIL = 'first.admin@example.com';
  const PW1 = 'Granite-meadow-lantern-81';
  const PW2 = 'Copper-willow-harbour-52';

  const env = (extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({
    BOOTSTRAP_ADMIN_EMAIL: EMAIL,
    BOOTSTRAP_ADMIN_PASSWORD: PW1,
    ...extra,
  });

  async function login(email: string, password: string) {
    const res = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email, password } });
    const raw = res.headers['set-cookie'];
    return { res, cookie: (Array.isArray(raw) ? raw[0] : raw)?.split(';')[0] ?? '' };
  }

  async function usersWithCredentials() {
    return getDb()
      .selectFrom('users')
      .leftJoin('local_credentials', 'local_credentials.user_id', 'users.id')
      .select(['users.id', 'users.email', 'users.role', 'users.active', 'local_credentials.must_change_password as must'])
      .execute();
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
  });

  describe('create mode', () => {
    it('creates exactly one active admin whose password signs in with mustChangePassword', async () => {
      const message = await bootstrapAdmin(env());
      expect(message).toMatch(/created admin/);

      const rows = await usersWithCredentials();
      expect(rows).toHaveLength(1);
      expect(rows[0].email).toBe(EMAIL);
      expect(rows[0].role).toBe('admin');
      expect(fromDbBoolean(rows[0].active)).toBe(true);
      expect(fromDbBoolean(rows[0].must)).toBe(true);

      const { res } = await login(EMAIL, PW1);
      expect(res.statusCode).toBe(200);
      expect(res.json().user).toMatchObject({ role: 'admin', mustChangePassword: true, localAccount: true });
    });

    it('uses BOOTSTRAP_ADMIN_NAME when given, otherwise a default name', async () => {
      await bootstrapAdmin(env({ BOOTSTRAP_ADMIN_NAME: 'Ada Admin' }));
      expect((await getDb().selectFrom('users').select('name').executeTakeFirstOrThrow()).name).toBe('Ada Admin');
    });

    it('normalizes the email (case and whitespace)', async () => {
      await bootstrapAdmin(env({ BOOTSTRAP_ADMIN_EMAIL: '  First.Admin@Example.COM ' }));
      expect((await usersWithCredentials())[0].email).toBe(EMAIL);
      expect((await login(EMAIL, PW1)).res.statusCode).toBe(200);
    });

    it('is idempotent: running again with a different password leaves the account unchanged', async () => {
      await bootstrapAdmin(env());
      const message = await bootstrapAdmin(env({ BOOTSTRAP_ADMIN_PASSWORD: PW2 }));
      expect(message).toMatch(/already exists/);
      expect(await usersWithCredentials()).toHaveLength(1);
      expect((await login(EMAIL, PW1)).res.statusCode).toBe(200);
      expect((await login(EMAIL, PW2)).res.statusCode).toBe(401);
    });

    it('treats an unset BOOTSTRAP_MODE as create', async () => {
      expect(await bootstrapAdmin(env({ BOOTSTRAP_MODE: undefined }))).toMatch(/created admin/);
    });

    it('requires an email', async () => {
      await expect(bootstrapAdmin({ BOOTSTRAP_ADMIN_PASSWORD: PW1 })).rejects.toThrow(/BOOTSTRAP_ADMIN_EMAIL is required/);
      await expect(bootstrapAdmin(env({ BOOTSTRAP_ADMIN_EMAIL: '' }))).rejects.toThrow(/BOOTSTRAP_ADMIN_EMAIL is required/);
      expect(await usersWithCredentials()).toHaveLength(0);
    });

    it('rejects a password that fails the policy and creates nothing', async () => {
      await expect(bootstrapAdmin(env({ BOOTSTRAP_ADMIN_PASSWORD: 'short' }))).rejects.toThrow(/password policy/);
      await expect(bootstrapAdmin(env({ BOOTSTRAP_ADMIN_PASSWORD: undefined }))).rejects.toThrow(/password policy/);
      await expect(bootstrapAdmin(env({ BOOTSTRAP_ADMIN_PASSWORD: 'password12345' }))).rejects.toThrow(/password policy/);
      await expect(bootstrapAdmin(env({ BOOTSTRAP_ADMIN_PASSWORD: 'xx-first.admin-xx-1' }))).rejects.toThrow(/password policy/);
      expect(await usersWithCredentials()).toHaveLength(0);
    });

    it('rejects an invalid BOOTSTRAP_MODE', async () => {
      await expect(bootstrapAdmin(env({ BOOTSTRAP_MODE: 'destroy' }))).rejects.toThrow(/BOOTSTRAP_MODE must be create or reset/);
      expect(await usersWithCredentials()).toHaveLength(0);
    });

    it('gives an existing account with no Canvas password (from Entra mode) the one-time password and the admin role', async () => {
      // An Entra-created user: a users row, no local_credentials.
      await getDb().insertInto('users').values({ id: randomUUID(), email: EMAIL, name: 'From Entra', role: 'viewer' }).execute();
      const message = await bootstrapAdmin(env());
      expect(message).toMatch(/without a Canvas password/);
      expect(message).not.toContain(PW1);
      const rows = await usersWithCredentials();
      expect(rows).toHaveLength(1);
      expect(rows[0].role).toBe('admin');
      expect(fromDbBoolean(rows[0].must as boolean)).toBe(true);
      const { res } = await login(EMAIL, PW1);
      expect(res.statusCode).toBe(200);
      expect(res.json().user.mustChangePassword).toBe(true);
    });
  });

  describe('reset mode', () => {
    it('restores a demoted, deactivated admin with a new one-time password and ends its sessions', async () => {
      await bootstrapAdmin(env());
      // The admin changes their password, then is demoted and deactivated.
      const first = await login(EMAIL, PW1);
      const changed = await app.inject({
        method: 'POST',
        url: '/auth/password',
        payload: { currentPassword: PW1, newPassword: 'Velvet-orchard-signal-33' }, // gitleaks:allow -- a made-up test password
        headers: { cookie: first.cookie },
      });
      expect(changed.statusCode).toBe(200);
      await getDb().updateTable('users').set({ role: 'viewer', active: dbBoolean(false) }).where('email', '=', EMAIL).execute();
      // Make sure a live session exists to be ended: re-activate briefly to sign in.
      await getDb().updateTable('users').set({ active: dbBoolean(true) }).where('email', '=', EMAIL).execute();
      const live = await login(EMAIL, 'Velvet-orchard-signal-33');
      expect(live.res.statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: live.cookie } })).statusCode).toBe(200);
      await getDb().updateTable('users').set({ active: dbBoolean(false) }).where('email', '=', EMAIL).execute();

      const message = await bootstrapAdmin(env({ BOOTSTRAP_MODE: 'reset', BOOTSTRAP_ADMIN_PASSWORD: PW2 }));
      expect(message).toMatch(/active, unlocked admin again/);

      const rows = await usersWithCredentials();
      expect(rows).toHaveLength(1);
      expect(rows[0].role).toBe('admin');
      expect(fromDbBoolean(rows[0].active)).toBe(true);

      expect((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: live.cookie } })).statusCode).toBe(401);
      expect((await login(EMAIL, 'Velvet-orchard-signal-33')).res.statusCode).toBe(401);
      const fresh = await login(EMAIL, PW2);
      expect(fresh.res.statusCode).toBe(200);
      expect(fresh.res.json().user).toMatchObject({ role: 'admin', mustChangePassword: true });
    });

    it('throws for an unknown email and creates nothing', async () => {
      await expect(bootstrapAdmin(env({ BOOTSTRAP_MODE: 'reset' }))).rejects.toThrow(/nothing to reset/);
      expect(await usersWithCredentials()).toHaveLength(0);
    });

    it('still enforces the password policy', async () => {
      await bootstrapAdmin(env());
      await expect(bootstrapAdmin(env({ BOOTSTRAP_MODE: 'reset', BOOTSTRAP_ADMIN_PASSWORD: 'short' }))).rejects.toThrow(/password policy/);
      expect((await login(EMAIL, PW1)).res.statusCode).toBe(200);
    });
  });

  it('never includes the password in a returned message or error', async () => {
    const messages = [
      await bootstrapAdmin(env()),
      await bootstrapAdmin(env({ BOOTSTRAP_ADMIN_PASSWORD: PW2 })),
      await bootstrapAdmin(env({ BOOTSTRAP_MODE: 'reset', BOOTSTRAP_ADMIN_PASSWORD: PW2 })),
    ];
    const err = await bootstrapAdmin(env({ BOOTSTRAP_ADMIN_PASSWORD: 'password12345' })).catch((e: Error) => e.message);
    for (const m of [...messages, err]) {
      expect(m).not.toContain(PW1);
      expect(m).not.toContain(PW2);
      expect(m).not.toContain('password12345');
    }
  });
});
