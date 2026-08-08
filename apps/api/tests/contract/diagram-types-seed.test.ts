import { describe, expect, it, beforeEach, beforeAll, afterAll } from 'vitest';
import { buildTestApp, closeTestDb, resetDatabase } from '../helpers/setup.js';
import { seedDiagramTypes } from '../../src/seed/diagram-types.seed.js';
import { getPool } from '../../src/db/pool.js';
import type { FastifyInstance } from 'fastify';

/**
 * Contract for canvas-23t.4: every diagram type that already has a real icon library
 * (c4-notation, azure-icons/aws-icons) must NOT also include "generic" in
 * default_palette_library_ids — generic's five shape-alias entries duplicate the shape toolbar
 * and render as broken, artwork-less boxes when placed via the icon search path (verified live;
 * see docs/ui-review-brief.md finding #4). "generic" stays the SOLE entry for diagram types with
 * no other icon library at all (plain flowchart variants, sequence, erd, uml), where it's the
 * only way to place any icon/shape at all.
 *
 * This exercises the real seedDiagramTypes() function directly, not a hand-built fixture row —
 * libraries.test.ts's own cloud-infrastructure fixture already hardcodes the "correct" answer
 * via a manual INSERT, which would never have caught this bug in the real seed data.
 */
describe('Diagram type seed data: generic shape-alias scoping', () => {
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
    await seedDiagramTypes();
  });

  async function paletteFor(diagramTypeId: string): Promise<string[]> {
    const pool = getPool();
    const { rows } = await pool.query<{ default_palette_library_ids: string[] }>(
      'SELECT default_palette_library_ids FROM diagram_types WHERE id = $1',
      [diagramTypeId],
    );
    return rows[0].default_palette_library_ids;
  }

  it.each(['cloud-infrastructure', 'network', 'deployment', 'solution-architecture'])(
    '%s already has real icon libraries — generic is excluded',
    async (diagramTypeId) => {
      const palette = await paletteFor(diagramTypeId);
      expect(palette).not.toContain('generic');
      expect(palette).toEqual(expect.arrayContaining(['azure-icons', 'aws-icons']));
    },
  );

  it.each(['c4-context', 'c4-container', 'c4-component', 'c4-code', 'c4-deployment'])(
    '%s already has c4-notation — generic is excluded',
    async (diagramTypeId) => {
      const palette = await paletteFor(diagramTypeId);
      expect(palette).not.toContain('generic');
      expect(palette).toContain('c4-notation');
    },
  );

  it.each(['flowchart', 'business-capability-map', 'value-stream', 'application-landscape', 'roadmap', 'sequence', 'erd', 'uml'])(
    '%s has no other icon library — generic remains the sole entry',
    async (diagramTypeId) => {
      const palette = await paletteFor(diagramTypeId);
      expect(palette).toEqual(['generic']);
    },
  );
});
