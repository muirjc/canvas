import type { FastifyInstance } from 'fastify';
import { MockLanguageModelV4 } from 'ai/test';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { runMigrations } from '../../src/db/migrate.js';
import { getPool } from '../../src/db/pool.js';
import { closeTestDb, resetDatabase, seedFlowchartDiagramType, seedProject, seedUser } from '../helpers/setup.js';

/**
 * 010-ai-diagram-knowledge, T025 (User Story 4, contracts/api-ai-chat-contract.md "Persona
 * reference-material administration"): the 4 admin-only CRUD routes on
 * `/admin/ai-personas/:id/reference-material` (and `.../:personaId/reference-material/:entryId`),
 * plus FR-009's "existing chat history unaffected by an edit/delete" guarantee.
 */
function noToolCallResult(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    finishReason: { unified: 'stop' as const, raw: undefined },
    usage: {
      inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: undefined, text: undefined, reasoning: undefined },
    },
    warnings: [],
  };
}

function extractCookie(response: { headers: { 'set-cookie'?: string | string[] } }): string {
  return (Array.isArray(response.headers['set-cookie']) ? response.headers['set-cookie'][0] : response.headers['set-cookie'])!.split(';')[0];
}

describe('Persona reference-material admin API contract (010-ai-diagram-knowledge, T025)', () => {
  let app: FastifyInstance;
  let adminCookie: string;
  let architectCookie: string;
  let personaId: string;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    const config = loadConfig();
    config.allowLocalAuth = true;
    await runMigrations();
    app = await buildApp({
      config,
      logger: false,
      languageModel: new MockLanguageModelV4({ doGenerate: noToolCallResult('Okay, done.') }),
    });
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  beforeEach(async () => {
    await resetDatabase();
    await seedUser({ email: 'admin@example.com', password: 'admin-pass', role: 'admin' });
    await seedUser({ email: 'architect@example.com', password: 'architect-pass' });

    const adminLogin = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email: 'admin@example.com', password: 'admin-pass' } });
    adminCookie = extractCookie(adminLogin);
    const architectLogin = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email: 'architect@example.com', password: 'architect-pass' } });
    architectCookie = extractCookie(architectLogin);

    const pool = getPool();
    const { rows } = await pool.query<{ id: string }>(
      "INSERT INTO ai_personas (name, category, system_prompt) VALUES ('Ref Persona', 'Business', 'You are a helpful assistant.') RETURNING id",
    );
    personaId = rows[0].id;
  });

  it('creates an entry and returns its full shape (201)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/admin/ai-personas/${personaId}/reference-material`,
      headers: { cookie: adminCookie },
      payload: { content: 'Always prefer solid lines over dashed for primary flows.', diagramFamilies: ['flowchart'] },
    });
    expect(response.statusCode).toBe(201);
    const entry = response.json().entry;
    expect(entry).toMatchObject({
      personaId,
      content: 'Always prefer solid lines over dashed for primary flows.',
      diagramFamilies: ['flowchart'],
    });
    expect(entry.id).toEqual(expect.any(String));
    expect(entry.createdAt).toEqual(expect.any(String));
    expect(entry.updatedAt).toEqual(expect.any(String));
  });

  it('defaults diagramFamilies to [] (unscoped) when omitted', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/admin/ai-personas/${personaId}/reference-material`,
      headers: { cookie: adminCookie },
      payload: { content: 'Unscoped guidance.' },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().entry.diagramFamilies).toEqual([]);
  });

  it('defaults diagramFamilies to [] (unscoped) when given an empty array', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/admin/ai-personas/${personaId}/reference-material`,
      headers: { cookie: adminCookie },
      payload: { content: 'Unscoped guidance.', diagramFamilies: [] },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().entry.diagramFamilies).toEqual([]);
  });

  it('rejects empty content with 400', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/admin/ai-personas/${personaId}/reference-material`,
      headers: { cookie: adminCookie },
      payload: { content: '' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toEqual(expect.any(String));
  });

  it('rejects whitespace-only content with 400', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/admin/ai-personas/${personaId}/reference-material`,
      headers: { cookie: adminCookie },
      payload: { content: '   \n\t  ' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects an invalid diagramFamilies value with 400, message mentions the invalid value', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/admin/ai-personas/${personaId}/reference-material`,
      headers: { cookie: adminCookie },
      payload: { content: 'Some content.', diagramFamilies: ['flowchart', 'not-a-real-family'] },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain('not-a-real-family');
  });

  it('lists every entry for a persona, in creation order', async () => {
    const first = await app.inject({
      method: 'POST',
      url: `/admin/ai-personas/${personaId}/reference-material`,
      headers: { cookie: adminCookie },
      payload: { content: 'First entry.' },
    });
    const second = await app.inject({
      method: 'POST',
      url: `/admin/ai-personas/${personaId}/reference-material`,
      headers: { cookie: adminCookie },
      payload: { content: 'Second entry.' },
    });

    const response = await app.inject({
      method: 'GET',
      url: `/admin/ai-personas/${personaId}/reference-material`,
      headers: { cookie: adminCookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().entries.map((e: { id: string }) => e.id)).toEqual([
      first.json().entry.id,
      second.json().entry.id,
    ]);
  });

  it('edits content only, leaving diagramFamilies untouched (partial update)', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/admin/ai-personas/${personaId}/reference-material`,
      headers: { cookie: adminCookie },
      payload: { content: 'Original content.', diagramFamilies: ['erd'] },
    });
    const entryId = created.json().entry.id;

    const response = await app.inject({
      method: 'PATCH',
      url: `/admin/ai-personas/${personaId}/reference-material/${entryId}`,
      headers: { cookie: adminCookie },
      payload: { content: 'Updated content.' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().entry).toMatchObject({ content: 'Updated content.', diagramFamilies: ['erd'] });
  });

  it('edits diagramFamilies only, leaving content untouched (partial update)', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/admin/ai-personas/${personaId}/reference-material`,
      headers: { cookie: adminCookie },
      payload: { content: 'Original content.', diagramFamilies: ['erd'] },
    });
    const entryId = created.json().entry.id;

    const response = await app.inject({
      method: 'PATCH',
      url: `/admin/ai-personas/${personaId}/reference-material/${entryId}`,
      headers: { cookie: adminCookie },
      payload: { diagramFamilies: ['uml', 'c4'] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().entry).toMatchObject({ content: 'Original content.', diagramFamilies: ['uml', 'c4'] });
  });

  it('404s a PATCH for an unknown entryId', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/admin/ai-personas/${personaId}/reference-material/00000000-0000-0000-0000-000000000000`,
      headers: { cookie: adminCookie },
      payload: { content: 'x' },
    });
    expect(response.statusCode).toBe(404);
  });

  it('404s a PATCH when entryId belongs to a different persona than the URL personaId', async () => {
    const pool = getPool();
    const { rows: otherPersona } = await pool.query<{ id: string }>(
      "INSERT INTO ai_personas (name, category, system_prompt) VALUES ('Other Persona', 'Technical', 'x') RETURNING id",
    );
    const created = await app.inject({
      method: 'POST',
      url: `/admin/ai-personas/${otherPersona[0].id}/reference-material`,
      headers: { cookie: adminCookie },
      payload: { content: 'Belongs to other persona.' },
    });
    const entryId = created.json().entry.id;

    const response = await app.inject({
      method: 'PATCH',
      url: `/admin/ai-personas/${personaId}/reference-material/${entryId}`,
      headers: { cookie: adminCookie },
      payload: { content: 'Hijacked?' },
    });
    expect(response.statusCode).toBe(404);

    // Confirm it truly wasn't touched.
    const stillThere = await app.inject({
      method: 'GET',
      url: `/admin/ai-personas/${otherPersona[0].id}/reference-material`,
      headers: { cookie: adminCookie },
    });
    expect(stillThere.json().entries[0].content).toBe('Belongs to other persona.');
  });

  it('deletes an entry (204), confirmed gone via a follow-up GET', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/admin/ai-personas/${personaId}/reference-material`,
      headers: { cookie: adminCookie },
      payload: { content: 'Delete me.' },
    });
    const entryId = created.json().entry.id;

    const deleteResponse = await app.inject({
      method: 'DELETE',
      url: `/admin/ai-personas/${personaId}/reference-material/${entryId}`,
      headers: { cookie: adminCookie },
    });
    expect(deleteResponse.statusCode).toBe(204);

    const listResponse = await app.inject({
      method: 'GET',
      url: `/admin/ai-personas/${personaId}/reference-material`,
      headers: { cookie: adminCookie },
    });
    expect(listResponse.json().entries).toEqual([]);
  });

  it('404s a DELETE for an unknown entryId', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: `/admin/ai-personas/${personaId}/reference-material/00000000-0000-0000-0000-000000000000`,
      headers: { cookie: adminCookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it('404s GET/POST for an unknown persona id', async () => {
    const unknownPersonaId = '00000000-0000-0000-0000-000000000000';

    const getResponse = await app.inject({
      method: 'GET',
      url: `/admin/ai-personas/${unknownPersonaId}/reference-material`,
      headers: { cookie: adminCookie },
    });
    expect(getResponse.statusCode).toBe(404);

    const postResponse = await app.inject({
      method: 'POST',
      url: `/admin/ai-personas/${unknownPersonaId}/reference-material`,
      headers: { cookie: adminCookie },
      payload: { content: 'x' },
    });
    expect(postResponse.statusCode).toBe(404);
  });

  it('denies a non-admin (403) on all 4 routes', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/admin/ai-personas/${personaId}/reference-material`,
      headers: { cookie: adminCookie },
      payload: { content: 'Admin-created for the 403 checks.' },
    });
    const entryId = created.json().entry.id;

    const getResponse = await app.inject({
      method: 'GET',
      url: `/admin/ai-personas/${personaId}/reference-material`,
      headers: { cookie: architectCookie },
    });
    expect(getResponse.statusCode).toBe(403);

    const postResponse = await app.inject({
      method: 'POST',
      url: `/admin/ai-personas/${personaId}/reference-material`,
      headers: { cookie: architectCookie },
      payload: { content: 'x' },
    });
    expect(postResponse.statusCode).toBe(403);

    const patchResponse = await app.inject({
      method: 'PATCH',
      url: `/admin/ai-personas/${personaId}/reference-material/${entryId}`,
      headers: { cookie: architectCookie },
      payload: { content: 'x' },
    });
    expect(patchResponse.statusCode).toBe(403);

    const deleteResponse = await app.inject({
      method: 'DELETE',
      url: `/admin/ai-personas/${personaId}/reference-material/${entryId}`,
      headers: { cookie: architectCookie },
    });
    expect(deleteResponse.statusCode).toBe(403);
  });

  it("FR-009: editing/deleting a persona's reference material never touches already-persisted chat history", async () => {
    await seedFlowchartDiagramType();
    const architect = await seedUser({ email: 'chat-architect@example.com', password: 'architect-pass' });
    const architectChatLogin = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email: 'chat-architect@example.com', password: 'architect-pass' } });
    const chatArchitectCookie = extractCookie(architectChatLogin);
    const projectId = (await seedProject('Ref Material Project', architect.id)).id;

    await getPool().query('UPDATE ai_settings SET chat_enabled = true');

    const createDiagramResponse = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/diagrams`,
      headers: { cookie: chatArchitectCookie },
      payload: { name: 'Ref Material Diagram', diagramTypeId: 'flowchart' },
    });
    const diagramId = createDiagramResponse.json().diagram.id;

    const created = await app.inject({
      method: 'POST',
      url: `/admin/ai-personas/${personaId}/reference-material`,
      headers: { cookie: adminCookie },
      payload: { content: 'Original reference material.' },
    });
    const entryId = created.json().entry.id;

    const chatResponse = await app.inject({
      method: 'POST',
      url: `/diagrams/${diagramId}/chat/messages`,
      headers: { cookie: chatArchitectCookie },
      payload: { message: 'hello', currentDslContent: 'flowchart TD\n', personaId },
    });
    expect(chatResponse.statusCode).toBe(200);

    const before = await app.inject({
      method: 'GET',
      url: `/diagrams/${diagramId}/chat/messages`,
      headers: { cookie: chatArchitectCookie },
    });
    expect(before.statusCode).toBe(200);
    const beforeMessages = before.json();

    const patchResponse = await app.inject({
      method: 'PATCH',
      url: `/admin/ai-personas/${personaId}/reference-material/${entryId}`,
      headers: { cookie: adminCookie },
      payload: { content: 'Edited reference material.' },
    });
    expect(patchResponse.statusCode).toBe(200);

    const deleteResponse = await app.inject({
      method: 'DELETE',
      url: `/admin/ai-personas/${personaId}/reference-material/${entryId}`,
      headers: { cookie: adminCookie },
    });
    expect(deleteResponse.statusCode).toBe(204);

    const after = await app.inject({
      method: 'GET',
      url: `/diagrams/${diagramId}/chat/messages`,
      headers: { cookie: chatArchitectCookie },
    });
    expect(after.statusCode).toBe(200);
    expect(after.json()).toEqual(beforeMessages);
  });
});
