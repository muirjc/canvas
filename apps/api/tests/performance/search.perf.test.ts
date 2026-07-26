import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPool, closePool } from '../../src/db/pool.js';
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
      `INSERT INTO diagram_types (id, name, personas, abstraction_level, dsl_family, default_palette_library_ids)
       VALUES ('flowchart', 'Generic Flowchart', ARRAY['Technical'], 'N/A', 'flowchart', ARRAY['generic'])`,
    );
    const { rows: userRows } = await pool.query<{ id: string }>(
      `INSERT INTO users (name, email, role) VALUES ('Perf Owner', 'perf-owner@example.com', 'architect') RETURNING id`,
    );
    ownerId = userRows[0].id;
    const { rows: projectRows } = await pool.query<{ id: string }>(
      `INSERT INTO projects (name) VALUES ('Perf Test Project') RETURNING id`,
    );
    projectId = projectRows[0].id;

    // Bulk-insert diagrams directly (no version rows needed — search.service.ts's query only
    // touches the `diagrams` table itself, matching what it actually costs in production).
    await pool.query(
      `INSERT INTO diagrams (name, diagram_type_id, project_id, owner_id)
       SELECT 'Diagram ' || i, 'flowchart', $1, $2
       FROM generate_series(1, $3) AS i`,
      [projectId, ownerId, DIAGRAM_COUNT],
    );
  }, 60_000);

  afterAll(async () => {
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
