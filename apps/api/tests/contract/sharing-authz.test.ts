import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/db/client.js';
import { buildTestApp, closeTestDb, resetDatabase, seedFlowchartDiagramType, seedProject, seedUser } from '../helpers/setup.js';

/**
 * canvas-i5y: who may manage shares. Every sharing route used to require only a session, so any
 * signed-in user could give themselves edit access to any diagram or project by id, revoke any
 * grant, or read who has access. Now (decided with the user, option A): sharing and revoking need
 * EDIT access to the subject (owners and admins always have it); the list needs VIEW access.
 */
type Who = 'owner' | 'admin' | 'editor' | 'commenter' | 'viewer' | 'stranger';

describe('Sharing authorization (canvas-i5y)', () => {
  let app: FastifyInstance;
  const ids = {} as Record<Who, string>;
  const cookies = {} as Record<Who, string>;
  let projectId = '';
  let diagramId = '';

  beforeAll(async () => {
    app = await buildTestApp();
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  const call = (method: 'GET' | 'POST' | 'DELETE', url: string, who: Who, payload?: object) =>
    app.inject({ method, url, headers: { cookie: cookies[who] }, payload });
  const share = (subject: string, who: Who, granteeUserId: string, accessLevel: 'view' | 'comment' | 'edit') =>
    call('POST', `${subject}/shares`, who, { granteeUserId, accessLevel });
  const grantRows = (subjectId: string) => getDb().selectFrom('share_grants').selectAll().where('subject_id', '=', subjectId).execute();

  beforeEach(async () => {
    await resetDatabase();
    await seedFlowchartDiagramType();
    for (const who of ['owner', 'admin', 'editor', 'commenter', 'viewer', 'stranger'] as Who[]) {
      ids[who] = (await seedUser({ email: `${who}@example.com`, password: `${who}-pass`, role: who === 'admin' ? 'admin' : 'architect' })).id; // gitleaks:allow
      const login = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email: `${who}@example.com`, password: `${who}-pass` } }); // gitleaks:allow
      cookies[who] = String(login.headers['set-cookie']).split(';')[0];
    }
    projectId = (await seedProject('Owned', ids.owner)).id;
    const created = await call('POST', `/projects/${projectId}/diagrams`, 'owner', { name: 'Diagram', diagramTypeId: 'flowchart' });
    diagramId = created.json().diagram.id;
    for (const [who, level] of [['editor', 'edit'], ['commenter', 'comment'], ['viewer', 'view']] as const) {
      expect((await share(`/diagrams/${diagramId}`, 'owner', ids[who], level)).statusCode).toBe(201);
    }
  });

  describe('diagram shares', () => {
    it('someone without edit access cannot grant anyone -- themselves included -- access', async () => {
      for (const who of ['stranger', 'viewer', 'commenter'] as Who[]) {
        const res = await share(`/diagrams/${diagramId}`, who, ids[who], 'edit');
        expect(res.statusCode, `${who}: ${res.body}`).toBe(403);
      }
      const rows = await grantRows(diagramId);
      expect(rows.find((r) => r.grantee_user_id === ids.stranger)).toBeUndefined();
      expect(rows.find((r) => r.grantee_user_id === ids.viewer)?.access_level).toBe('view');
      expect(rows.find((r) => r.grantee_user_id === ids.commenter)?.access_level).toBe('comment');
    });

    it('the owner, an admin and an editor can share', async () => {
      for (const who of ['owner', 'admin', 'editor'] as Who[]) {
        expect((await share(`/diagrams/${diagramId}`, who, ids.stranger, 'view')).statusCode, who).toBe(201);
      }
    });

    it('the list needs view access', async () => {
      expect((await call('GET', `/diagrams/${diagramId}/shares`, 'stranger')).statusCode).toBe(403);
      for (const who of ['viewer', 'commenter', 'editor', 'owner', 'admin'] as Who[]) {
        expect((await call('GET', `/diagrams/${diagramId}/shares`, who)).statusCode, who).toBe(200);
      }
    });

    it('revoking needs edit access to the diagram', async () => {
      const viewerGrant = (await grantRows(diagramId)).find((r) => r.grantee_user_id === ids.viewer)!;
      for (const who of ['stranger', 'viewer', 'commenter'] as Who[]) {
        expect((await call('DELETE', `/shares/${viewerGrant.id}`, who)).statusCode, who).toBe(403);
      }
      expect((await grantRows(diagramId)).some((r) => r.id === viewerGrant.id)).toBe(true);
      expect((await call('DELETE', `/shares/${viewerGrant.id}`, 'editor')).statusCode).toBe(204);
      expect((await grantRows(diagramId)).some((r) => r.id === viewerGrant.id)).toBe(false);
    });

    it('a missing or deleted diagram, or grant, is 404 -- no grant is created on it', async () => {
      const missing = '00000000-0000-4000-8000-000000000000';
      expect((await share(`/diagrams/${missing}`, 'admin', ids.stranger, 'view')).statusCode).toBe(404);
      expect((await call('GET', `/diagrams/${missing}/shares`, 'admin')).statusCode).toBe(404);
      expect(await grantRows(missing)).toEqual([]);
      expect((await call('DELETE', `/shares/${missing}`, 'admin')).statusCode).toBe(404);

      expect((await app.inject({ method: 'DELETE', url: `/diagrams/${diagramId}`, headers: { cookie: cookies.owner } })).statusCode).toBe(204);
      expect((await share(`/diagrams/${diagramId}`, 'owner', ids.stranger, 'view')).statusCode).toBe(404);
    });

    it('signed out is 401', async () => {
      expect((await app.inject({ method: 'POST', url: `/diagrams/${diagramId}/shares`, payload: { granteeUserId: ids.stranger, accessLevel: 'edit' } })).statusCode).toBe(401);
      expect((await app.inject({ method: 'GET', url: `/diagrams/${diagramId}/shares` })).statusCode).toBe(401);
    });
  });

  describe('project shares', () => {
    it('only someone with edit access to the project can share it, revoke, or (with view) list', async () => {
      // stranger has no project access at all
      expect((await share(`/projects/${projectId}`, 'stranger', ids.stranger, 'edit')).statusCode).toBe(403);
      expect((await call('GET', `/projects/${projectId}/shares`, 'stranger')).statusCode).toBe(403);
      expect((await share(`/projects/${projectId}`, 'owner', ids.viewer, 'view')).statusCode).toBe(201);
      // a project viewer can list but not share or revoke
      expect((await call('GET', `/projects/${projectId}/shares`, 'viewer')).statusCode).toBe(200);
      expect((await share(`/projects/${projectId}`, 'viewer', ids.stranger, 'view')).statusCode).toBe(403);
      const grant = (await grantRows(projectId)).find((r) => r.grantee_user_id === ids.viewer)!;
      expect((await call('DELETE', `/shares/${grant.id}`, 'viewer')).statusCode).toBe(403);
      expect((await call('DELETE', `/shares/${grant.id}`, 'admin')).statusCode).toBe(204);
    });

    it('a missing project is 404', async () => {
      const missing = '00000000-0000-4000-8000-000000000000';
      expect((await share(`/projects/${missing}`, 'admin', ids.stranger, 'view')).statusCode).toBe(404);
      expect(await grantRows(missing)).toEqual([]);
    });
  });
});
