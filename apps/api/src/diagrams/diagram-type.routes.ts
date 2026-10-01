import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/middleware.js';
import { getDb } from '../db/client.js';
import { getDiagramTypePaletteLibrariesBatch, getDiagramTypePersonasBatch } from '../db/array-columns.js';

/**
 * Lists the built-in DiagramType catalog (FR-006), optionally scoped to a persona (Constitution
 * III — a diagram-type picker should only surface types relevant to the current user's persona).
 *
 * Fetches the whole catalog and filters by persona in JS rather than a SQL-level join/filter —
 * the catalog is small (~18 rows, canvas-jtm.3), and this was already this file's own approach
 * before the `personas`/`default_palette_library_ids` TEXT[] columns became join tables (the old
 * `WHERE $1 = ANY(personas)` was itself just a different way of expressing the same filter).
 */
export async function registerDiagramTypeRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { persona?: string } }>(
    '/diagram-types',
    { preHandler: requireAuth, schema: { tags: ['DiagramTypes'], security: [{ cookieAuth: [] }] } },
    async (request, reply) => {
      const db = getDb();
      const rows = await db
        .selectFrom('diagram_types')
        .select(['id', 'name', 'abstraction_level', 'dsl_family'])
        .orderBy('name')
        .execute();
      const ids = rows.map((r) => r.id);
      const [personasByType, paletteLibrariesByType] = await Promise.all([
        getDiagramTypePersonasBatch(db, ids),
        getDiagramTypePaletteLibrariesBatch(db, ids),
      ]);

      const diagramTypes = rows
        .map((r) => ({
          id: r.id,
          name: r.name,
          personas: personasByType.get(r.id) ?? [],
          abstractionLevel: r.abstraction_level,
          dslFamily: r.dsl_family,
          defaultPaletteLibraryIds: paletteLibrariesByType.get(r.id) ?? [],
        }))
        .filter((t) => !request.query.persona || t.personas.includes(request.query.persona));

      reply.send({ diagramTypes });
    },
  );
}
