import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/db/client.js';
import { buildTestApp, closeTestDb, resetDatabase, seedUser } from '../helpers/setup.js';

/**
 * Contract for canvas-cyt: GET /users/search?q= -- the share dialog's user picker. Any signed-in
 * user (viewer included) may search; active users only; name OR email, case-insensitive substring;
 * LIKE wildcards in q are literal; at most 20, ordered by name then email.
 */
describe('User search API contract (canvas-cyt)', () => {
  let app: FastifyInstance;
  let cookie: string;

  async function login(email: string, password: string): Promise<string> {
    const response = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email, password } });
    const setCookie = response.headers['set-cookie'];
    return (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(';')[0];
  }

  async function search(q: string | undefined, withCookie: string | null = cookie) {
    const url = q === undefined ? '/users/search' : `/users/search?q=${encodeURIComponent(q)}`;
    return app.inject({ method: 'GET', url, headers: withCookie ? { cookie: withCookie } : {} });
  }

  const names = async (q: string) => (await search(q)).json().users.map((u: { name: string }) => u.name);

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  beforeEach(async () => {
    await resetDatabase();
    await seedUser({ email: 'viewer@example.com', name: 'Searcher Viewer', role: 'viewer', password: 'viewer-pass' });
    cookie = await login('viewer@example.com', 'viewer-pass');
  });

  it('rejects an anonymous request', async () => {
    expect((await search('x', null)).statusCode).toBe(401);
  });

  it('lets a viewer search', async () => {
    await seedUser({ email: 'zed@example.com', name: 'Zed Zebra', password: 'p' });
    const response = await search('zebra');
    expect(response.statusCode).toBe(200);
    expect(response.json().users).toHaveLength(1);
  });

  it('matches by name substring and by email substring, case-insensitively', async () => {
    await seedUser({ email: 'one@example.com', name: 'Alice McDonald', password: 'p' });
    await seedUser({ email: 'Bob.Smith@Contoso.COM', name: 'Robert', password: 'p' });
    expect(await names('mcdon')).toEqual(['Alice McDonald']);
    expect(await names('MCDONALD')).toEqual(['Alice McDonald']);
    expect(await names('bob.smith@contoso')).toEqual(['Robert']);
    expect(await names('CONTOSO.com')).toEqual(['Robert']);
    expect(await names('nobody-matches-this')).toEqual([]);
  });

  it('never returns a deactivated user', async () => {
    const { id } = await seedUser({ email: 'gone@example.com', name: 'Gone Person', password: 'p' });
    expect(await names('gone')).toEqual(['Gone Person']);
    await getDb().updateTable('users').set({ active: false as never }).where('id', '=', id).execute();
    expect(await names('gone')).toEqual([]);
  });

  it('orders by name, then email', async () => {
    await seedUser({ email: 'b2@ord.test', name: 'Bravo', password: 'p' });
    await seedUser({ email: 'b1@ord.test', name: 'Bravo', password: 'p' });
    await seedUser({ email: 'c@ord.test', name: 'Charlie', password: 'p' });
    await seedUser({ email: 'a@ord.test', name: 'Alpha', password: 'p' });
    const users = (await search('ord.test')).json().users as { name: string; email: string }[];
    expect(users.map((u) => u.email)).toEqual(['a@ord.test', 'b1@ord.test', 'b2@ord.test', 'c@ord.test']);
  });

  it('returns at most 20 of 25 matches, the first 20 by name', async () => {
    for (let i = 0; i < 25; i++) {
      const n = String(i).padStart(2, '0');
      await seedUser({ email: `bulk${n}@many.test`, name: `Bulk ${n}`, password: 'p' });
    }
    const users = (await search('many.test')).json().users as { name: string }[];
    expect(users).toHaveLength(20);
    expect(users[0].name).toBe('Bulk 00');
    expect(users[19].name).toBe('Bulk 19');
  });

  it('treats %, _ and backslash in q literally', async () => {
    await seedUser({ email: 'u1@wild.test', name: 'a_b', password: 'p' });
    await seedUser({ email: 'u2@wild.test', name: 'axb', password: 'p' });
    await seedUser({ email: 'u3@wild.test', name: 'a100%b', password: 'p' });
    await seedUser({ email: 'u4@wild.test', name: 'back\\slash', password: 'p' });
    expect(await names('a_b')).toEqual(['a_b']); // `_` is not "any one char" (would also match axb)
    expect(await names('a%b')).toEqual([]); // `%` is not "anything"
    expect(await names('100%')).toEqual(['a100%b']);
    expect(await names('%')).toEqual(['a100%b']);
    expect(await names('k\\s')).toEqual(['back\\slash']);
    expect(await names('\\')).toEqual(['back\\slash']);
  });

  it('validates q: missing, empty and 101 chars are 400; whitespace-only is an empty list', async () => {
    expect((await search(undefined)).statusCode).toBe(400);
    expect((await search('')).statusCode).toBe(400);
    expect((await search('a'.repeat(101))).statusCode).toBe(400);
    expect((await search('a'.repeat(100))).statusCode).toBe(200);
    const blank = await search('   ');
    expect(blank.statusCode).toBe(200);
    expect(blank.json()).toEqual({ users: [] });
  });

  it('returns only id, name and email', async () => {
    await seedUser({ email: 'shape@example.com', name: 'Shape Check', role: 'admin', password: 'p' });
    const users = (await search('shape check')).json().users;
    expect(users).toHaveLength(1);
    expect(Object.keys(users[0]).sort()).toEqual(['email', 'id', 'name']);
  });
});
