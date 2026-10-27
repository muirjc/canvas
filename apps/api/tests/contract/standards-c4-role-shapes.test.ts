import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checkStandardDefinition } from '@canvas/diagram-core';
import { buildTestApp, closeTestDb, resetDatabase, seedDiagramType, seedUser } from '../helpers/setup.js';
import { getDb } from '../../src/db/client.js';
import { seedDiagramTypes } from '../../src/seed/diagram-types.seed.js';
import { BUILT_IN_STANDARDS } from '../../src/seed/reference-standards.seed.js';

/**
 * canvas-syd: a C4 element's shape follows from its DSL keyword (its role), so a standard kind that
 * lists a shape its role can't be drawn as is rejected on save, and no seeded standard may ever be
 * unsaveable.
 */
const kindBody = (role: string) => ({
  name: 'C4 rules',
  elementKinds: [{ id: 'person', label: 'Person', match: { role, external: true }, shapes: ['person'], approvedFills: [] }],
});

describe('C4 kind role/shape definition check', () => {
  let app: FastifyInstance;
  let cookie: string;

  beforeAll(async () => {
    app = await buildTestApp();
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });
  beforeEach(async () => {
    await resetDatabase();
    await seedDiagramType('c4-context', 'c4');
    await seedUser({ email: 'admin@example.com', password: 'admin-pass', role: 'admin' });
    const response = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email: 'admin@example.com', password: 'admin-pass' } });
    const setCookie = response.headers['set-cookie'];
    cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(';')[0];
  });

  const create = (payload: unknown) =>
    app.inject({ method: 'POST', url: '/diagram-types/c4-context/standards', headers: { cookie }, payload: payload as object });

  it('rejects creating a Person kind whose role is system, naming the shapes path', async () => {
    const response = await create(kindBody('system'));
    expect(response.statusCode).toBe(400);
    expect(response.json().issues).toContainEqual({
      path: 'elementKinds[0].shapes',
      message: `A C4 system element can't be drawn as "person"; system elements use rectangle, cylinder, stadium.`,
    });
  });

  it('accepts the same kind with role person', async () => {
    expect((await create(kindBody('person'))).statusCode).toBe(201);
  });

  it('rejects updating a draft so a kind has a role that cannot produce its shape, leaving the draft unchanged', async () => {
    const { standard } = (await create(kindBody('person'))).json();
    const response = await app.inject({ method: 'PUT', url: `/standards/${standard.id}`, headers: { cookie }, payload: kindBody('system') });
    expect(response.statusCode).toBe(400);
    expect(response.json().issues.some((i: { path: string }) => i.path === 'elementKinds[0].shapes')).toBe(true);
    const list = (await app.inject({ method: 'GET', url: '/diagram-types/c4-context/standards', headers: { cookie } })).json().standards;
    expect(list[0].rules.elementKinds[0].match.role).toBe('person');
  });
});

describe('built-in standards pass the definition check', () => {
  const families = new Map<string, string>();

  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp(); // runs migrations for the active engine
    await resetDatabase();
    await seedDiagramTypes();
    const rows = await getDb().selectFrom('diagram_types').select(['id', 'dsl_family']).execute();
    for (const r of rows) families.set(r.id, r.dsl_family);
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  it.each(BUILT_IN_STANDARDS.map((s) => [s.diagramTypeId, s] as const))('%s', (typeId, standard) => {
    const family = families.get(typeId);
    expect(family, `diagram type ${typeId} in the seeded catalog`).toBeDefined();
    expect(checkStandardDefinition(standard.rules, family!)).toEqual([]);
  });
});
