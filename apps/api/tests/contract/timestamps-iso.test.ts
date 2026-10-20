import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { normalizeSqliteTimestamp } from '../../src/db/sqlite-timestamp-plugin.js';
import { buildTestApp, closeTestDb, resetDatabase, seedFlowchartDiagramType, seedProject, seedUser } from '../helpers/setup.js';

/**
 * canvas-d54: SQLite stores CURRENT_TIMESTAMP defaults as 'YYYY-MM-DD HH:MM:SS' (UTC, no zone) and
 * the API returned that verbatim; a browser's new Date() reads a zone-less string as LOCAL time,
 * so every DB-defaulted timestamp showed shifted by the viewer's UTC offset. Postgres returns real
 * Dates (serialized with Z), so it was never affected. Every timestamp the API returns must now be
 * ISO 8601 with Z, on both engines.
 */
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

describe('normalizeSqliteTimestamp (canvas-d54)', () => {
  it('turns SQLite CURRENT_TIMESTAMP text into ISO 8601 UTC', () => {
    expect(normalizeSqliteTimestamp('2026-10-19 13:45:07')).toBe('2026-10-19T13:45:07Z');
    expect(normalizeSqliteTimestamp('2026-10-19 13:45:07.123')).toBe('2026-10-19T13:45:07.123Z');
  });

  it('leaves values that are already ISO, null, or anything else alone', () => {
    expect(normalizeSqliteTimestamp('2026-10-19T13:45:07.123Z')).toBe('2026-10-19T13:45:07.123Z');
    expect(normalizeSqliteTimestamp(null)).toBeNull();
    expect(normalizeSqliteTimestamp('not a date')).toBe('not a date');
    expect(normalizeSqliteTimestamp(12345)).toBe(12345);
  });
});

describe('API timestamps are ISO 8601 UTC on every engine (canvas-d54)', () => {
  let app: FastifyInstance;
  let cookie: string;
  let projectId: string;

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
    const admin = await seedUser({ email: 'admin@example.com', password: 'admin-pass', role: 'admin' });
    projectId = (await seedProject('P', admin.id)).id;
    const login = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email: 'admin@example.com', password: 'admin-pass' } });
    const setCookie = login.headers['set-cookie'];
    cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(';')[0];
  });

  const expectNowish = (value: unknown, label: string) => {
    expect(typeof value, label).toBe('string');
    expect(value, label).toMatch(ISO_UTC);
    // Parsed the way a browser would: within a minute of now, whatever the machine's time zone.
    expect(Math.abs(new Date(value as string).getTime() - Date.now()), label).toBeLessThan(60_000);
  };

  it('a new diagram and its version history report createdAt/updatedAt in UTC', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/diagrams`,
      headers: { cookie },
      payload: { name: 'D', diagramTypeId: 'flowchart', initialDslContent: 'flowchart TD\n  A[Start]\n' },
    });
    expect(created.statusCode).toBe(201);
    const { diagram } = created.json();
    expectNowish(diagram.createdAt, 'diagram.createdAt');
    if (diagram.updatedAt !== undefined) expectNowish(diagram.updatedAt, 'diagram.updatedAt');

    const fetched = (await app.inject({ method: 'GET', url: `/diagrams/${diagram.id}`, headers: { cookie } })).json();
    const d = fetched.diagram ?? fetched;
    expectNowish(d.createdAt, 'GET diagram createdAt');

    const versions = (await app.inject({ method: 'GET', url: `/diagrams/${diagram.id}/versions`, headers: { cookie } })).json();
    const list = versions.versions ?? versions.items ?? [];
    expect(list.length).toBeGreaterThan(0);
    for (const v of list) expectNowish(v.createdAt ?? v.savedAt, 'version timestamp');
  });

  it('projects report createdAt in UTC', async () => {
    const response = await app.inject({ method: 'GET', url: '/projects', headers: { cookie } });
    const projects = response.json().projects as { createdAt?: string }[];
    expect(projects.length).toBeGreaterThan(0);
    for (const p of projects) if (p.createdAt !== undefined) expectNowish(p.createdAt, 'project.createdAt');
  });
});
