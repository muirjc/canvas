import type { FastifyInstance } from 'fastify';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AWS_ICONS_VERSION, awsIconsManifest, serializeFlowchart } from '@canvas/diagram-core';
import { getDb } from '../../src/db/client.js';
import { ingestLibrary } from '../../src/libraries/library.service.js';
import { seedLibraries } from '../../src/seed/libraries.seed.js';
import { buildTestApp, closeTestDb, resetDatabase, seedFlowchartDiagramType, seedProject, seedUser } from '../helpers/setup.js';

/**
 * jmuir-dtu.29: real AWS icons are generated locally (packages/diagram-core/scripts/
 * generate-aws-icons.mjs) and never committed. The catalog seed loads the generated JSON when a
 * deployment has one, falls back to the bundled placeholders otherwise, and removes the old
 * 'aws-icons@2024.1-placeholder' version so the palette has one AWS library.
 */
const REAL_EC2 = '<g data-test="real-ec2"><rect width="48" height="48" fill="#ed7100"/></g>';

function writeManifest(manifest: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), 'aws-icons-')), 'aws-icons.json');
  writeFileSync(path, JSON.stringify(manifest));
  return path;
}

const realManifest = {
  id: 'aws-icons',
  version: AWS_ICONS_VERSION,
  license: 'AWS Architecture Icons, generated locally (test fixture).',
  icons: [
    { id: 'ec2', displayName: 'Amazon EC2', keywords: ['compute'], category: 'Compute', assetRef: REAL_EC2 },
    { id: 'athena', displayName: 'Amazon Athena', keywords: ['analytics'], category: 'Analytics', assetRef: '<rect width="48" height="48"/>' },
  ],
};

async function awsIcons(): Promise<{ version: string; id: string; asset: string }[]> {
  const rows = await getDb()
    .selectFrom('icons')
    .select(['library_version', 'id', 'asset_ref'])
    .where('library_id', '=', 'aws-icons')
    .execute();
  return rows.map((r) => ({ version: r.library_version, id: r.id, asset: r.asset_ref }));
}

describe('catalog seed: AWS icons (jmuir-dtu.29)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  it('without a generated manifest, seeds the bundled placeholders at the shared version', async () => {
    await seedLibraries({ awsIconsManifestPath: join(tmpdir(), 'definitely-missing-aws-icons.json') });
    const icons = await awsIcons();
    expect(new Set(icons.map((i) => i.version))).toEqual(new Set([AWS_ICONS_VERSION]));
    expect(icons.map((i) => i.id).sort()).toEqual(awsIconsManifest.icons.map((i) => i.id).sort());
  });

  it('with a generated manifest, seeds the real artwork instead', async () => {
    await seedLibraries({ awsIconsManifestPath: writeManifest(realManifest) });
    const icons = await awsIcons();
    expect(icons.find((i) => i.id === 'ec2')?.asset).toBe(REAL_EC2);
    expect(icons.some((i) => i.id === 'athena')).toBe(true);
    const library = await getDb().selectFrom('icon_libraries').select('license').where('id', '=', 'aws-icons').executeTakeFirstOrThrow();
    expect(library.license).not.toMatch(/PLACEHOLDER/);
  });

  it('removes the old 2024.1-placeholder version so the palette has a single AWS library', async () => {
    await ingestLibrary({ ...awsIconsManifest, version: '2024.1-placeholder' });
    await seedLibraries({ awsIconsManifestPath: writeManifest(realManifest) });
    expect((await awsIcons()).some((i) => i.version === '2024.1-placeholder')).toBe(false);
  });

  it('rejects a generated manifest for the wrong library or version with a clear error', async () => {
    await expect(seedLibraries({ awsIconsManifestPath: writeManifest({ ...realManifest, version: '1999.1' }) })).rejects.toThrow(
      /aws-icons@2024\.1/,
    );
  });

  it('a diagram saved against the old placeholder version exports with the real artwork', async () => {
    await seedFlowchartDiagramType();
    await seedLibraries({ awsIconsManifestPath: writeManifest(realManifest) });
    const admin = await seedUser({ email: 'admin@example.com', password: 'admin-pass', role: 'admin' });
    const project = await seedProject('P', admin.id);
    const login = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email: 'admin@example.com', password: 'admin-pass' } });
    const setCookie = login.headers['set-cookie'];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(';')[0];

    const dsl = serializeFlowchart({
      diagramTypeId: 'flowchart',
      nodes: [{ id: 'A', label: 'Amazon EC2', shape: 'icon', position: { x: 10, y: 10 }, icon: { libraryId: 'aws-icons', libraryVersion: '2024.1-placeholder', iconId: 'ec2' } }],
      edges: [],
      containers: [],
    });
    const created = await app.inject({
      method: 'POST',
      url: `/projects/${project.id}/diagrams`,
      headers: { cookie },
      payload: { name: 'Legacy AWS', diagramTypeId: 'flowchart', initialDslContent: dsl },
    });
    expect(created.statusCode).toBe(201);
    const exported = await app.inject({ method: 'GET', url: `/diagrams/${created.json().diagram.id}/export?format=svg`, headers: { cookie } });
    expect(exported.body).toContain('data-test="real-ec2"');
  });
});
