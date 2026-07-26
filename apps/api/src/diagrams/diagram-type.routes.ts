import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/middleware.js';
import { getPool } from '../db/pool.js';

interface DiagramTypeRow {
  id: string;
  name: string;
  personas: string[];
  abstraction_level: string;
  dsl_family: string;
  default_palette_library_ids: string[];
}

/**
 * Lists the built-in DiagramType catalog (FR-006), optionally scoped to a persona (Constitution
 * III — a diagram-type picker should only surface types relevant to the current user's persona).
 */
export async function registerDiagramTypeRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { persona?: string } }>('/diagram-types', { preHandler: requireAuth }, async (request, reply) => {
    const pool = getPool();
    const { rows } = await pool.query<DiagramTypeRow>(
      request.query.persona
        ? 'SELECT * FROM diagram_types WHERE $1 = ANY(personas) ORDER BY name'
        : 'SELECT * FROM diagram_types ORDER BY name',
      request.query.persona ? [request.query.persona] : [],
    );
    reply.send({
      diagramTypes: rows.map((r) => ({
        id: r.id,
        name: r.name,
        personas: r.personas,
        abstractionLevel: r.abstraction_level,
        dslFamily: r.dsl_family,
        defaultPaletteLibraryIds: r.default_palette_library_ids,
      })),
    });
  });
}
