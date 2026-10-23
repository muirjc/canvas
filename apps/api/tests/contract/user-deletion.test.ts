import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/db/client.js';
import { setUserPersonas } from '../../src/db/array-columns.js';
import { buildTestApp, closeTestDb, resetDatabase, seedFlowchartDiagramType, seedUser } from '../helpers/setup.js';

/** canvas-0se: an admin deletes a user -- content transferred, access removed, history kept. */
describe('User deletion (canvas-0se)', () => {
  let app: FastifyInstance;
  const ids = {} as Record<'admin' | 'doomed' | 'target' | 'grantee', string>;
  const cookies = {} as Record<'admin' | 'doomed' | 'target' | 'grantee', string>;

  async function loginCookie(email: string, password: string) {
    const res = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email, password } });
    return String(res.headers['set-cookie']).split(';')[0];
  }
  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, cookie?: string, payload?: unknown) =>
    app.inject({ method, url, headers: cookie ? { cookie } : {}, payload: payload as object });
  const del = (userId: string, body?: unknown, cookie = cookies.admin) => call('DELETE', `/admin/users/${userId}`, cookie, body);

  /** The doomed user's world: projects (one soft-deleted), diagrams (one soft-deleted), versions, shares both ways. */
  async function buildWorld() {
    const project = (await call('POST', '/projects', cookies.doomed, { name: 'Doomed project' })).json().project.id as string;
    const emptyProject = (await call('POST', '/projects', cookies.doomed, { name: 'Doomed archived project' })).json().project.id as string;
    expect((await call('DELETE', `/projects/${emptyProject}`, cookies.doomed)).statusCode).toBeLessThan(300);
    const diagram = (await call('POST', `/projects/${project}/diagrams`, cookies.doomed, { name: 'Live', diagramTypeId: 'flowchart' })).json().diagram.id as string;
    const trashed = (await call('POST', `/projects/${project}/diagrams`, cookies.doomed, { name: 'Trashed', diagramTypeId: 'flowchart' })).json().diagram.id as string;
    expect((await call('DELETE', `/diagrams/${trashed}`, cookies.doomed)).statusCode).toBeLessThan(300);
    expect((await call('PATCH', `/diagrams/${diagram}`, cookies.doomed, { dslContent: 'flowchart TD\n  A[One] --> B[Two]\n' })).statusCode).toBe(200);

    // Gave a share: the grantee can open the doomed user's diagram.
    expect((await call('POST', `/diagrams/${diagram}/shares`, cookies.doomed, { granteeUserId: ids.grantee, accessLevel: 'view' })).statusCode).toBe(201);
    // Received a share: an admin-owned project shared with the doomed user.
    const adminProject = (await call('POST', '/projects', cookies.admin, { name: 'Admin project' })).json().project.id as string;
    expect((await call('POST', `/projects/${adminProject}/shares`, cookies.admin, { granteeUserId: ids.doomed, accessLevel: 'view' })).statusCode).toBe(201);

    // MFA, personas.
    await getDb().insertInto('user_mfa').values({ user_id: ids.doomed, secret_encrypted: 'v1:x:y:z', enabled_at: new Date(), last_used_step: null }).execute();
    await getDb().insertInto('mfa_recovery_codes').values({ id: randomUUID(), user_id: ids.doomed, code_hash: 'abc', used_at: null }).execute();
    await setUserPersonas(getDb(), ids.doomed, ['Business']);
    return { project, emptyProject, diagram, trashed, adminProject };
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
    await seedFlowchartDiagramType();
    ids.admin = (await seedUser({ email: 'admin@example.com', password: 'admin-pass', role: 'admin' })).id; // gitleaks:allow
    ids.doomed = (await seedUser({ email: 'doomed@example.com', password: 'doomed-pass', name: 'Doomed Dan' })).id; // gitleaks:allow
    ids.target = (await seedUser({ email: 'target@example.com', password: 'target-pass', name: 'Target Tess' })).id; // gitleaks:allow
    ids.grantee = (await seedUser({ email: 'grantee@example.com', password: 'grantee-pass', role: 'viewer' })).id; // gitleaks:allow
    cookies.admin = await loginCookie('admin@example.com', 'admin-pass'); // gitleaks:allow
    cookies.doomed = await loginCookie('doomed@example.com', 'doomed-pass'); // gitleaks:allow
    cookies.target = await loginCookie('target@example.com', 'target-pass'); // gitleaks:allow
    cookies.grantee = await loginCookie('grantee@example.com', 'grantee-pass'); // gitleaks:allow
  });

  describe('deletion impact', () => {
    it('counts owned projects and diagrams (soft-deleted included) and shares received', async () => {
      await buildWorld();
      const res = await call('GET', `/admin/users/${ids.doomed}/deletion-impact`, cookies.admin);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ownedProjects: 2, ownedDiagrams: 2, sharesReceived: 1, isLastActiveAdmin: false });
    });

    it('flags the last active admin, and not once there is another', async () => {
      expect((await call('GET', `/admin/users/${ids.admin}/deletion-impact`, cookies.admin)).json().isLastActiveAdmin).toBe(true);
      await call('PATCH', `/admin/users/${ids.target}`, cookies.admin, { role: 'admin' });
      expect((await call('GET', `/admin/users/${ids.admin}/deletion-impact`, cookies.admin)).json().isLastActiveAdmin).toBe(false);
    });

    it('is admin only, and 404 for an unknown user', async () => {
      expect((await call('GET', `/admin/users/${ids.doomed}/deletion-impact`, cookies.target)).statusCode).toBe(403);
      expect((await call('GET', `/admin/users/${ids.doomed}/deletion-impact`)).statusCode).toBe(401);
      expect((await call('GET', '/admin/users/00000000-0000-4000-8000-000000000000/deletion-impact', cookies.admin)).statusCode).toBe(404);
    });
  });

  describe('deleting a user with content', () => {
    it('transfers everything, keeps history, and removes access', async () => {
      const w = await buildWorld();
      const res = await del(ids.doomed, { transferToUserId: ids.target });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ deleted: true, transferredProjects: 2, transferredDiagrams: 2 });

      // The target owns it all, soft-deleted rows included, and can open the live ones.
      const db = getDb();
      expect((await db.selectFrom('projects').select('owner_id').execute()).filter((p) => p.owner_id === ids.doomed)).toHaveLength(0);
      expect((await db.selectFrom('diagrams').select('owner_id').execute()).filter((d) => d.owner_id === ids.doomed)).toHaveLength(0);
      expect((await db.selectFrom('projects').select('owner_id').where('id', '=', w.emptyProject).executeTakeFirstOrThrow()).owner_id).toBe(ids.target);
      expect((await db.selectFrom('diagrams').select('owner_id').where('id', '=', w.trashed).executeTakeFirstOrThrow()).owner_id).toBe(ids.target);
      expect((await call('GET', `/projects/${w.project}/tree`, cookies.target)).statusCode).toBe(200);
      expect((await call('GET', `/diagrams/${w.diagram}`, cookies.target)).statusCode).toBe(200);

      // Shares they received are gone; shares they gave remain and still work.
      expect(await db.selectFrom('share_grants').select('id').where('grantee_user_id', '=', ids.doomed).execute()).toHaveLength(0);
      const given = await db.selectFrom('share_grants').select(['grantee_user_id', 'granted_by_user_id']).where('subject_id', '=', w.diagram).execute();
      expect(given).toEqual([{ grantee_user_id: ids.grantee, granted_by_user_id: ids.doomed }]);
      expect((await call('GET', `/diagrams/${w.diagram}`, cookies.grantee)).statusCode).toBe(200);

      // Versions they authored still list (the author is the placeholder user).
      const versions = (await call('GET', `/diagrams/${w.diagram}/versions`, cookies.target)).json();
      expect(versions.versions?.length ?? versions.items?.length ?? 0).toBeGreaterThan(0);
      expect(JSON.stringify(versions)).toContain(ids.doomed);

      // Credentials, MFA, personas are gone.
      expect(await db.selectFrom('local_credentials').select('user_id').where('user_id', '=', ids.doomed).execute()).toHaveLength(0);
      expect(await db.selectFrom('user_mfa').select('user_id').where('user_id', '=', ids.doomed).execute()).toHaveLength(0);
      expect(await db.selectFrom('mfa_recovery_codes').select('id').where('user_id', '=', ids.doomed).execute()).toHaveLength(0);
      expect(await db.selectFrom('users_personas').select('user_id').where('user_id', '=', ids.doomed).execute()).toHaveLength(0);

      // The row is an anonymised placeholder.
      const row = await db.selectFrom('users').selectAll().where('id', '=', ids.doomed).executeTakeFirstOrThrow();
      expect(row).toMatchObject({ name: 'Deleted user', email: `deleted-${ids.doomed}@deleted.invalid` });
      expect(row.deleted_at).not.toBeNull();
    });

    it('ends their sessions and they cannot sign in again', async () => {
      await buildWorld();
      expect((await call('GET', '/auth/me', cookies.doomed)).statusCode).toBe(200);
      await del(ids.doomed, { transferToUserId: ids.target });
      expect((await call('GET', '/auth/me', cookies.doomed)).statusCode).toBe(401);
      for (const email of ['doomed@example.com', `deleted-${ids.doomed}@deleted.invalid`]) {
        const res = await call('POST', '/auth/local/login', undefined, { email, password: 'doomed-pass' }); // gitleaks:allow
        expect(res.statusCode).toBe(401);
      }
    });

    it('frees the email for a new account', async () => {
      await del(ids.doomed, { transferToUserId: ids.target });
      const created = await call('POST', '/admin/users', cookies.admin, { email: 'doomed@example.com', name: 'New Dan', role: 'viewer' });
      expect(created.statusCode).toBe(201);
      expect(created.json().user.id).not.toBe(ids.doomed);
    });

    it('disappears from the users list and the overview count, and is audited with the original email', async () => {
      const before = (await call('GET', '/admin/overview', cookies.admin)).json().overview.userCount as number;
      await del(ids.doomed, { transferToUserId: ids.target });
      const users = (await call('GET', '/admin/users', cookies.admin)).json().users as { id: string; email: string }[];
      expect(users.find((u) => u.id === ids.doomed)).toBeUndefined();
      expect(JSON.stringify(users)).not.toContain('Deleted user');
      expect((await call('GET', '/admin/overview', cookies.admin)).json().overview.userCount).toBe(before - 1);

      const events = (await call('GET', '/admin/audit?limit=100', cookies.admin)).json().events as { event: string; actorEmail: string; detail: Record<string, unknown> }[];
      const entry = events.find((e) => e.event === 'user_deleted')!;
      expect(entry.actorEmail).toBe('admin@example.com');
      expect(entry.detail).toMatchObject({ email: 'doomed@example.com', name: 'Doomed Dan', transferredTo: ids.target, transferredToEmail: 'target@example.com' });
    });
  });

  describe('guards', () => {
    it('audits a deletion with no transfer as transferredTo null and transferredToEmail null', async () => {
      await del(ids.doomed);
      const events = (await call('GET', '/admin/audit?limit=100', cookies.admin)).json().events as { event: string; detail: Record<string, unknown> }[];
      expect(events.find((e) => e.event === 'user_deleted')!.detail).toMatchObject({ email: 'doomed@example.com', transferredTo: null, transferredToEmail: null });
    });

    it('refuses deleting yourself', async () => {
      await call('PATCH', `/admin/users/${ids.target}`, cookies.admin, { role: 'admin' });
      expect((await del(ids.admin)).statusCode).toBe(409);
    });

    it('refuses the last active admin, but deleting a non-last admin works', async () => {
      await call('PATCH', `/admin/users/${ids.target}`, cookies.admin, { role: 'admin' });
      // Two admins: the first may delete the second.
      expect((await del(ids.target)).statusCode).toBe(200);
      // Now only `admin` is left, and an admin cannot be deleted by themselves or leave none behind.
      expect((await del(ids.admin)).statusCode).toBe(409);
    });

    it('an inactive admin does not count as an active one', async () => {
      await call('PATCH', `/admin/users/${ids.target}`, cookies.admin, { role: 'admin', active: false });
      expect((await call('GET', `/admin/users/${ids.admin}/deletion-impact`, cookies.admin)).json().isLastActiveAdmin).toBe(true);
    });

    it('needs a transfer target when they own content', async () => {
      await buildWorld();
      const res = await del(ids.doomed);
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatch(/who receives/i);
      expect(await getDb().selectFrom('users').select('deleted_at').where('id', '=', ids.doomed).executeTakeFirstOrThrow()).toEqual({ deleted_at: null });
    });

    it('refuses a transfer to themselves, an inactive, a deleted or an unknown user, and changes nothing', async () => {
      const w = await buildWorld();
      await call('PATCH', `/admin/users/${ids.grantee}`, cookies.admin, { active: false });
      const ghost = await seedUser({ email: 'ghost@example.com', password: 'ghost-pass' }); // gitleaks:allow
      await del(ghost.id);
      for (const target of [ids.doomed, ids.grantee, ghost.id, '00000000-0000-4000-8000-000000000000']) {
        expect((await del(ids.doomed, { transferToUserId: target })).statusCode, target).toBe(409);
      }
      expect((await getDb().selectFrom('projects').select('owner_id').where('id', '=', w.project).executeTakeFirstOrThrow()).owner_id).toBe(ids.doomed);
      expect((await call('GET', '/auth/me', cookies.doomed)).statusCode).toBe(200);
    });

    it('is admin only', async () => {
      expect((await del(ids.doomed, undefined, cookies.target)).statusCode).toBe(403);
      expect((await call('DELETE', `/admin/users/${ids.doomed}`)).statusCode).toBe(401);
    });

    it('404s for an unknown user and for one already deleted', async () => {
      expect((await del('00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
      expect((await del(ids.doomed)).statusCode).toBe(200);
      expect((await del(ids.doomed)).statusCode).toBe(404);
    });
  });

  describe('other cases', () => {
    it('a user who owns nothing needs no transfer', async () => {
      const res = await del(ids.doomed);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ deleted: true, transferredProjects: 0, transferredDiagrams: 0 });
    });

    it('a user with no local credentials (single sign-on) can be deleted too', async () => {
      const id = randomUUID();
      await getDb().insertInto('users').values({ id, name: 'Sso Sam', email: 'sso@example.com', role: 'viewer' }).execute();
      expect((await call('GET', `/admin/users/${id}/deletion-impact`, cookies.admin)).statusCode).toBe(200);
      expect((await del(id)).statusCode).toBe(200);
      expect((await getDb().selectFrom('users').select('email').where('id', '=', id).executeTakeFirstOrThrow()).email).toBe(`deleted-${id}@deleted.invalid`);
    });

    it('a deleted user is not found by update, unlock, reset-password or reset-mfa', async () => {
      await del(ids.doomed);
      expect((await call('PATCH', `/admin/users/${ids.doomed}`, cookies.admin, { role: 'viewer' })).statusCode).toBe(404);
      expect((await call('POST', `/admin/users/${ids.doomed}/unlock`, cookies.admin)).statusCode).toBe(404);
      expect((await call('POST', `/admin/users/${ids.doomed}/reset-password`, cookies.admin)).statusCode).toBe(404);
      expect((await call('POST', `/admin/users/${ids.doomed}/reset-mfa`, cookies.admin)).statusCode).toBe(404);
      expect((await call('GET', `/admin/users/${ids.doomed}/deletion-impact`, cookies.admin)).statusCode).toBe(404);
    });

    it('a deleted user is not reactivated by being marked active', async () => {
      await del(ids.doomed);
      await call('PATCH', `/admin/users/${ids.doomed}`, cookies.admin, { active: true });
      const row = await getDb().selectFrom('users').select('active').where('id', '=', ids.doomed).executeTakeFirstOrThrow();
      expect(Boolean(row.active)).toBe(false);
    });
  });
});
