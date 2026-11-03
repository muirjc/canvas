import type { FastifyInstance } from 'fastify';
import { sanitizeIconMarkupStrict, type IconShapeLibraryManifest } from '@canvas/diagram-core';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { errorResponse, listEnvelope, objectResponse } from '../contract/schemas.js';
import { ingestLibrary, listLibraries, searchIconsForDiagramType, searchIconsInLibrary } from './library.service.js';

export async function registerLibraryRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/libraries',
    {
      preHandler: requireAuth,
      schema: { tags: ['Libraries'], security: [{ cookieAuth: [] }], response: { 200: listEnvelope('libraries', 'LibrarySummary'), '4xx': errorResponse } },
    },
    async (_request, reply) => {
      return reply.send({ libraries: await listLibraries() });
    },
  );

  // Loads a library as BUILT-IN (the catalog seed's path; tests use it to load the bundled packs).
  // canvas-3dq: admins import custom libraries through /admin/libraries/import-* instead, which
  // keeps built-in ids reserved. canvas-1bty.19: artwork here is cleaned strictly too (the seed,
  // which loads the bundled packs directly, keeps them as shipped).
  app.post<{ Body: IconShapeLibraryManifest }>(
    '/libraries',
    {
      preHandler: requireRole('admin'),
      schema: {
        tags: ['Libraries'],
        security: [{ cookieAuth: [] }],
        response: { 201: objectResponse({ status: { type: 'string' }, id: { type: 'string' }, version: { type: 'string' } }), '4xx': errorResponse },
      },
    },
    async (request, reply) => {
      try {
        await ingestLibrary(strictArtwork(request.body));
        return reply.code(201).send({ status: 'ingested', id: request.body.id, version: request.body.version });
      } catch (error) {
        return reply.code(400).send({ error: (error as Error).message });
      }
    },
  );

  app.get<{ Params: { id: string; version: string }; Querystring: { query?: string } }>(
    '/libraries/:id/versions/:version/icons',
    {
      preHandler: requireAuth,
      schema: {
        tags: ['Libraries'],
        security: [{ cookieAuth: [] }],
        params: { type: 'object', required: ['id', 'version'], properties: { id: { type: 'string' }, version: { type: 'string' } } },
        querystring: { type: 'object', properties: { query: { type: 'string' } } },
        response: { 200: listEnvelope('icons', 'Icon'), '4xx': errorResponse },
      },
    },
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
        response: { 200: listEnvelope('icons', 'Icon'), '4xx': errorResponse },
      },
    },
    async (request, reply) => {
      const icons = await searchIconsForDiagramType(request.query.diagramTypeId, request.query.query ?? '');
      return reply.send({ icons });
    },
  );
}

/** Markup artwork through the strict allowlist (a path or URL reference is left alone). Throws SvgImportError. */
function strictArtwork(manifest: IconShapeLibraryManifest): IconShapeLibraryManifest {
  if (!manifest || !Array.isArray(manifest.icons)) return manifest;
  return {
    ...manifest,
    icons: manifest.icons.map((icon) =>
      icon && typeof icon.assetRef === 'string' && icon.assetRef.trimStart().startsWith('<')
        ? { ...icon, assetRef: sanitizeIconMarkupStrict(icon.assetRef, `${manifest.id}-${icon.id}`) }
        : icon,
    ),
  };
}
