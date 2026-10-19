import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/db/client.js';
import { seedDiagramTypes } from '../../src/seed/diagram-types.seed.js';
import { buildTestApp, closeTestDb, resetDatabase, seedProject, seedUser } from '../helpers/setup.js';

/**
 * canvas-9ff: there was no way to delete or hide a diagram type. Now any type can be hidden (gone
 * from the create pickers, existing diagrams unaffected), and an unused custom type can be deleted.
 */
describe('Hiding and deleting diagram types (canvas-9ff)', () => {
  let app: FastifyInstance;
  let adminCookie: string;
  let architectCookie: string;
  let projectId: string;

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

  type ListedType = { id: string; hidden: boolean; adminEdited: boolean };
  const listTypes = async (query = '', cookie = architectCookie) =>
    (await app.inject({ method: 'GET', url: `/diagram-types${query}`, headers: { cookie } })).json().diagramTypes as ListedType[];
  const patchType = (id: string, payload: Record<string, unknown>, cookie = adminCookie) =>
    app.inject({ method: 'PATCH', url: `/admin/diagram-types/${id}`, headers: { cookie }, payload });
  const deleteType = (id: string, cookie = adminCookie) =>
    app.inject({ method: 'DELETE', url: `/admin/diagram-types/${id}`, headers: { cookie } });
  const createCustomType = async (name: string): Promise<string> => {
    const response = await app.inject({
      method: 'POST',
      url: '/admin/diagram-types',
      headers: { cookie: adminCookie },
      payload: { name, dslFamily: 'flowchart', personas: ['Business', 'Enterprise', 'Solution', 'Technical'] },
    });
    expect(response.statusCode).toBe(201);
    return response.json().diagramType.id as string;
  };
  const createDiagram = async (diagramTypeId: string): Promise<string> => {
    const response = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/diagrams`,
      headers: { cookie: adminCookie },
      payload: { name: 'D', diagramTypeId, initialDslContent: 'flowchart TD\n  A[Start]\n' },
    });
    expect(response.statusCode).toBe(201);
    return response.json().diagram.id as string;
  };

  beforeEach(async () => {
    await resetDatabase();
    await seedDiagramTypes();
    const admin = await seedUser({ email: 'admin@example.com', password: 'admin-pass', role: 'admin' });
    await seedUser({ email: 'architect@example.com', password: 'architect-pass', role: 'architect' });
    projectId = (await seedProject('P', admin.id)).id;
    adminCookie = await login('admin@example.com', 'admin-pass');
    architectCookie = await login('architect@example.com', 'architect-pass');
  });

  describe('hide / unhide', () => {
    it('a hidden built-in type leaves the default list, stays listed with includeHidden, and comes back when unhidden', async () => {
      const hide = await patchType('roadmap', { hidden: true });
      expect(hide.statusCode).toBe(200);
      expect(hide.json().diagramType.hidden).toBe(true);

      expect((await listTypes()).map((t) => t.id)).not.toContain('roadmap');
      const all = await listTypes('?includeHidden=true');
      expect(all.find((t) => t.id === 'roadmap')?.hidden).toBe(true);

      expect((await patchType('roadmap', { hidden: false })).statusCode).toBe(200);
      expect((await listTypes()).map((t) => t.id)).toContain('roadmap');
    });

    it('hiding a built-in does not mark it admin-edited, so catalog updates keep reaching it', async () => {
      await patchType('roadmap', { hidden: true });
      const roadmap = (await listTypes('?includeHidden=true')).find((t) => t.id === 'roadmap')!;
      expect(roadmap.adminEdited).toBe(false);
    });

    it('the catalog seed never un-hides a type', async () => {
      await patchType('roadmap', { hidden: true });
      await seedDiagramTypes();
      expect((await listTypes('?includeHidden=true')).find((t) => t.id === 'roadmap')?.hidden).toBe(true);
    });

    it('custom types can be hidden too', async () => {
      const id = await createCustomType('Ops Map');
      await patchType(id, { hidden: true });
      expect((await listTypes()).map((t) => t.id)).not.toContain(id);
    });

    it('existing diagrams of a hidden type keep working', async () => {
      const diagramId = await createDiagram('roadmap');
      await patchType('roadmap', { hidden: true });
      const response = await app.inject({ method: 'GET', url: `/diagrams/${diagramId}`, headers: { cookie: adminCookie } });
      expect(response.statusCode).toBe(200);
    });

    it('only an admin can hide a type', async () => {
      expect((await patchType('roadmap', { hidden: true }, architectCookie)).statusCode).toBe(403);
    });

    it('rejects a non-boolean hidden value', async () => {
      expect((await patchType('roadmap', { hidden: 'yes' })).statusCode).toBe(400);
    });
  });

  describe('delete', () => {
    it('deletes an unused custom type, and its standards with it', async () => {
      const id = await createCustomType('Ops Map');
      const standard = await app.inject({
        method: 'POST',
        url: `/diagram-types/${id}/standards`,
        headers: { cookie: adminCookie },
        payload: { name: 'Ops standard' },
      });
      expect(standard.statusCode).toBe(201);

      const response = await deleteType(id);
      expect(response.statusCode).toBe(204);
      expect((await listTypes('?includeHidden=true')).map((t) => t.id)).not.toContain(id);
      const standards = await getDb().selectFrom('standards').select('id').where('diagram_type_id', '=', id).execute();
      expect(standards).toHaveLength(0);
    });

    it('refuses a custom type that a diagram uses, saying how many and suggesting Hide', async () => {
      const id = await createCustomType('Ops Map');
      await createDiagram(id);
      await createDiagram(id);
      const response = await deleteType(id);
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toMatch(/2 diagrams/);
      expect(response.json().error).toMatch(/hide/i);
      expect((await listTypes()).map((t) => t.id)).toContain(id);
    });

    it('a soft-deleted diagram still counts as using the type', async () => {
      const id = await createCustomType('Ops Map');
      const diagramId = await createDiagram(id);
      expect((await app.inject({ method: 'DELETE', url: `/diagrams/${diagramId}`, headers: { cookie: adminCookie } })).statusCode).toBeLessThan(300);
      expect((await deleteType(id)).statusCode).toBe(409);
    });

    it('refuses to delete a built-in type and suggests hiding it', async () => {
      const response = await deleteType('roadmap');
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toMatch(/built-in/i);
      expect(response.json().error).toMatch(/hide/i);
    });

    it('404s for an unknown type and 403s for a non-admin', async () => {
      expect((await deleteType('no-such-type')).statusCode).toBe(404);
      const id = await createCustomType('Ops Map');
      expect((await deleteType(id, architectCookie)).statusCode).toBe(403);
    });
  });
});
