import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DbSessionStore } from '../../src/auth/session-store.js';
import { buildApp } from '../../src/app.js';
import { loadConfig, type AppConfig } from '../../src/config.js';
import { getDb } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { closeTestDb, resetDatabase, seedUser } from '../helpers/setup.js';
import { SESSION_COOKIE_NAME } from '../../src/auth/session.js';

/**
 * canvas-4xo: sessions used every @fastify/session default -- an in-memory store (lost on restart,
 * unbounded, single-replica only), no expiry at all, and a session created for every anonymous
 * request. They now live in the database with an idle timeout and an absolute lifetime, anonymous
 * requests create nothing, and signing in issues a new session id (no session fixation).
 */
describe('sessions: database store, expiry, no anonymous sessions (canvas-4xo)', () => {
  let app: FastifyInstance | undefined;

  async function start(overrides: Partial<AppConfig> = {}): Promise<FastifyInstance> {
    process.env.NODE_ENV = 'test';
    app = await buildApp({ config: { ...loadConfig(), allowLocalAuth: true, ...overrides }, logger: false });
    return app;
  }

  function sessionCookie(response: { headers: Record<string, unknown> }): string | undefined {
    const setCookie = response.headers['set-cookie'];
    const all = (Array.isArray(setCookie) ? setCookie : [setCookie]).filter((c): c is string => typeof c === 'string');
    return all.find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`))?.split(';')[0];
  }

  async function login(instance: FastifyInstance): Promise<string> {
    const response = await instance.inject({
      method: 'POST',
      url: '/auth/local/login',
      payload: { email: 'session@example.com', password: 'session-pass' },
    });
    expect(response.statusCode).toBe(200);
    const cookie = sessionCookie(response);
    expect(cookie).toBeDefined();
    return cookie!;
  }

  const me = (instance: FastifyInstance, cookie: string) => instance.inject({ method: 'GET', url: '/auth/me', headers: { cookie } });
  const sessionRows = () => getDb().selectFrom('sessions').select(['id', 'data', 'expires_at']).execute();

  beforeAll(async () => {
    await runMigrations();
  });

  beforeEach(async () => {
    await resetDatabase();
    await seedUser({ email: 'session@example.com', password: 'session-pass' });
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('stores the session in the database, so it survives an API restart', async () => {
    const first = await start();
    const cookie = await login(first);
    expect(await sessionRows()).toHaveLength(1);
    await first.close();

    const second = await start();
    const response = await me(second, cookie);
    expect(response.statusCode).toBe(200);
    expect(response.json().user.email).toBe('session@example.com');
  });

  it('an anonymous request creates no session and sets no cookie', async () => {
    const instance = await start();
    const response = await instance.inject({ method: 'GET', url: '/auth/me' });
    expect(response.statusCode).toBe(401);
    expect(sessionCookie(response)).toBeUndefined();
    expect(await sessionRows()).toHaveLength(0);
  });

  it('the cookie expires after the idle timeout', async () => {
    const instance = await start({ sessionIdleMinutes: 30 });
    const response = await instance.inject({
      method: 'POST',
      url: '/auth/local/login',
      payload: { email: 'session@example.com', password: 'session-pass' },
    });
    const setCookie = String([response.headers['set-cookie']].flat().find((c) => String(c).startsWith(`${SESSION_COOKIE_NAME}=`)));
    // @fastify/session writes the expiry as Expires=, 30 minutes from now.
    const expires = Date.parse(setCookie.match(/Expires=([^;]+)/i)![1]);
    expect(Math.abs(expires - (Date.now() + 30 * 60 * 1000))).toBeLessThan(5000);
  });

  it('a session idle past its expiry is rejected and its row removed', async () => {
    const instance = await start();
    const cookie = await login(instance);
    await getDb().updateTable('sessions').set({ expires_at: Date.now() - 1000 }).execute();
    expect((await me(instance, cookie)).statusCode).toBe(401);
    expect(await sessionRows()).toHaveLength(0);
  });

  it('a session past its absolute lifetime signs the user out even while active', async () => {
    const instance = await start({ sessionMaxHours: 12 });
    const cookie = await login(instance);
    const [row] = await sessionRows();
    const data = JSON.parse(row.data);
    data.authenticatedAt = Date.now() - 13 * 60 * 60 * 1000;
    await getDb().updateTable('sessions').set({ data: JSON.stringify(data) }).where('id', '=', row.id).execute();
    expect((await me(instance, cookie)).statusCode).toBe(401);
    // ...and the old session id is gone from the store, not just ignored.
    expect((await sessionRows()).some((r) => r.id === row.id)).toBe(false);
  });

  it('signing in issues a new session id and destroys any earlier one (no fixation)', async () => {
    const instance = await start();
    const first = await login(instance);
    const [before] = await sessionRows();
    const second = await instance.inject({
      method: 'POST',
      url: '/auth/local/login',
      headers: { cookie: first },
      payload: { email: 'session@example.com', password: 'session-pass' },
    });
    const secondCookie = sessionCookie(second);
    expect(secondCookie).toBeDefined();
    expect(secondCookie).not.toBe(first);
    const ids = (await sessionRows()).map((r) => r.id);
    expect(ids).not.toContain(before.id);
    expect((await me(instance, first)).statusCode).toBe(401);
  });

  it('logout removes the session row', async () => {
    const instance = await start();
    const cookie = await login(instance);
    const response = await instance.inject({ method: 'POST', url: '/auth/logout', headers: { cookie } });
    expect(response.statusCode).toBeLessThan(400);
    expect(await sessionRows()).toHaveLength(0);
  });

  // canvas-4xo: async route handlers called reply.send() without returning reply, so Fastify sent
  // each response a second time and every onSend hook -- including the session save -- ran twice.
  // With a database store that was a second write per request, landing after the response.
  it('one request writes its session exactly once', async () => {
    const instance = await start();
    const cookie = await login(instance);
    const set = vi.spyOn(DbSessionStore.prototype, 'set');
    try {
      expect((await me(instance, cookie)).statusCode).toBe(200);
      expect(set).toHaveBeenCalledTimes(1);
    } finally {
      set.mockRestore();
    }
  });

  it('expired rows from other sessions are pruned', async () => {
    const instance = await start();
    await getDb()
      .insertInto('sessions')
      .values({ id: 'stale-session', data: '{}', expires_at: Date.now() - 60_000 })
      .execute();
    await login(instance);
    const ids = (await sessionRows()).map((r) => r.id);
    expect(ids).not.toContain('stale-session');
    expect(ids).toHaveLength(1);
  });
});
