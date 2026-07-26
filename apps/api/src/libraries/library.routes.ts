import type { FastifyInstance } from 'fastify';
import type { IconShapeLibraryManifest } from '@canvas/diagram-core';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { ingestLibrary, listLibraries, searchIconsForDiagramType, searchIconsInLibrary } from './library.service.js';

export async function registerLibraryRoutes(app: FastifyInstance): Promise<void> {
  app.get('/libraries', { preHandler: requireAuth }, async (_request, reply) => {
    reply.send({ libraries: await listLibraries() });
  });

  app.post<{ Body: IconShapeLibraryManifest }>(
    '/libraries',
    { preHandler: requireRole('admin') },
    async (request, reply) => {
      try {
        await ingestLibrary(request.body);
        reply.code(201).send({ status: 'ingested', id: request.body.id, version: request.body.version });
      } catch (error) {
        reply.code(400).send({ error: (error as Error).message });
      }
    },
  );

  app.get<{ Params: { id: string; version: string }; Querystring: { query?: string } }>(
    '/libraries/:id/versions/:version/icons',
    { preHandler: requireAuth },
    async (request, reply) => {
      const icons = await searchIconsInLibrary(request.params.id, request.params.version, request.query.query ?? '');
      reply.send({ icons });
    },
  );

  app.get<{ Querystring: { query?: string; diagramTypeId?: string } }>(
    '/icons/search',
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!request.query.diagramTypeId) {
        reply.code(400).send({ error: 'diagramTypeId is required' });
        return;
      }
      const icons = await searchIconsForDiagramType(request.query.diagramTypeId, request.query.query ?? '');
      reply.send({ icons });
    },
  );
}
