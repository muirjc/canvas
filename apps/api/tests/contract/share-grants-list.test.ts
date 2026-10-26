import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, closeTestDb, resetDatabase, seedFlowchartDiagramType, seedProject, seedUser } from '../helpers/setup.js';

/** canvas-cyt: GET /diagrams/:id/shares returns each grant with granteeName / granteeEmail. */
describe('Share grants list API contract (canvas-cyt)', () => {
  let app: FastifyInstance;
  let adminCookie: string;
  let ownerCookie: string;
  let diagramId: string;
  const ids = {} as Record<'one' | 'two', string>;

  async function login(email: string, password: string): Promise<string> {
    const response = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email, password } });
    const setCookie = response.headers['set-cookie'];
    return (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(';')[0];
  }

  const listGrants = async () =>
    (await app.inject({ method: 'GET', url: `/diagrams/${diagramId}/shares`, headers: { cookie: ownerCookie } })).json().grants as Record<string, unknown>[];

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  beforeEach(async () => {
    await resetDatabase();
    await seedFlowchartDiagramType();
    await seedUser({ email: 'admin@example.com', password: 'admin-pass', role: 'admin' });
    const ownerId = (await seedUser({ email: 'owner@example.com', password: 'owner-pass' })).id;
    ids.one = (await seedUser({ email: 'first@example.com', name: 'First Grantee', password: 'p' })).id;
    ids.two = (await seedUser({ email: 'second@example.com', name: 'Second Grantee', password: 'p' })).id;
    const projectId = (await seedProject('P', ownerId)).id;
    adminCookie = await login('admin@example.com', 'admin-pass');
    ownerCookie = await login('owner@example.com', 'owner-pass');
    diagramId = (
      await app.inject({ method: 'POST', url: `/projects/${projectId}/diagrams`, headers: { cookie: ownerCookie }, payload: { name: 'D', diagramTypeId: 'flowchart' } })
    ).json().diagram.id;
    for (const [who, level] of [['one', 'view'], ['two', 'edit']] as const) {
      const r = await app.inject({
        method: 'POST',
        url: `/diagrams/${diagramId}/shares`,
        headers: { cookie: ownerCookie },
        payload: { granteeUserId: ids[who], accessLevel: level },
      });
      expect(r.statusCode).toBe(201);
    }
  });

  it('includes granteeName and granteeEmail on each grant, in grant-creation order', async () => {
    const grants = await listGrants();
    expect(grants).toHaveLength(2);
    expect(grants[0]).toMatchObject({ granteeUserId: ids.one, accessLevel: 'view', granteeName: 'First Grantee', granteeEmail: 'first@example.com' });
    expect(grants[1]).toMatchObject({ granteeUserId: ids.two, accessLevel: 'edit', granteeName: 'Second Grantee', granteeEmail: 'second@example.com' });
  });

  it('drops the grant when its grantee is deleted (no grant with null name/email is ever listed)', async () => {
    const del = await app.inject({ method: 'DELETE', url: `/admin/users/${ids.one}`, headers: { cookie: adminCookie } });
    expect(del.statusCode).toBeLessThan(300);
    const grants = await listGrants();
    expect(grants.map((g) => g.granteeUserId)).toEqual([ids.two]);
    expect(grants[0].granteeName).toBe('Second Grantee');
  });
});
