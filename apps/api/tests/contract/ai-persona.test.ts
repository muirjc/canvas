import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, closeTestDb, resetDatabase, seedFlowchartDiagramType, seedProject, seedUser } from '../helpers/setup.js';
import { getPool } from '../../src/db/pool.js';

/**
 * Feature 004, User Story 1: `GET /ai-personas` — the source for the chat's persona-selection
 * dropdown (FR-005), listing only active personas grouped by category. Full admin CRUD
 * (create/edit/archive) is covered separately in User Story 3's extension of this file.
 */
describe('AI persona API contract', () => {
  let app: FastifyInstance;
  let architectCookie: string;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  beforeEach(async () => {
    await resetDatabase();
    await seedUser({ email: 'architect@example.com', password: 'architect-pass' });

    const login = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email: 'architect@example.com', password: 'architect-pass' } });
    architectCookie = (Array.isArray(login.headers['set-cookie']) ? login.headers['set-cookie'][0] : login.headers['set-cookie'])!.split(';')[0];
  });

  async function insertPersona(name: string, category: string, status: 'active' | 'archived' = 'active') {
    const pool = getPool();
    const { rows } = await pool.query<{ id: string }>(
      'INSERT INTO ai_personas (name, category, system_prompt, status) VALUES ($1, $2, $3, $4) RETURNING id',
      [name, category, 'You are a helpful assistant.', status],
    );
    return rows[0].id;
  }

  it('lists active personas, available to any authenticated user', async () => {
    await insertPersona('Business Architect', 'Business');
    await insertPersona('Enterprise Architect', 'Enterprise');

    const response = await app.inject({ method: 'GET', url: '/ai-personas', headers: { cookie: architectCookie } });
    expect(response.statusCode).toBe(200);
    const names = response.json().personas.map((p: { name: string }) => p.name);
    expect(names).toEqual(expect.arrayContaining(['Business Architect', 'Enterprise Architect']));
  });

  it('excludes archived personas', async () => {
    await insertPersona('Retired Persona', 'Technical', 'archived');

    const response = await app.inject({ method: 'GET', url: '/ai-personas', headers: { cookie: architectCookie } });
    const names = response.json().personas.map((p: { name: string }) => p.name);
    expect(names).not.toContain('Retired Persona');
  });

  it('requires authentication', async () => {
    const response = await app.inject({ method: 'GET', url: '/ai-personas' });
    expect(response.statusCode).toBe(401);
  });
});

/**
 * Feature 004, User Story 3: admin persona CRUD (create/edit/archive). Reuses the same
 * `buildTestApp()`/`ai_personas` fixtures as the read-only describe block above.
 */
