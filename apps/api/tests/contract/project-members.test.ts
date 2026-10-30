import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/db/client.js';
import { buildTestApp, closeTestDb, resetDatabase, seedFlowchartDiagramType, seedUser } from '../helpers/setup.js';

/**
 * canvas-2h2w.2: a project's Members -- the owner, Manage members and admins add, change and remove
 * members and hand over ownership; everyone else can see the list. Every change is audited.
 */
describe('Project members (canvas-2h2w.2)', () => {
  let app: FastifyInstance;
  const cookies: Record<string, string> = {};
  const ids: Record<string, string> = {};
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

  const call = (method: 'GET' | 'POST' | 'DELETE', url: string, who: string, payload?: unknown) =>
    app.inject({ method, url, headers: { cookie: cookies[who] }, ...(payload === undefined ? {} : { payload: payload as object }) });
  const add = (who: string, grantee: string, accessLevel: string) =>
    call('POST', `/projects/${projectId}/shares`, who, { granteeUserId: ids[grantee], accessLevel });
  const members = async (who = 'owner') => (await call('GET', `/projects/${projectId}/members`, who)).json();
  const audit = async () =>
    (await getDb().selectFrom('audit_events').select(['event', 'target_user_id', 'detail']).orderBy('occurred_at').execute()).filter((e) =>
      e.event.startsWith('project_'),
    );

  beforeEach(async () => {
    await resetDatabase();
    await seedFlowchartDiagramType();
    for (const [name, role] of [
      ['owner', 'architect'],
      ['manager', 'architect'],
      ['editor', 'architect'],
      ['newbie', 'architect'],
      ['reader', 'viewer'],
      ['admin', 'admin'],
    ] as const) {
      ids[name] = (await seedUser({ email: `${name}@example.com`, password: `${name}-pass`, role, name: name[0].toUpperCase() + name.slice(1) })).id; // gitleaks:allow
      cookies[name] = await login(`${name}@example.com`, `${name}-pass`); // gitleaks:allow
    }
    projectId = (await call('POST', '/projects', 'owner', { name: 'Payments' })).json().project.id;
    expect((await add('owner', 'manager', 'manage')).statusCode).toBe(201);
    expect((await add('owner', 'editor', 'edit')).statusCode).toBe(201);
  });

  it('lists the owner and members, with names, to anyone who can read the project', async () => {
    const list = await members('newbie');
    expect(list.owner).toMatchObject({ id: ids.owner, name: 'Owner' });
    expect(list.members.map((m: { name: string; accessLevel: string }) => [m.name, m.accessLevel])).toEqual([
      ['Editor', 'edit'],
      ['Manager', 'manage'],
    ]);
    expect(list.yourAccess).toBe('view');
    expect((await members('manager')).yourAccess).toBe('manage');
  });

  it('owner, Manage members and admins add, change and remove members; editors cannot', async () => {
    expect((await add('editor', 'newbie', 'view')).statusCode).toBe(403);
    expect((await add('manager', 'newbie', 'view')).statusCode).toBe(201);
    expect((await add('admin', 'newbie', 'comment')).statusCode).toBe(201);
    const grant = (await members()).members.find((m: { userId: string }) => m.userId === ids.newbie);
    expect(grant.accessLevel).toBe('comment');
    expect((await call('DELETE', `/shares/${grant.grantId}`, 'editor')).statusCode).toBe(403);
    expect((await call('DELETE', `/shares/${grant.grantId}`, 'manager')).statusCode).toBe(204);
    expect((await members()).members.some((m: { userId: string }) => m.userId === ids.newbie)).toBe(false);
  });

  it('audits each change: added, changed (with the old level), removed', async () => {
    await add('owner', 'newbie', 'view');
    await add('owner', 'newbie', 'edit');
    await add('owner', 'newbie', 'edit'); // no change, no entry
    const grant = (await members()).members.find((m: { userId: string }) => m.userId === ids.newbie);
    await call('DELETE', `/shares/${grant.grantId}`, 'owner');
    const newbieEvents = (await audit()).filter((e) => e.target_user_id === ids.newbie);
    expect(newbieEvents.map((e) => e.event)).toEqual(['project_member_added', 'project_member_changed', 'project_member_removed']);
    expect(JSON.parse(newbieEvents[1].detail!)).toMatchObject({ projectId, level: 'edit', from: 'view' });
  });

  describe('transferring ownership', () => {
    it('the owner hands over; the new owner leaves the member list and the old one stays as Manage', async () => {
      const response = await call('POST', `/projects/${projectId}/owner`, 'owner', { newOwnerId: ids.editor });
      expect(response.statusCode).toBe(200);
      const list = response.json();
      expect(list.owner.id).toBe(ids.editor);
      expect(list.members.find((m: { userId: string }) => m.userId === ids.editor)).toBeUndefined();
      expect(list.members.find((m: { userId: string }) => m.userId === ids.owner)).toMatchObject({ accessLevel: 'manage' });
      const listed = (await call('GET', '/projects', 'editor')).json().projects[0];
      expect(listed).toMatchObject({ accessLevel: 'manage', membership: 'owner' });
      expect((await audit()).find((e) => e.event === 'project_owner_transferred')).toMatchObject({ target_user_id: ids.editor });
    });

    it('only the owner or an admin can; Manage members cannot', async () => {
      expect((await call('POST', `/projects/${projectId}/owner`, 'manager', { newOwnerId: ids.manager })).statusCode).toBe(403);
      expect((await call('POST', `/projects/${projectId}/owner`, 'admin', { newOwnerId: ids.newbie })).statusCode).toBe(200);
      expect((await members()).owner.id).toBe(ids.newbie);
    });

    it('refuses a viewer or an unknown user as the new owner', async () => {
      expect((await call('POST', `/projects/${projectId}/owner`, 'owner', { newOwnerId: ids.reader })).statusCode).toBe(400);
      expect((await call('POST', `/projects/${projectId}/owner`, 'owner', { newOwnerId: '00000000-0000-4000-8000-000000000000' })).statusCode).toBe(400);
      expect((await members()).owner.id).toBe(ids.owner);
    });
  });

  it('a diagram shared with someone who is already a project member at that level is not listed again under Shared with me', async () => {
    const diagramId = (await call('POST', `/projects/${projectId}/diagrams`, 'owner', { name: 'Flow', diagramTypeId: 'flowchart' })).json().diagram.id;
    await call('POST', `/diagrams/${diagramId}/shares`, 'owner', { granteeUserId: ids.editor, accessLevel: 'comment' });
    await call('POST', `/diagrams/${diagramId}/shares`, 'owner', { granteeUserId: ids.newbie, accessLevel: 'comment' });
    expect((await call('GET', '/shared-diagrams', 'editor')).json().diagrams).toEqual([]); // covered by project Edit
    expect((await call('GET', '/shared-diagrams', 'newbie')).json().diagrams).toHaveLength(1); // not a member
  });
});
