import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, closeTestDb, resetDatabase, seedFlowchartDiagramType, seedProject, seedUser } from '../helpers/setup.js';
import { getPool } from '../../src/db/pool.js';
import { findExpiredDiagramIds, purgeExpiredDiagrams } from '../../src/diagrams/diagram.service.js';

/**
 * jmuir-yvh: soft-deleted diagrams past their retention window were excluded from queries and
 * blocked from restore, but no code path ever physically deleted the rows — a deliberate
 * deferral (specs/002-editing-lifecycle-enhancements/research.md §1), not a bug, but one this
 * closes. No HTTP route exists for this on purpose (it's an ops-run script,
 * apps/api/src/purge/run.ts, not a user-facing action) — tested directly against the service
 * functions rather than through app.inject(), unlike this file's sibling
 * diagram-delete-restore.test.ts.
 */
describe('purgeExpiredDiagrams()', () => {
  let app: FastifyInstance;
  let ownerCookie: string;
  let ownerId: string;
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

  beforeEach(async () => {
    await resetDatabase();
    await seedFlowchartDiagramType();
    ownerId = (await seedUser({ email: 'owner@example.com', password: 'owner-pass' })).id;
    projectId = (await seedProject('Test Project', ownerId)).id;
    ownerCookie = await login('owner@example.com', 'owner-pass');
  });

  async function createDiagram(name: string): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/diagrams`,
      headers: { cookie: ownerCookie },
      payload: { name, diagramTypeId: 'flowchart' },
    });
    return response.json().diagram.id;
  }

  async function softDeleteAndAge(id: string, ageDays: number): Promise<void> {
    const pool = getPool();
    await pool.query("UPDATE diagrams SET deleted_at = now() - make_interval(days => $2) WHERE id = $1", [id, ageDays]);
  }

  it('leaves an active (never-deleted) diagram untouched', async () => {
    const id = await createDiagram('Active Diagram');

    const result = await purgeExpiredDiagrams();

    expect(result.purgedDiagramIds).toEqual([]);
    const { rows } = await getPool().query('SELECT 1 FROM diagrams WHERE id = $1', [id]);
    expect(rows).toHaveLength(1);
  });

  it('leaves a soft-deleted diagram still within its retention window untouched', async () => {
    const id = await createDiagram('Recently Deleted');
    await softDeleteAndAge(id, 10); // well within the 30-day window

    expect(await findExpiredDiagramIds()).toEqual([]);
    const result = await purgeExpiredDiagrams();
    expect(result.purgedDiagramIds).toEqual([]);
    const { rows } = await getPool().query('SELECT 1 FROM diagrams WHERE id = $1', [id]);
    expect(rows).toHaveLength(1);
  });

  it('physically deletes a diagram whose retention window has fully elapsed', async () => {
    const id = await createDiagram('Long Gone');
    await softDeleteAndAge(id, 31);

    expect(await findExpiredDiagramIds()).toEqual([id]);
    const result = await purgeExpiredDiagrams();

    expect(result.purgedDiagramIds).toEqual([id]);
    const { rows } = await getPool().query('SELECT 1 FROM diagrams WHERE id = $1', [id]);
    expect(rows).toHaveLength(0);
  });

  it('is exactly boundary-consistent with restoreDiagram\'s own retention check: an expired diagram cannot be restored either', async () => {
    const id = await createDiagram('At The Boundary');
    await softDeleteAndAge(id, 30); // restoreDiagram() treats exactly 30 days as expired too

    expect(await findExpiredDiagramIds()).toEqual([id]);
  });

  it('deletes dependent diagram_versions, diagram_chats, chat_messages, and share_grants along with the diagram', async () => {
    const pool = getPool();
    const id = await createDiagram('Diagram With Dependents');

    const otherUserId = (await seedUser({ email: 'other@example.com', password: 'other-pass' })).id;
    await pool.query(
      `INSERT INTO share_grants (subject_type, subject_id, grantee_user_id, access_level, granted_by_user_id)
       VALUES ('diagram', $1, $2, 'view', $3)`,
      [id, otherUserId, ownerId],
    );

    const { rows: chatRows } = await pool.query<{ id: string }>(
      'INSERT INTO diagram_chats (diagram_id) VALUES ($1) RETURNING id',
      [id],
    );
    const chatId = chatRows[0].id;
    await pool.query(
      "INSERT INTO chat_messages (diagram_chat_id, role, content) VALUES ($1, 'user', 'hello')",
      [chatId],
    );

    await softDeleteAndAge(id, 45);

    const result = await purgeExpiredDiagrams();
    expect(result.purgedDiagramIds).toEqual([id]);

    const { rows: versionRows } = await pool.query('SELECT 1 FROM diagram_versions WHERE diagram_id = $1', [id]);
    expect(versionRows).toHaveLength(0);
    const { rows: chatRowsAfter } = await pool.query('SELECT 1 FROM diagram_chats WHERE diagram_id = $1', [id]);
    expect(chatRowsAfter).toHaveLength(0);
    const { rows: messageRowsAfter } = await pool.query('SELECT 1 FROM chat_messages WHERE diagram_chat_id = $1', [chatId]);
    expect(messageRowsAfter).toHaveLength(0);
    const { rows: grantRowsAfter } = await pool.query(
      "SELECT 1 FROM share_grants WHERE subject_type = 'diagram' AND subject_id = $1",
      [id],
    );
    expect(grantRowsAfter).toHaveLength(0);
  });

  it('purges multiple expired diagrams in one call and leaves unrelated ones alone', async () => {
    const expiredOne = await createDiagram('Expired One');
    const expiredTwo = await createDiagram('Expired Two');
    const stillActive = await createDiagram('Still Active');
    const withinWindow = await createDiagram('Within Window');
    await softDeleteAndAge(expiredOne, 31);
    await softDeleteAndAge(expiredTwo, 90);
    await softDeleteAndAge(withinWindow, 5);

    const result = await purgeExpiredDiagrams();

    expect(result.purgedDiagramIds.sort()).toEqual([expiredOne, expiredTwo].sort());
    const { rows } = await getPool().query('SELECT id FROM diagrams ORDER BY name');
    expect(rows.map((r) => r.id).sort()).toEqual([stillActive, withinWindow].sort());
  });
});
