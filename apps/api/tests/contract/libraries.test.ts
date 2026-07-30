import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { azureIconsManifest, awsIconsManifest, genericShapesManifest } from '@canvas/diagram-core';
import { buildTestApp, closeTestDb, resetDatabase, seedUser } from '../helpers/setup.js';
import { getPool } from '../../src/db/pool.js';

/**
 * Contract for icon/shape library management + diagram-type-scoped search, per
 * specs/001-diagramming-platform/contracts/api-standards-libraries.md. Covers User Story 3.
 */
describe('Libraries API contract', () => {
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

  async function login(email: string, password: string): Promise<string> {
    const response = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email, password } });
    const setCookie = response.headers['set-cookie'];
    const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    return cookieHeader!.split(';')[0];
  }

  beforeEach(async () => {
    await resetDatabase();
    await seedUser({ email: 'admin@example.com', password: 'admin-pass', role: 'admin' });
    await seedUser({ email: 'architect@example.com', password: 'architect-pass', role: 'architect' });
    adminCookie = await login('admin@example.com', 'admin-pass');
    architectCookie = await login('architect@example.com', 'architect-pass');

    const pool = getPool();
    await pool.query(
      `INSERT INTO diagram_types (id, name, personas, abstraction_level, dsl_family, default_palette_library_ids)
       VALUES ('cloud-infrastructure', 'Cloud Infrastructure', ARRAY['Technical'], 'N/A', 'architecture', ARRAY['azure-icons','aws-icons'])`,
    );
  });

  it('rejects library ingestion from a non-admin user', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/libraries',
      headers: { cookie: architectCookie },
      payload: genericShapesManifest,
    });
    expect(response.statusCode).toBe(403);
  });

  it('ingests Azure and AWS icon libraries and lists them', async () => {
    for (const manifest of [azureIconsManifest, awsIconsManifest]) {
      const response = await app.inject({ method: 'POST', url: '/libraries', headers: { cookie: adminCookie }, payload: manifest });
      expect(response.statusCode).toBe(201);
    }

    const listResponse = await app.inject({ method: 'GET', url: '/libraries', headers: { cookie: architectCookie } });
    const libraries = listResponse.json().libraries;
    expect(libraries.find((l: { id: string }) => l.id === 'azure-icons')).toBeTruthy();
    expect(libraries.find((l: { id: string }) => l.id === 'aws-icons')).toBeTruthy();
  });

  it('searches within a specific library version by keyword', async () => {
    await app.inject({ method: 'POST', url: '/libraries', headers: { cookie: adminCookie }, payload: awsIconsManifest });

    const response = await app.inject({
      method: 'GET',
      url: `/libraries/aws-icons/versions/${awsIconsManifest.version}/icons?query=serverless`,
      headers: { cookie: architectCookie },
    });
    expect(response.statusCode).toBe(200);
    const icons = response.json().icons;
    expect(icons.map((i: { id: string }) => i.id)).toContain('lambda');
  });

  it('searches icons scoped to a diagram type\'s default palette libraries', async () => {
    await app.inject({ method: 'POST', url: '/libraries', headers: { cookie: adminCookie }, payload: azureIconsManifest });
    await app.inject({ method: 'POST', url: '/libraries', headers: { cookie: adminCookie }, payload: awsIconsManifest });

    const response = await app.inject({
      method: 'GET',
      url: '/icons/search?diagramTypeId=cloud-infrastructure&query=storage',
      headers: { cookie: architectCookie },
    });
    expect(response.statusCode).toBe(200);
    const icons = response.json().icons;
    const ids = icons.map((i: { id: string; libraryId: string }) => `${i.libraryId}:${i.id}`);
    expect(ids).toContain('azure-icons:storage-accounts');
    expect(ids).toContain('aws-icons:s3');
  });

  it('does not surface icons from libraries outside the diagram type\'s scope', async () => {
    await app.inject({ method: 'POST', url: '/libraries', headers: { cookie: adminCookie }, payload: genericShapesManifest });
    await app.inject({ method: 'POST', url: '/libraries', headers: { cookie: adminCookie }, payload: awsIconsManifest });

    const response = await app.inject({
      method: 'GET',
      url: '/icons/search?diagramTypeId=cloud-infrastructure&query=rectangle',
      headers: { cookie: architectCookie },
    });
    // "generic" is not in cloud-infrastructure's default_palette_library_ids (azure/aws only).
    expect(response.json().icons).toHaveLength(0);
  });
});
