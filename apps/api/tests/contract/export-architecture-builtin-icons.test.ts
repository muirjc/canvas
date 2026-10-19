import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mermaidArchitectureIconsManifest } from '@canvas/diagram-core';
import { seedLibraries } from '../../src/seed/libraries.seed.js';
import { buildTestApp, closeTestDb, resetDatabase, seedDiagramType, seedProject, seedUser } from '../helpers/setup.js';

/**
 * jmuir-dtu.27: an imported architecture-beta diagram using Mermaid's built-in icons (cloud,
 * database, disk, internet, server) exported with blank services -- the names resolved to the
 * 'generic' library, which has no such icons. They now resolve to the bundled
 * mermaid-architecture library, which the catalog seed ingests.
 */
describe('Diagram export: Mermaid built-in architecture icons (jmuir-dtu.27)', () => {
  let app: FastifyInstance;
  let sessionCookie: string;
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
    await seedDiagramType('cloud-infrastructure', 'architecture', 'Cloud Infrastructure Diagram');
    await seedLibraries();
    const admin = await seedUser({ email: 'admin@example.com', password: 'admin-pass', role: 'admin' });
    projectId = (await seedProject('Test Project', admin.id)).id;

    const loginResponse = await app.inject({
      method: 'POST',
      url: '/auth/local/login',
      payload: { email: 'admin@example.com', password: 'admin-pass' },
    });
    const setCookie = loginResponse.headers['set-cookie'];
    sessionCookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(';')[0];
  });

  it('draws every built-in icon in an SVG export of a freshly imported diagram', async () => {
    const dsl = [
      'architecture-beta',
      '    group api(cloud)[API]',
      '    service c(cloud)[Cloud] in api',
      '    service db(database)[Database] in api',
      '    service d(disk)[Disk] in api',
      '    service net(internet)[Internet]',
      '    service srv(server)[Server] in api',
      '',
    ].join('\n');

    const createResponse = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/diagrams`,
      headers: { cookie: sessionCookie },
      payload: { name: 'Built-in icons', diagramTypeId: 'cloud-infrastructure', initialDslContent: dsl },
    });
    expect(createResponse.statusCode).toBe(201);
    const { diagram } = createResponse.json();

    const exportResponse = await app.inject({
      method: 'GET',
      url: `/diagrams/${diagram.id}/export?format=svg`,
      headers: { cookie: sessionCookie },
    });
    expect(exportResponse.statusCode).toBe(200);
    for (const icon of mermaidArchitectureIconsManifest.icons) {
      expect(exportResponse.body, `${icon.id} artwork`).toContain(icon.assetRef);
    }
  });

  it('draws an architecture group\'s icon in its header (jmuir-dtu.31)', async () => {
    const dsl = 'architecture-beta\n    group vpc(server)[VPC]\n';
    const createResponse = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/diagrams`,
      headers: { cookie: sessionCookie },
      payload: { name: 'Group icon', diagramTypeId: 'cloud-infrastructure', initialDslContent: dsl },
    });
    expect(createResponse.statusCode).toBe(201);
    const { diagram } = createResponse.json();
    const exportResponse = await app.inject({ method: 'GET', url: `/diagrams/${diagram.id}/export?format=svg`, headers: { cookie: sessionCookie } });
    expect(exportResponse.statusCode).toBe(200);
    const group = exportResponse.body.slice(exportResponse.body.indexOf('data-container-id="vpc"'));
    const server = mermaidArchitectureIconsManifest.icons.find((i) => i.id === 'server')!.assetRef;
    expect(group).toContain(server);
  });
});
