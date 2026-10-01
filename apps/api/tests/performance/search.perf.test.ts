import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '../../src/db/client.js';
import { setDiagramTypePersonas, setDiagramTypePaletteLibraries } from '../../src/db/array-columns.js';
import { runMigrations } from '../../src/db/migrate.js';
import { searchDiagrams } from '../../src/diagrams/search.service.js';
import { closeTestDb, resetDatabase } from '../helpers/setup.js';

const DIAGRAM_COUNT = 1200;

function percentile(sortedMs: number[], p: number): number {
  const index = Math.ceil((p / 100) * sortedMs.length) - 1;
  return sortedMs[Math.max(0, Math.min(index, sortedMs.length - 1))];
}

/**
 * SC-007: diagram save/load/search operations complete with no perceptible delay for projects
 * containing at least 1,000 diagrams. Validates the search query path (search.service.ts)
 * directly against a project seeded with 1,200 diagrams — well past the 1,000 threshold.
 */
describe.skipIf(!process.env.RUN_PERF_TESTS)('Diagram search performance at scale', () => {
  let projectId: string;
  let ownerId: string;

  beforeAll(async () => {
    await runMigrations();
    await resetDatabase();
    const db = getDb();
    await db
      .insertInto('diagram_types')
      .values({ id: 'flowchart', name: 'Generic Flowchart', abstraction_level: 'N/A', dsl_family: 'flowchart' })
      .execute();
    await setDiagramTypePersonas(db, 'flowchart', ['Technical']);
    await setDiagramTypePaletteLibraries(db, 'flowchart', ['generic']);
    ownerId = randomUUID();
    await db
      .insertInto('users')
      .values({ id: ownerId, name: 'Perf Owner', email: 'perf-owner@example.com', role: 'architect' })
      .execute();
    // owner_id was missing here even before canvas-jtm.10 (projects.owner_id has been NOT NULL
    // since feature 007) — presumably unnoticed since this whole suite is gated behind
    // RUN_PERF_TESTS and so never runs in ordinary CI. Fixed alongside the id fix below rather
    // than left for a future run to rediscover.
    projectId = randomUUID();
    await db.insertInto('projects').values({ id: projectId, name: 'Perf Test Project', owner_id: ownerId }).execute();

    // Bulk-insert diagrams directly (no version rows needed — search.service.ts's query only
    // touches the `diagrams` table itself, matching what it actually costs in production). Ids
    // and names generated in JS and inserted as one array of row objects — canvas-jtm.10 removed
    // the gen_random_uuid() DEFAULT this used to rely on implicitly, and Kysely's `.values([...])`
    // array form replaces the previous Postgres-only `UNNEST($1::uuid[])` bulk-insert trick so this
    // works against either dialect.
    const diagramRows = Array.from({ length: DIAGRAM_COUNT }, (_, i) => ({
      id: randomUUID(),
      name: `Diagram ${i + 1}`,
      diagram_type_id: 'flowchart',
      project_id: projectId,
      owner_id: ownerId,
    }));
    await db.insertInto('diagrams').values(diagramRows).execute();
  }, 60_000);

  afterAll(async () => {
    await closeTestDb();
  });

  it(`p95 search latency stays under 300ms across ${DIAGRAM_COUNT} diagrams`, async () => {
    const durations: number[] = [];
    const queries = [undefined, 'Diagram 1', 'Diagram 999', 'zzz-no-match'];

    for (let i = 0; i < 40; i += 1) {
      const query = queries[i % queries.length];
      const start = performance.now();
      await searchDiagrams({ projectId, query, diagramTypeId: 'flowchart' });
      durations.push(performance.now() - start);
    }

    durations.sort((a, b) => a - b);
    const p95 = percentile(durations, 95);
    expect(p95, `p95 was ${p95.toFixed(1)}ms across ${durations.length} calls`).toBeLessThan(300);
  });
});
