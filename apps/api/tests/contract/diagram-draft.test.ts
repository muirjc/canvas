import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/db/client.js';
import { DRAFT_RETENTION_HOURS, findAbandonedDraftIds, purgeExpiredDiagrams } from '../../src/diagrams/diagram.service.js';
import { buildTestApp, closeTestDb, resetDatabase, seedFlowchartDiagramType, seedProject, seedUser } from '../helpers/setup.js';

/**
 * canvas-j6v: Create with AI makes a DRAFT. Nothing is saved for the user: the draft is in no list
 * and exists only for its creator until their first Save; discarding it deletes it outright.
 */
describe('AI drafts', () => {
  let app: FastifyInstance;
  let aliceCookie: string;
  let adminCookie: string;
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

  const get = (url: string, cookie: string) => app.inject({ method: 'GET', url, headers: { cookie } });

  async function createDraft(): Promise<{ id: string; currentVersionId: string; draft: boolean }> {
    const response = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/diagrams`,
      headers: { cookie: aliceCookie },
      payload: { name: 'AI drawn', diagramTypeId: 'flowchart', draft: true },
    });
    expect(response.statusCode).toBe(201);
    return response.json().diagram;
  }

  beforeEach(async () => {
    await resetDatabase();
    await seedFlowchartDiagramType();
    const alice = await seedUser({ email: 'alice@example.com', password: 'alice-pass', role: 'architect' });
    await seedUser({ email: 'admin@example.com', password: 'admin-pass', role: 'admin' });
    projectId = (await seedProject('Shared', alice.id)).id;
    aliceCookie = await login('alice@example.com', 'alice-pass');
    adminCookie = await login('admin@example.com', 'admin-pass');
  });

  it('is in no list until saved, and only its creator can open it', async () => {
    const draft = await createDraft();
    expect(draft.draft).toBe(true);
    expect((await get(`/diagrams/${draft.id}`, aliceCookie)).statusCode).toBe(200);
    expect((await get(`/diagrams/${draft.id}`, adminCookie)).statusCode).toBe(404);

    const tree = await get(`/projects/${projectId}/tree`, aliceCookie);
    expect(tree.statusCode).toBe(200);
    expect(tree.body).not.toContain(draft.id);
    const search = await get(`/projects/${projectId}/diagrams?query=AI`, aliceCookie);
    expect(search.statusCode).toBe(200);
    expect(search.body).not.toContain(draft.id);
    const projects = (await get('/projects', aliceCookie)).json().projects;
    expect(projects.find((p: { id: string }) => p.id === projectId).diagramCount).toBe(0);
  });

  it('becomes an ordinary diagram on its first Save', async () => {
    const draft = await createDraft();
    const saved = await app.inject({
      method: 'PATCH',
      url: `/diagrams/${draft.id}`,
      headers: { cookie: aliceCookie },
      payload: { baseVersionId: draft.currentVersionId, dslContent: 'flowchart TD\n  A[Start]\n' },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().diagram.draft).toBe(false);
    expect((await get(`/diagrams/${draft.id}`, adminCookie)).statusCode).toBe(200);
    expect(JSON.stringify((await get(`/projects/${projectId}/tree`, aliceCookie)).json())).toContain(draft.id);
  });

  it('discarding it deletes it outright -- not into the recycle bin', async () => {
    const draft = await createDraft();
    const deleted = await app.inject({ method: 'DELETE', url: `/diagrams/${draft.id}`, headers: { cookie: aliceCookie } });
    expect(deleted.statusCode).toBe(204);
    expect(await getDb().selectFrom('diagrams').select('id').where('id', '=', draft.id).executeTakeFirst()).toBeUndefined();
    const bin = await get('/admin/deleted-diagrams', adminCookie);
    expect(bin.statusCode).toBe(200);
    expect(bin.body).not.toContain(draft.id);
  });

  it('nobody else can delete or change it', async () => {
    const draft = await createDraft();
    expect((await app.inject({ method: 'DELETE', url: `/diagrams/${draft.id}`, headers: { cookie: adminCookie } })).statusCode).toBe(404);
    const save = await app.inject({
      method: 'PATCH',
      url: `/diagrams/${draft.id}`,
      headers: { cookie: adminCookie },
      payload: { baseVersionId: draft.currentVersionId, dslContent: 'flowchart TD\n  X[Admin]\n' },
    });
    expect(save.statusCode).toBe(404);
  });

  it('an abandoned draft is purged after a day; a saved diagram never is', async () => {
    const abandoned = await createDraft();
    const fresh = await createDraft();
    const old = new Date(Date.now() - (DRAFT_RETENTION_HOURS + 1) * 3600 * 1000);
    await getDb().updateTable('diagrams').set({ created_at: old }).where('id', '=', abandoned.id).execute();
    expect(await findAbandonedDraftIds()).toEqual([abandoned.id]);
    const { purgedDiagramIds } = await purgeExpiredDiagrams();
    expect(purgedDiagramIds).toEqual([abandoned.id]);
    expect((await get(`/diagrams/${fresh.id}`, aliceCookie)).statusCode).toBe(200);
  });
});
