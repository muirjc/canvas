import type { FastifyInstance } from 'fastify';
import type { IconShapeLibraryManifest } from '@canvas/diagram-core';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { ingestLibrary, listLibraries, searchIconsForDiagramType, searchIconsInLibrary } from './library.service.js';

export async function registerLibraryRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/libraries',
    { preHandler: requireAuth, schema: { tags: ['Libraries'], security: [{ cookieAuth: [] }] } },
    async (_request, reply) => {
      return reply.send({ libraries: await listLibraries() });
    },
  );

  // Loads a library as BUILT-IN (the catalog seed's path; tests use it to load the bundled packs).
  // canvas-3dq: admins import custom libraries through /admin/libraries/import-* instead, which
  // sanitizes strictly and keeps built-in ids reserved.
  app.post<{ Body: IconShapeLibraryManifest }>(
    '/libraries',
    { preHandler: requireRole('admin'), schema: { tags: ['Libraries'], security: [{ cookieAuth: [] }] } },
    async (request, reply) => {
      try {
        await ingestLibrary(request.body);
        return reply.code(201).send({ status: 'ingested', id: request.body.id, version: request.body.version });
      } catch (error) {
        return reply.code(400).send({ error: (error as Error).message });
      }
    },
  );

  app.get<{ Params: { id: string; version: string }; Querystring: { query?: string } }>(
    '/libraries/:id/versions/:version/icons',
    { preHandler: requireAuth, schema: { tags: ['Libraries'], security: [{ cookieAuth: [] }] } },
    async (request, reply) => {
      const icons = await searchIconsInLibrary(request.params.id, request.params.version, request.query.query ?? '');
      return reply.send({ icons });
    },
  );

  app.get<{ Querystring: { query?: string; diagramTypeId: string } }>(
    '/icons/search',
    {
      preHandler: requireAuth,
      // canvas-80m: declarative validation (Fastify JSON Schema) instead of a hand-rolled `if`.
      schema: {
        tags: ['Libraries'],
        security: [{ cookieAuth: [] }],
        querystring: {
          type: 'object',
          required: ['diagramTypeId'],
          properties: { diagramTypeId: { type: 'string', minLength: 1 }, query: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      const icons = await searchIconsForDiagramType(request.query.diagramTypeId, request.query.query ?? '');
      return reply.send({ icons });
    },
  );
}
