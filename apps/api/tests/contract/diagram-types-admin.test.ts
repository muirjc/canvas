import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, closeTestDb, resetDatabase, seedProject, seedUser } from '../helpers/setup.js';
import { seedDiagramTypes } from '../../src/seed/diagram-types.seed.js';

/** canvas-tfr: admin-defined (custom) diagram types. */
describe('Custom diagram types admin API contract', () => {
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

  async function login(email: string, password: string): Promise<string> {
    const response = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email, password } });
    const setCookie = response.headers['set-cookie'];
    return (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(';')[0];
  }

  const createType = (payload: Record<string, unknown>, cookie = adminCookie) =>
    app.inject({ method: 'POST', url: '/admin/diagram-types', headers: { cookie }, payload });
  const patchType = (id: string, payload: Record<string, unknown>, cookie = adminCookie) =>
    app.inject({ method: 'PATCH', url: `/admin/diagram-types/${id}`, headers: { cookie }, payload });
  const listTypes = async (query = '') =>
    (await app.inject({ method: 'GET', url: `/diagram-types${query}`, headers: { cookie: architectCookie } })).json().diagramTypes as Array<{
      id: string;
      name: string;
      origin: string;
      description: string | null;
      personas: string[];
      dslFamily: string;
    }>;

  beforeEach(async () => {
    await resetDatabase();
    await seedDiagramTypes();
    await seedUser({ email: 'admin@example.com', password: 'admin-pass', role: 'admin' });
    architectId = (await seedUser({ email: 'architect@example.com', password: 'architect-pass', role: 'architect' })).id;
    adminCookie = await login('admin@example.com', 'admin-pass');
    architectCookie = await login('architect@example.com', 'architect-pass');
  });

  describe('POST /admin/diagram-types', () => {
    it('creates a custom type with a slug id', async () => {
      const response = await createType({
        name: 'Process Map (Ops)',
        dslFamily: 'flowchart',
        personas: ['Business', 'Solution'],
        description: 'Ops process maps',
      });
      expect(response.statusCode).toBe(201);
      expect(response.json().diagramType).toMatchObject({
        id: 'process-map-ops',
        name: 'Process Map (Ops)',
        dslFamily: 'flowchart',
        personas: expect.arrayContaining(['Business', 'Solution']),
        origin: 'custom',
        description: 'Ops process maps',
        defaultPaletteLibraryIds: [],
      });
    });

    it('stores paletteLibraryIds when given', async () => {
      const response = await createType({ name: 'Palette Type', dslFamily: 'flowchart', personas: ['Business'], paletteLibraryIds: ['generic'] });
      expect(response.statusCode).toBe(201);
      expect(response.json().diagramType.defaultPaletteLibraryIds).toEqual(['generic']);
    });

    it.each([
      ['an unknown family', { name: 'X Type', dslFamily: 'mindmap', personas: ['Business'] }],
      ['no personas', { name: 'X Type', dslFamily: 'flowchart', personas: [] }],
      ['an unknown persona', { name: 'X Type', dslFamily: 'flowchart', personas: ['Wizard'] }],
      ['a blank name', { name: '   ', dslFamily: 'flowchart', personas: ['Business'] }],
      ['a name with no letters or digits', { name: '!!!', dslFamily: 'flowchart', personas: ['Business'] }],
    ])('returns 400 for %s', async (_label, payload) => {
      const response = await createType(payload);
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBeTruthy();
    });

    it('returns 409 when the name slugs to a built-in id', async () => {
      const response = await createType({ name: 'Value Chain', dslFamily: 'flowchart', personas: ['Business'] });
      expect(response.statusCode).toBe(409);
    });

    it('returns 409 when the id already exists', async () => {
      expect((await createType({ name: 'Dupe', dslFamily: 'flowchart', personas: ['Business'] })).statusCode).toBe(201);
      expect((await createType({ name: 'dupe', dslFamily: 'erd', personas: ['Technical'] })).statusCode).toBe(409);
    });

    it('returns 403 for a non-admin', async () => {
      const response = await createType({ name: 'Nope', dslFamily: 'flowchart', personas: ['Business'] }, architectCookie);
      expect(response.statusCode).toBe(403);
    });
  });

  describe('PATCH /admin/diagram-types/:id', () => {
    async function makeCustom(): Promise<string> {
      return (await createType({ name: 'Custom One', dslFamily: 'flowchart', personas: ['Business'] })).json().diagramType.id;
    }

    it('updates name, description, personas and family of an unused custom type', async () => {
      const id = await makeCustom();
      const response = await patchType(id, { name: 'Custom Renamed', description: 'd', personas: ['Technical'], dslFamily: 'erd' });
      expect(response.statusCode).toBe(200);
      expect(response.json().diagramType).toMatchObject({
        id,
        name: 'Custom Renamed',
        description: 'd',
        personas: ['Technical'],
        dslFamily: 'erd',
        origin: 'custom',
      });
    });

    it('returns 409 for a built-in type', async () => {
      expect((await patchType('flowchart', { name: 'Hacked' })).statusCode).toBe(409);
      const flowchart = (await listTypes()).find((t) => t.id === 'flowchart');
      expect(flowchart?.name).not.toBe('Hacked');
    });

    it('returns 404 for an unknown id', async () => {
      expect((await patchType('does-not-exist', { name: 'x' })).statusCode).toBe(404);
    });

    it('returns 400 for an invalid patch', async () => {
      const id = await makeCustom();
      expect((await patchType(id, { personas: [] })).statusCode).toBe(400);
      expect((await patchType(id, { dslFamily: 'mindmap' })).statusCode).toBe(400);
    });

    it("returns 409 on a family change once a diagram uses the type, but still allows other edits", async () => {
      const id = await makeCustom();
      const project = await seedProject('P', architectId);
      const created = await app.inject({
        method: 'POST',
        url: `/projects/${project.id}/diagrams`,
        headers: { cookie: architectCookie },
        payload: { name: 'D', diagramTypeId: id, initialDslContent: 'flowchart TD\n  A --> B\n' },
      });
      expect(created.statusCode).toBe(201);

      expect((await patchType(id, { dslFamily: 'erd' })).statusCode).toBe(409);
      // Re-sending the same family is not a change.
      expect((await patchType(id, { dslFamily: 'flowchart', name: 'Still Fine' })).statusCode).toBe(200);
    });

    it('returns 403 for a non-admin', async () => {
      const id = await makeCustom();
      expect((await patchType(id, { name: 'x' }, architectCookie)).statusCode).toBe(403);
    });
  });

  describe('GET /diagram-types', () => {
    it("reports origin 'builtin' for seeded types and 'custom' for created ones", async () => {
      await createType({ name: 'Custom Two', dslFamily: 'flowchart', personas: ['Business'], description: 'hello' });
      const types = await listTypes();
      expect(types.find((t) => t.id === 'flowchart')).toMatchObject({ origin: 'builtin' });
      expect(types.find((t) => t.id === 'value-chain')).toMatchObject({ origin: 'builtin' });
      expect(types.find((t) => t.id === 'custom-two')).toMatchObject({ origin: 'custom', description: 'hello' });
      expect(types.every((t) => t.origin === 'builtin' || t.origin === 'custom')).toBe(true);
    });

    it('filters a custom type by persona', async () => {
      await createType({ name: 'Business Only', dslFamily: 'flowchart', personas: ['Business'] });
      expect((await listTypes('?persona=Business')).map((t) => t.id)).toContain('business-only');
      expect((await listTypes('?persona=Technical')).map((t) => t.id)).not.toContain('business-only');
    });
  });

  describe('catalog seed safety', () => {
    it('never overwrites a custom type, its personas, or its palette', async () => {
      await createType({ name: 'Safe Type', dslFamily: 'erd', personas: ['Business'], paletteLibraryIds: ['generic'], description: 'mine' });
      await seedDiagramTypes();
      const type = (await listTypes()).find((t) => t.id === 'safe-type');
      expect(type).toMatchObject({ name: 'Safe Type', dslFamily: 'erd', personas: ['Business'], origin: 'custom', description: 'mine' });
    });

    it('does not take over a custom row whose id collides with a built-in id (direct insert)', async () => {
      // The API forbids this, but a pre-existing custom row (e.g. from before a catalog addition)
      // must survive a re-seed untouched.
      const { getDb } = await import('../../src/db/client.js');
      await getDb()
        .updateTable('diagram_types')
        .set({ origin: 'custom', name: 'My Value Chain' })
        .where('id', '=', 'value-chain')
        .execute();
      await seedDiagramTypes();
      const type = (await listTypes()).find((t) => t.id === 'value-chain');
      expect(type).toMatchObject({ name: 'My Value Chain', origin: 'custom' });
    });
  });
});