describe('Admin persona CRUD API contract', () => {
  let app: FastifyInstance;
  let adminCookie: string;
  let architectCookie: string;

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

    const adminLogin = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email: 'admin@example.com', password: 'admin-pass' } });
    adminCookie = (Array.isArray(adminLogin.headers['set-cookie']) ? adminLogin.headers['set-cookie'][0] : adminLogin.headers['set-cookie'])!.split(';')[0];

    const architectLogin = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email: 'architect@example.com', password: 'architect-pass' } });
    architectCookie = (Array.isArray(architectLogin.headers['set-cookie']) ? architectLogin.headers['set-cookie'][0] : architectLogin.headers['set-cookie'])!.split(';')[0];
  });

  it('lets an admin create a persona, which then appears in the active list', async () => {
    const createResponse = await app.inject({
      method: 'POST',
      url: '/admin/ai-personas',
      headers: { cookie: adminCookie },
      payload: { name: 'Cloud Architect', category: 'Solution', systemPrompt: 'You are a cloud-focused solution architect.' },
    });
    expect(createResponse.statusCode).toBe(201);
    const created = createResponse.json().persona;
    expect(created.status).toBe('active');

    const listResponse = await app.inject({ method: 'GET', url: '/ai-personas', headers: { cookie: architectCookie } });
    expect(listResponse.json().personas.map((p: { name: string }) => p.name)).toContain('Cloud Architect');
  });

  it('rejects a create with an invalid category', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/admin/ai-personas',
      headers: { cookie: adminCookie },
      payload: { name: 'Bad Category', category: 'NotACategory', systemPrompt: 'x' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('allows multiple personas in the same category, as distinct options', async () => {
    await app.inject({
      method: 'POST',
      url: '/admin/ai-personas',
      headers: { cookie: adminCookie },
      payload: { name: 'Persona One', category: 'Business', systemPrompt: 'x' },
    });
    await app.inject({
      method: 'POST',
      url: '/admin/ai-personas',
      headers: { cookie: adminCookie },
      payload: { name: 'Persona Two', category: 'Business', systemPrompt: 'y' },
    });

    const listResponse = await app.inject({ method: 'GET', url: '/ai-personas', headers: { cookie: architectCookie } });
    const names = listResponse.json().personas.map((p: { name: string }) => p.name);
    expect(names).toEqual(expect.arrayContaining(['Persona One', 'Persona Two']));
  });

  it('lets an admin edit a persona; subsequent reads reflect the change', async () => {
    const createResponse = await app.inject({
      method: 'POST',
      url: '/admin/ai-personas',
      headers: { cookie: adminCookie },
      payload: { name: 'Original Name', category: 'Technical', systemPrompt: 'Original prompt.' },
    });
    const id = createResponse.json().persona.id;

    const patchResponse = await app.inject({
      method: 'PATCH',
      url: `/admin/ai-personas/${id}`,
      headers: { cookie: adminCookie },
      payload: { systemPrompt: 'Updated prompt.' },
    });
    expect(patchResponse.statusCode).toBe(200);
    expect(patchResponse.json().persona.systemPrompt).toBe('Updated prompt.');
  });

  it('lets an admin archive a persona, idempotently, without disturbing an existing DiagramChat reference', async () => {
    const createResponse = await app.inject({
      method: 'POST',
      url: '/admin/ai-personas',
      headers: { cookie: adminCookie },
      payload: { name: 'To Archive', category: 'Enterprise', systemPrompt: 'x' },
    });
    const id = createResponse.json().persona.id;

    await seedFlowchartDiagramType();
    const projectId = (await seedProject()).id;
    const diagramResponse = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/diagrams`,
      headers: { cookie: architectCookie },
      payload: { name: 'Diagram Using Archived Persona', diagramTypeId: 'flowchart' },
    });
    const diagramId = diagramResponse.json().diagram.id;
    const pool = getPool();
    await pool.query('INSERT INTO diagram_chats (diagram_id, persona_id) VALUES ($1, $2)', [diagramId, id]);

    const archiveResponse = await app.inject({ method: 'POST', url: `/admin/ai-personas/${id}/archive`, headers: { cookie: adminCookie } });
    expect(archiveResponse.statusCode).toBe(200);
    expect(archiveResponse.json().persona.status).toBe('archived');

    // Archiving again is a no-op, not an error.
    const secondArchiveResponse = await app.inject({ method: 'POST', url: `/admin/ai-personas/${id}/archive`, headers: { cookie: adminCookie } });
    expect(secondArchiveResponse.statusCode).toBe(200);

    const listResponse = await app.inject({ method: 'GET', url: '/ai-personas', headers: { cookie: architectCookie } });
    expect(listResponse.json().personas.map((p: { name: string }) => p.name)).not.toContain('To Archive');

    const { rows } = await pool.query('SELECT persona_id FROM diagram_chats WHERE diagram_id = $1', [diagramId]);
    expect(rows[0].persona_id).toBe(id);
  });

  it('denies a non-admin from creating, editing, or archiving personas', async () => {
    const createResponse = await app.inject({
      method: 'POST',
      url: '/admin/ai-personas',
      headers: { cookie: architectCookie },
      payload: { name: 'Denied', category: 'Business', systemPrompt: 'x' },
    });
    expect(createResponse.statusCode).toBe(403);

    const patchResponse = await app.inject({
      method: 'PATCH',
      url: '/admin/ai-personas/00000000-0000-0000-0000-000000000000',
      headers: { cookie: architectCookie },
      payload: { name: 'Denied' },
    });
    expect(patchResponse.statusCode).toBe(403);

    const archiveResponse = await app.inject({
      method: 'POST',
      url: '/admin/ai-personas/00000000-0000-0000-0000-000000000000/archive',
      headers: { cookie: architectCookie },
    });
    expect(archiveResponse.statusCode).toBe(403);
  });
});
