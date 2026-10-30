import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/db/client.js';
import { buildTestApp, closeTestDb, resetDatabase, seedFlowchartDiagramType, seedProject, seedUser } from '../helpers/setup.js';

/**
 * canvas-obp0: two people editing one diagram. A save names the version it started from and is
 * refused (409, saying who saved and when) if another save replaced that version first. Presence:
 * an open editor heartbeats and hears who else has the diagram open.
 */
describe('Edit conflicts and presence', () => {
  let app: FastifyInstance;
  let aliceCookie: string;
  let bobCookie: string;
  let viewerCookie: string;
  let diagramId: string;

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

  const save = (cookie: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'PATCH', url: `/diagrams/${diagramId}`, headers: { cookie }, payload });
  const load = async (cookie: string) =>
    (await app.inject({ method: 'GET', url: `/diagrams/${diagramId}`, headers: { cookie } })).json().diagram;
  const heartbeat = (cookie: string, sessionId: string) =>
    app.inject({ method: 'PUT', url: `/diagrams/${diagramId}/presence`, headers: { cookie }, payload: { sessionId } });

  beforeEach(async () => {
    await resetDatabase();
    await seedFlowchartDiagramType();
    const alice = await seedUser({ email: 'alice@example.com', password: 'alice-pass', name: 'Alice Archer' });
    const bob = await seedUser({ email: 'bob@example.com', password: 'bob-pass', name: 'Bob Builder' });
    const viewer = await seedUser({ email: 'viewer@example.com', password: 'viewer-pass', name: 'Vic Viewer' });
    const projectId = (await seedProject('Shared', alice.id)).id;
    aliceCookie = await login('alice@example.com', 'alice-pass');
    bobCookie = await login('bob@example.com', 'bob-pass');
    viewerCookie = await login('viewer@example.com', 'viewer-pass');
    diagramId = (
      await app.inject({
        method: 'POST',
        url: `/projects/${projectId}/diagrams`,
        headers: { cookie: aliceCookie },
        payload: { name: 'Shared', diagramTypeId: 'flowchart', initialDslContent: 'flowchart TD\n  A[Start]\n' },
      })
    ).json().diagram.id;
    for (const [user, level] of [[bob.id, 'edit'], [viewer.id, 'view']] as const) {
      const grant = await app.inject({
        method: 'POST',
        url: `/diagrams/${diagramId}/shares`,
        headers: { cookie: aliceCookie },
        payload: { granteeUserId: user, accessLevel: level },
      });
      expect(grant.statusCode).toBe(201);
    }
  });

  describe('saving', () => {
    it('the diagram says which version it is on, and a save from that version moves it on', async () => {
      const loaded = await load(aliceCookie);
      expect(loaded.currentVersionId).toEqual(expect.any(String));
      const response = await save(aliceCookie, { baseVersionId: loaded.currentVersionId, dslContent: 'flowchart TD\n  A[Two]\n' });
      expect(response.statusCode).toBe(200);
      expect(response.json().diagram.currentVersionId).not.toBe(loaded.currentVersionId);
    });

    it('requires the base version', async () => {
      expect((await save(aliceCookie, { dslContent: 'flowchart TD\n  A[Two]\n' })).statusCode).toBe(400);
    });

    it("refuses a save from a version someone else has replaced, says who and when, and writes nothing", async () => {
      const base = (await load(aliceCookie)).currentVersionId;
      const bobSave = await save(bobCookie, { baseVersionId: base, dslContent: 'flowchart TD\n  B[Bob]\n' });
      expect(bobSave.statusCode).toBe(200);

      const aliceSave = await save(aliceCookie, { baseVersionId: base, dslContent: 'flowchart TD\n  A[Alice]\n' });
      expect(aliceSave.statusCode).toBe(409);
      const body = aliceSave.json();
      expect(body.code).toBe('version_conflict');
      expect(body.error).toContain('Bob Builder');
      expect(body.details.currentVersionId).toBe(bobSave.json().diagram.currentVersionId);
      expect(body.details.savedBy).toMatchObject({ name: 'Bob Builder' });
      expect(Number.isNaN(Date.parse(body.details.savedAt))).toBe(false);

      // Bob's content stands, and Alice's refused save left no version behind.
      expect((await load(aliceCookie)).dslContent).toContain('B[Bob]');
      const versions = await getDb().selectFrom('diagram_versions').select('dsl_content').where('diagram_id', '=', diagramId).execute();
      expect(versions.some((v) => v.dsl_content.includes('A[Alice]'))).toBe(false);
      expect(versions).toHaveLength(2);
    });

    it('saving anyway from the newer version overwrites deliberately, keeping theirs in history', async () => {
      const base = (await load(aliceCookie)).currentVersionId;
      await save(bobCookie, { baseVersionId: base, dslContent: 'flowchart TD\n  B[Bob]\n' });
      const conflict = (await save(aliceCookie, { baseVersionId: base, dslContent: 'flowchart TD\n  A[Alice]\n' })).json();
      const retry = await save(aliceCookie, { baseVersionId: conflict.details.currentVersionId, dslContent: 'flowchart TD\n  A[Alice]\n' });
      expect(retry.statusCode).toBe(200);
      const versions = await getDb().selectFrom('diagram_versions').select('dsl_content').where('diagram_id', '=', diagramId).execute();
      expect(versions.map((v) => v.dsl_content).join('|')).toContain('B[Bob]');
    });

    it('of two saves from the same version at the same moment, exactly one wins', async () => {
      const base = (await load(aliceCookie)).currentVersionId;
      const results = await Promise.all([
        save(aliceCookie, { baseVersionId: base, dslContent: 'flowchart TD\n  A[Alice]\n' }),
        save(bobCookie, { baseVersionId: base, dslContent: 'flowchart TD\n  B[Bob]\n' }),
      ]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    });

    it('restoring on top of a newer save is refused the same way', async () => {
      const base = (await load(aliceCookie)).currentVersionId;
      await save(bobCookie, { baseVersionId: base, dslContent: 'flowchart TD\n  B[Bob]\n' });
      const restore = await app.inject({
        method: 'POST',
        url: `/diagrams/${diagramId}/versions/${base}/restore`,
        headers: { cookie: aliceCookie },
        payload: { baseVersionId: base },
      });
      expect(restore.statusCode).toBe(409);
      expect(restore.json().details.savedBy.name).toBe('Bob Builder');
    });
  });

  describe('presence', () => {
    it("tells each editor who else has the diagram open, and forgets a tab that leaves", async () => {
      expect((await heartbeat(aliceCookie, 'alice-tab')).json().others).toEqual([]);
      const bobView = (await heartbeat(bobCookie, 'bob-tab')).json();
      expect(bobView.heartbeatSeconds).toBe(30);
      expect(bobView.others).toEqual([expect.objectContaining({ name: 'Alice Archer', isYou: false })]);
      expect((await heartbeat(aliceCookie, 'alice-tab')).json().others).toEqual([expect.objectContaining({ name: 'Bob Builder' })]);

      const leave = await app.inject({
        method: 'POST',
        url: `/diagrams/${diagramId}/presence/leave`,
        headers: { cookie: bobCookie },
        payload: { sessionId: 'bob-tab' },
      });
      expect(leave.statusCode).toBe(204);
      expect((await heartbeat(aliceCookie, 'alice-tab')).json().others).toEqual([]);
    });

    it('says when it is you in another tab', async () => {
      await heartbeat(aliceCookie, 'tab-1');
      expect((await heartbeat(aliceCookie, 'tab-2')).json().others).toEqual([expect.objectContaining({ isYou: true, name: 'You' })]);
    });

    it('drops an editor not heard from for 90 seconds', async () => {
      await heartbeat(bobCookie, 'bob-tab');
      const longAgo = new Date(Date.now() - 91_000);
      await getDb().updateTable('diagram_edit_sessions').set({ last_seen_at: longAgo, started_at: longAgo }).execute();
      expect((await heartbeat(aliceCookie, 'alice-tab')).json().others).toEqual([]);
    });

    it('is for editors: a viewer cannot announce themselves', async () => {
      expect((await heartbeat(viewerCookie, 'viewer-tab')).statusCode).toBe(403);
    });
  });
});
