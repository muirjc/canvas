import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, closeTestDb, resetDatabase, seedFlowchartDiagramType, seedUser } from '../helpers/setup.js';

/**
 * Contract for project-level access control (feature 007, FR-013a).
 *
 * Written to fail first. Before this feature EVERY route taking a project id was guarded by
 * `requireAuth` alone, so any signed-in user could read any project — including its entire
 * diagram tree — by id (specs/007-project-context/research.md §1).
 *
 * The negative case per route matters more than usual here. The five routes are split across two
 * parameter names (`:id` and `:projectId`), so a guard copied from `requireDiagramAccess` reads
 * `params.id`, finds `undefined` on three of them, treats that as "no such project", falls
 * through — and leaves those three completely unguarded. Every happy-path test stays green while
 * that is true.
 */
describe('Project access control contract', () => {
  let app: FastifyInstance;
  let ownerCookie: string;
  let outsiderCookie: string;
  let outsiderId: string;
  let projectId: string;

  async function login(email: string, password: string): Promise<string> {
    const response = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email, password } });
    const setCookie = response.headers['set-cookie'];
    return (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(';')[0];
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
    await seedUser({ email: 'owner@example.com', password: 'owner-pass' });
    ({ id: outsiderId } = await seedUser({ email: 'outsider@example.com', password: 'outsider-pass' }));

    ownerCookie = await login('owner@example.com', 'owner-pass');
    outsiderCookie = await login('outsider@example.com', 'outsider-pass');

    projectId = (
      await app.inject({ method: 'POST', url: '/projects', headers: { cookie: ownerCookie }, payload: { name: 'Owned' } })
    ).json().project.id;
  });

  describe('a signed-in user with no access to the project', () => {
    it('cannot read the project', async () => {
      const response = await app.inject({ method: 'GET', url: `/projects/${projectId}`, headers: { cookie: outsiderCookie } });
      expect(response.statusCode).toBe(403);
    });

    it('cannot read the project tree — the whole diagram inventory', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/projects/${projectId}/tree`,
        headers: { cookie: outsiderCookie },
      });
      expect(response.statusCode).toBe(403);
    });

    // The three `:projectId` routes. These are the ones a mis-parameterised guard leaves open.
    it('cannot create a diagram in the project', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/projects/${projectId}/diagrams`,
        headers: { cookie: outsiderCookie },
        payload: { name: 'Trespass', diagramTypeId: 'flowchart' },
      });
      expect(response.statusCode).toBe(403);
    });

    it('cannot list or search the project\'s diagrams', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/projects/${projectId}/diagrams`,
        headers: { cookie: outsiderCookie },
      });
      expect(response.statusCode).toBe(403);
    });

    it('cannot import into the project', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/projects/${projectId}/diagrams/import`,
        headers: { cookie: outsiderCookie },
        payload: { name: 'Trespass', dslContent: 'flowchart TD\n  A --> B' },
      });
      expect(response.statusCode).toBe(403);
    });
  });

  it('still returns 404 — not 403 — for a project that does not exist', async () => {
    // Matches the documented reasoning in access-control.middleware.ts: a 403 here would imply
    // the project exists but is out of reach, sending the user to solve the wrong problem.
    const missing = '00000000-0000-0000-0000-000000000000';
    const response = await app.inject({ method: 'GET', url: `/projects/${missing}`, headers: { cookie: outsiderCookie } });
    expect(response.statusCode).toBe(404);
  });

  it('lets the owner through unchanged', async () => {
    const response = await app.inject({ method: 'GET', url: `/projects/${projectId}`, headers: { cookie: ownerCookie } });
    expect(response.statusCode).toBe(200);
  });

  it('lets a user the project was shared with through', async () => {
    await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/shares`,
      headers: { cookie: ownerCookie },
      payload: { granteeUserId: outsiderId, accessLevel: 'view' },
    });

    const response = await app.inject({ method: 'GET', url: `/projects/${projectId}`, headers: { cookie: outsiderCookie } });
    expect(response.statusCode).toBe(200);
  });

  describe('nesting — access inherits downward only', () => {
    it('grants a child project to someone who holds the parent', async () => {
      const childId = (
        await app.inject({
          method: 'POST',
          url: '/projects',
          headers: { cookie: ownerCookie },
          payload: { name: 'Child', parentProjectId: projectId },
        })
      ).json().project.id;

      await app.inject({
        method: 'POST',
        url: `/projects/${projectId}/shares`,
        headers: { cookie: ownerCookie },
        payload: { granteeUserId: outsiderId, accessLevel: 'view' },
      });

      const response = await app.inject({ method: 'GET', url: `/projects/${childId}`, headers: { cookie: outsiderCookie } });
      expect(response.statusCode).toBe(200);
    });

    it('does NOT grant the parent to someone who holds only a child', async () => {
      const childId = (
        await app.inject({
          method: 'POST',
          url: '/projects',
          headers: { cookie: ownerCookie },
          payload: { name: 'Child', parentProjectId: projectId },
        })
      ).json().project.id;

      await app.inject({
        method: 'POST',
        url: `/projects/${childId}/shares`,
        headers: { cookie: ownerCookie },
        payload: { granteeUserId: outsiderId, accessLevel: 'view' },
      });

      const response = await app.inject({ method: 'GET', url: `/projects/${projectId}`, headers: { cookie: outsiderCookie } });
      expect(response.statusCode).toBe(403);
    });

    /**
     * canvas-jtm.5: neither existing nesting test above goes past one hop — the recursive
     * ancestor-chain walk (project.access.ts's `ancestorChain`) and the recursive accessible-set
     * walk (`withAccessibleProjects`'s `roots`/`accessible` CTEs) both need to actually recurse
     * more than once to be meaningfully exercised, not just compile. A grant 2 levels up a project
     * owns no part of directly must still resolve all the way down.
     */
    it('grants a grandchild project to someone who holds a grant 2 levels up', async () => {
      const childId = (
        await app.inject({
          method: 'POST',
          url: '/projects',
          headers: { cookie: ownerCookie },
          payload: { name: 'Child', parentProjectId: projectId },
        })
      ).json().project.id;
      const grandchildId = (
        await app.inject({
          method: 'POST',
          url: '/projects',
          headers: { cookie: ownerCookie },
          payload: { name: 'Grandchild', parentProjectId: childId },
        })
      ).json().project.id;

      await app.inject({
        method: 'POST',
        url: `/projects/${projectId}/shares`,
        headers: { cookie: ownerCookie },
        payload: { granteeUserId: outsiderId, accessLevel: 'view' },
      });

      const response = await app.inject({ method: 'GET', url: `/projects/${grandchildId}`, headers: { cookie: outsiderCookie } });
      expect(response.statusCode).toBe(200);

      // listProjectsForUser (GET /projects) must agree with the single-project guard above —
      // they share one definition precisely so they can't disagree (this file's own header
      // comment). The grandchild must appear in the outsider's own project list too.
      const listResponse = await app.inject({ method: 'GET', url: '/projects', headers: { cookie: outsiderCookie } });
      const listedIds = listResponse.json().projects.map((p: { id: string }) => p.id);
      expect(listedIds).toContain(grandchildId);
    });

    /**
     * canvas-jtm.5: today's DELETE /projects/:id route itself refuses to soft-delete a project
     * that still has children (canvas-228.2), so this exact state can't arise through the app's
     * own API as it exists today — reached here via a direct DB write instead, specifically to
     * confirm the invariant holds regardless of how a soft-deleted-with-live-descendants row ever
     * came to exist (a future admin force-delete, a direct DB intervention, ...), not just via
     * today's one reachable path. `ancestorChain`'s WHERE deleted_at IS NULL filter applies at
     * every level of the recursive walk, not just to the project initially requested — so once an
     * ancestor is (hypothetically) soft-deleted, the chain walk stops there, and whatever that
     * ancestor would have granted stops propagating to its still-live descendants.
     */
    it('a soft-deleted ancestor no longer propagates its own access grant to live descendants', async () => {
      const childId = (
        await app.inject({
          method: 'POST',
          url: '/projects',
          headers: { cookie: ownerCookie },
          payload: { name: 'Child', parentProjectId: projectId },
        })
      ).json().project.id;
      const grandchildId = (
        await app.inject({
          method: 'POST',
          url: '/projects',
          headers: { cookie: ownerCookie },
          payload: { name: 'Grandchild', parentProjectId: childId },
        })
      ).json().project.id;
      await app.inject({
        method: 'POST',
        url: `/projects/${projectId}/shares`,
        headers: { cookie: ownerCookie },
        payload: { granteeUserId: outsiderId, accessLevel: 'view' },
      });

      // Confirmed reachable before the soft-delete, mirroring the test above.
      const before = await app.inject({ method: 'GET', url: `/projects/${grandchildId}`, headers: { cookie: outsiderCookie } });
      expect(before.statusCode).toBe(200);

      const { getDb } = await import('../../src/db/client.js');
      await getDb().updateTable('projects').set({ deleted_at: new Date() }).where('id', '=', projectId).execute();

      const after = await app.inject({ method: 'GET', url: `/projects/${grandchildId}`, headers: { cookie: outsiderCookie } });
      expect(after.statusCode).toBe(403);
    });
  });
});
