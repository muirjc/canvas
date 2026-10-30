import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/db/client.js';
import { buildTestApp, closeTestDb, resetDatabase, seedFlowchartDiagramType, seedProject, seedUser } from '../helpers/setup.js';

/** canvas-8em: admin feature switches; sharingEnabled hides/shows the editor's Share button. */
describe('App settings API contract', () => {
  let app: FastifyInstance;
  let adminCookie: string;
  let architectCookie: string;

  const login = async (email: string, password: string) => {
    const response = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email, password } });
    const header = response.headers['set-cookie'];
    return (Array.isArray(header) ? header[0] : header)!.split(';')[0];
  };

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  beforeEach(async () => {
    await resetDatabase();
    await seedUser({ email: 'admin@example.com', password: 'admin-pass', role: 'admin' });
    await seedUser({ email: 'architect@example.com', password: 'architect-pass' });
    adminCookie = await login('admin@example.com', 'admin-pass');
    architectCookie = await login('architect@example.com', 'architect-pass');
  });

  it('sharing is off by default and any signed-in user can read the settings', async () => {
    const response = await app.inject({ method: 'GET', url: '/app-settings', headers: { cookie: architectCookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ sharingEnabled: false });
  });

  it('requires sign-in to read the settings', async () => {
    const response = await app.inject({ method: 'GET', url: '/app-settings' });
    expect(response.statusCode).toBe(401);
  });

  it('only an admin can change a setting', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/admin/app-settings',
      headers: { cookie: architectCookie },
      payload: { sharingEnabled: true },
    });
    expect(response.statusCode).toBe(403);
    const after = await app.inject({ method: 'GET', url: '/app-settings', headers: { cookie: architectCookie } });
    expect(after.json().sharingEnabled).toBe(false);
  });

  it('an admin turns sharing on and off, and each change is audited', async () => {
    const on = await app.inject({ method: 'PATCH', url: '/admin/app-settings', headers: { cookie: adminCookie }, payload: { sharingEnabled: true } });
    expect(on.statusCode).toBe(200);
    expect(on.json()).toEqual({ sharingEnabled: true });
    const read = await app.inject({ method: 'GET', url: '/app-settings', headers: { cookie: architectCookie } });
    expect(read.json().sharingEnabled).toBe(true);

    // Setting the same value again changes nothing, so it isn't audited.
    await app.inject({ method: 'PATCH', url: '/admin/app-settings', headers: { cookie: adminCookie }, payload: { sharingEnabled: true } });
    await app.inject({ method: 'PATCH', url: '/admin/app-settings', headers: { cookie: adminCookie }, payload: { sharingEnabled: false } });

    const rows = await getDb().selectFrom('audit_events').select(['event', 'detail']).where('event', '=', 'app_setting_changed').execute();
    const details = rows.map((r) => (typeof r.detail === 'string' ? JSON.parse(r.detail) : r.detail));
    expect(details).toEqual([
      { setting: 'sharingEnabled', from: false, to: true },
      { setting: 'sharingEnabled', from: true, to: false },
    ]);
  });

  it('rejects an unknown setting or a wrongly-typed value', async () => {
    for (const payload of [{ somethingElse: true }, { sharingEnabled: 'yes' }, {}]) {
      const response = await app.inject({ method: 'PATCH', url: '/admin/app-settings', headers: { cookie: adminCookie }, payload });
      expect(response.statusCode).toBe(400);
    }
  });

  it('turning sharing off leaves existing shares working (only the button is hidden)', async () => {
    // Sharing routes don't consult the switch: granting still works with it off.
    await seedFlowchartDiagramType();
    const users = await getDb().selectFrom('users').select(['id', 'email']).execute();
    const admin = users.find((u) => u.email === 'admin@example.com')!;
    const architect = users.find((u) => u.email === 'architect@example.com')!;
    const projectId = (await seedProject('P', admin.id)).id;
    const diagram = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/diagrams`,
      headers: { cookie: adminCookie },
      payload: { name: 'D', diagramTypeId: 'flowchart', initialDslContent: 'flowchart TD\n  A[Start]\n' },
    });
    const diagramId = diagram.json().diagram.id;
    const grant = await app.inject({
      method: 'POST',
      url: `/diagrams/${diagramId}/shares`,
      headers: { cookie: adminCookie },
      payload: { granteeUserId: architect.id, accessLevel: 'view' },
    });
    expect(grant.statusCode).toBeLessThan(300);
    const open = await app.inject({ method: 'GET', url: `/diagrams/${diagramId}`, headers: { cookie: architectCookie } });
    expect(open.statusCode).toBe(200);
  });
});
