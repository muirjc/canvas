import { describe, expect, it, beforeEach, beforeAll, afterAll } from 'vitest';
import { buildTestApp, closeTestDb, resetDatabase } from '../helpers/setup.js';
import { seedDiagramTypes } from '../../src/seed/diagram-types.seed.js';
import { getDb } from '../../src/db/client.js';
import { getDiagramTypePaletteLibraries } from '../../src/db/array-columns.js';
import type { FastifyInstance } from 'fastify';

/**
 * Contract for canvas-23t.4: every diagram type that already has a real icon library
 * (azure-icons/aws-icons) must NOT also include "generic" in default_palette_library_ids —
 * generic's five shape-alias entries duplicate the shape toolbar and render as broken,
 * artwork-less boxes when placed via the icon search path (verified live; see
 * docs/ui-review-brief.md finding #4). "generic" stays the SOLE entry for diagram types with
 * no other icon library at all (plain flowchart variants, sequence, erd, uml), where it's the
 * only way to place any icon/shape at all.
 *
 * canvas-wrk: C4 types used to carry the exact same class of bug via their own 'c4-notation'
 * library (every entry duplicated getAddableShapes('c4')'s shape toolbar, or — 'boundary' — was
 * outright broken, referencing a NodeShape that never existed). That library was deleted
 * entirely rather than fixed, since C4's shape toolbar alone is already complete; "generic" was
 * deliberately NOT substituted in its place, since that would just reintroduce the identical
 * redundancy under a different library id (see diagram-types.seed.ts's own C4_LIBRARIES comment).
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
    return getDiagramTypePaletteLibraries(getDb(), diagramTypeId);
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
    '%s ships zero default palette libraries — its own shape toolbar is already complete, no shape-alias fallback needed',
    async (diagramTypeId) => {
      const palette = await paletteFor(diagramTypeId);
      expect(palette).toEqual([]);
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
