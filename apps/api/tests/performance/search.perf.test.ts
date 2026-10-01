import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPool, closePool } from '../../src/db/pool.js';
import { getDb, closeDb } from '../../src/db/client.js';
import { setDiagramTypePersonas, setDiagramTypePaletteLibraries } from '../../src/db/array-columns.js';
import { runMigrations } from '../../src/db/migrate.js';
import { searchDiagrams } from '../../src/diagrams/search.service.js';

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
    const pool = getPool();
    await pool.query(
      `TRUNCATE TABLE share_grants, diagram_versions, diagrams, templates, standards, icons,
         icon_libraries, projects, diagram_types, local_credentials, users RESTART IDENTITY CASCADE`,
    );
    await pool.query(
      `INSERT INTO diagram_types (id, name, abstraction_level, dsl_family)
       VALUES ('flowchart', 'Generic Flowchart', 'N/A', 'flowchart')`,
    );
    const db = getDb();
    await setDiagramTypePersonas(db, 'flowchart', ['Technical']);
    await setDiagramTypePaletteLibraries(db, 'flowchart', ['generic']);
    const { rows: userRows } = await pool.query<{ id: string }>(
      `INSERT INTO users (id, name, email, role) VALUES ($1, 'Perf Owner', 'perf-owner@example.com', 'architect') RETURNING id`,
      [randomUUID()],
    );
    ownerId = userRows[0].id;
    // owner_id was missing here even before canvas-jtm.10 (projects.owner_id has been NOT NULL
    // since feature 007) — presumably unnoticed since this whole suite is gated behind
    // RUN_PERF_TESTS and so never runs in ordinary CI. Fixed alongside the id fix below rather
    // than left for a future run to rediscover.
    const { rows: projectRows } = await pool.query<{ id: string }>(
      `INSERT INTO projects (id, name, owner_id) VALUES ($1, 'Perf Test Project', $2) RETURNING id`,
      [randomUUID(), ownerId],
    );
    projectId = projectRows[0].id;

    // Bulk-insert diagrams directly (no version rows needed — search.service.ts's query only
    // touches the `diagrams` table itself, matching what it actually costs in production). Ids
    // generated in JS and expanded via UNNEST — canvas-jtm.10 removed the gen_random_uuid()
    // DEFAULT this used to rely on implicitly.
    const diagramIds = Array.from({ length: DIAGRAM_COUNT }, () => randomUUID());
    await pool.query(
      `INSERT INTO diagrams (id, name, diagram_type_id, project_id, owner_id)
       SELECT id, 'Diagram ' || ROW_NUMBER() OVER (), 'flowchart', $2, $3
       FROM UNNEST($1::uuid[]) AS id`,
      [diagramIds, projectId, ownerId],
    );
  }, 60_000);

  afterAll(async () => {
    await closeDb();
    await closePool();
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
