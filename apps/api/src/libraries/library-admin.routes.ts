import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { IconShapeLibraryManifest } from '@canvas/diagram-core';
import { requireRole } from '../auth/middleware.js';
import { clientIp, recordAudit } from '../audit/audit.service.js';
import {
  addSvgIcons,
  deleteIcon,
  deleteLibrary,
  importManifestLibrary,
  importSvgLibrary,
  LibraryConflictError,
  LibraryInUseError,
  LibraryInvalidError,
  LibraryNotFoundError,
  libraryUsage,
  listAdminIcons,
  listAdminLibraries,
  setIconRetired,
  setLibraryPalette,
  setLibraryRetired,
  updateIcon,
  updateLibrary,
  type UploadedIcon,
} from './library-admin.service.js';

/** canvas-3dq: Admin -> Libraries. Every route is admin-only; every change is audited. */
const UPLOAD_BODY_LIMIT = 50 * 1024 * 1024;

type Lib = { id: string; version: string };
type IconParams = Lib & { iconId: string };

function handleError(error: unknown, reply: FastifyReply): FastifyReply {
  if (error instanceof LibraryNotFoundError) return reply.code(404).send({ error: error.message });
  if (error instanceof LibraryInvalidError) return reply.code(400).send({ error: error.message });
  if (error instanceof LibraryConflictError) return reply.code(409).send({ error: error.message });
  if (error instanceof LibraryInUseError) return reply.code(409).send({ error: error.message, code: 'in_use', diagrams: error.diagrams });
  throw error;
}

const libParams = { type: 'object', required: ['id', 'version'], properties: { id: { type: 'string' }, version: { type: 'string' } } } as const;
const iconParams = {
  type: 'object',
  required: ['id', 'version', 'iconId'],
  properties: { id: { type: 'string' }, version: { type: 'string' }, iconId: { type: 'string' } },
} as const;
const uploadedIcons = {
  type: 'array',
  items: {
    type: 'object',
    required: ['fileName', 'svg'],
    properties: {
      fileName: { type: 'string', minLength: 1, maxLength: 255 },
      svg: { type: 'string', minLength: 1 },
      displayName: { type: 'string', maxLength: 120 },
      category: { type: 'string', maxLength: 60 },
      keywords: { type: 'array', items: { type: 'string', maxLength: 60 }, maxItems: 20 },
    },
  },
} as const;
const schema = (extra: object = {}) => ({ tags: ['Libraries'], security: [{ cookieAuth: [] }], ...extra });

export async function registerLibraryAdminRoutes(app: FastifyInstance): Promise<void> {
  const admin = requireRole('admin');
  const audit = (request: FastifyRequest, detail: Record<string, unknown>) =>
    recordAudit({ event: 'icon_library_changed', actorUserId: request.session.user?.id, ip: clientIp(request), detail });

  app.get('/admin/libraries', { preHandler: admin, schema: schema() }, async (_request, reply) => reply.send({ libraries: await listAdminLibraries() }));

  app.get<{ Params: Lib }>('/admin/libraries/:id/:version/icons', { preHandler: admin, schema: schema({ params: libParams }) }, async (request, reply) => {
    try {
      return reply.send({ icons: await listAdminIcons(request.params.id, request.params.version) });
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.get<{ Params: Lib; Querystring: { iconId?: string } }>(
    '/admin/libraries/:id/:version/usage',
    { preHandler: admin, schema: schema({ params: libParams, querystring: { type: 'object', properties: { iconId: { type: 'string' } } } }) },
    async (request, reply) => {
      try {
        return reply.send({ diagrams: await libraryUsage(request.params.id, request.params.version, request.query.iconId) });
      } catch (error) {
        return handleError(error, reply);
      }
    },
  );

  app.post<{ Body: { name: string; license?: string; icons: UploadedIcon[] } }>(
    '/admin/libraries/import-svg',
    {
      preHandler: admin,
      bodyLimit: UPLOAD_BODY_LIMIT,
      schema: schema({
        body: {
          type: 'object',
          required: ['name', 'icons'],
          properties: { name: { type: 'string', maxLength: 120 }, license: { type: 'string', maxLength: 2000 }, icons: uploadedIcons },
        },
      }),
    },
    async (request, reply) => {
      try {
        const result = await importSvgLibrary(request.body);
        await audit(request, { action: 'imported', libraryId: result.library.id, version: result.library.version, icons: result.library.iconCount, from: 'svg' });
        return reply.code(201).send(result);
      } catch (error) {
        return handleError(error, reply);
      }
    },
  );

  app.post<{ Body: { name?: string; manifest: IconShapeLibraryManifest } }>(
    '/admin/libraries/import-manifest',
    {
      preHandler: admin,
      bodyLimit: UPLOAD_BODY_LIMIT,
      schema: schema({ body: { type: 'object', required: ['manifest'], properties: { name: { type: 'string', maxLength: 120 }, manifest: { type: 'object' } } } }),
    },
    async (request, reply) => {
      try {
        const library = await importManifestLibrary(request.body.manifest, request.body.name);
        await audit(request, { action: 'imported', libraryId: library.id, version: library.version, icons: library.iconCount, from: 'manifest' });
        return reply.code(201).send({ library });
      } catch (error) {
        return handleError(error, reply);
      }
    },
  );

  app.patch<{ Params: Lib; Body: { name?: string; license?: string | null } }>(
    '/admin/libraries/:id/:version',
    {
      preHandler: admin,
      schema: schema({
        params: libParams,
        body: {
          type: 'object',
          minProperties: 1,
          properties: { name: { type: 'string', maxLength: 120 }, license: { anyOf: [{ type: 'string', maxLength: 2000 }, { type: 'null' }] } },
        },
      }),
    },
    async (request, reply) => {
      try {
        await updateLibrary(request.params.id, request.params.version, request.body);
        await audit(request, { action: 'updated', libraryId: request.params.id, version: request.params.version });
        return reply.code(204).send();
      } catch (error) {
        return handleError(error, reply);
      }
    },
  );

  app.post<{ Params: Lib; Body: { icons: UploadedIcon[] } }>(
    '/admin/libraries/:id/:version/icons',
    { preHandler: admin, bodyLimit: UPLOAD_BODY_LIMIT, schema: schema({ params: libParams, body: { type: 'object', required: ['icons'], properties: { icons: uploadedIcons } } }) },
    async (request, reply) => {
      try {
        const result = await addSvgIcons(request.params.id, request.params.version, request.body.icons);
        await audit(request, { action: 'icons_added', libraryId: request.params.id, version: request.params.version, icons: result.added });
        return reply.code(201).send(result);
      } catch (error) {
        return handleError(error, reply);
      }
    },
  );

  app.patch<{ Params: IconParams; Body: { displayName?: string; category?: string; keywords?: string[]; svg?: string } }>(
    '/admin/libraries/:id/:version/icons/:iconId',
    {
      preHandler: admin,
      bodyLimit: UPLOAD_BODY_LIMIT,
      schema: schema({
        params: iconParams,
        body: {
          type: 'object',
          minProperties: 1,
          properties: {
            displayName: { type: 'string', maxLength: 120 },
            category: { type: 'string', maxLength: 60 },
            keywords: { type: 'array', items: { type: 'string', maxLength: 60 }, maxItems: 20 },
            svg: { type: 'string', minLength: 1 },
          },
        },
      }),
    },
    async (request, reply) => {
      try {
        const { id, version, iconId } = request.params;
        await updateIcon(id, version, iconId, request.body);
        await audit(request, { action: 'icon_updated', libraryId: id, version, iconId, replacedArtwork: request.body.svg !== undefined });
        return reply.code(204).send();
      } catch (error) {
        return handleError(error, reply);
      }
    },
  );

  for (const retired of [true, false]) {
    const action = retired ? 'retire' : 'restore';
    app.post<{ Params: Lib }>(`/admin/libraries/:id/:version/${action}`, { preHandler: admin, schema: schema({ params: libParams }) }, async (request, reply) => {
      try {
        await setLibraryRetired(request.params.id, request.params.version, retired);
        await audit(request, { action: retired ? 'retired' : 'restored', libraryId: request.params.id, version: request.params.version });
        return reply.code(204).send();
      } catch (error) {
        return handleError(error, reply);
      }
    });
    app.post<{ Params: IconParams }>(`/admin/libraries/:id/:version/icons/:iconId/${action}`, { preHandler: admin, schema: schema({ params: iconParams }) }, async (request, reply) => {
      try {
        const { id, version, iconId } = request.params;
        await setIconRetired(id, version, iconId, retired);
        await audit(request, { action: retired ? 'icon_retired' : 'icon_restored', libraryId: id, version, iconId });
        return reply.code(204).send();
      } catch (error) {
        return handleError(error, reply);
      }
    });
  }

  app.delete<{ Params: Lib }>('/admin/libraries/:id/:version', { preHandler: admin, schema: schema({ params: libParams }) }, async (request, reply) => {
    try {
      await deleteLibrary(request.params.id, request.params.version);
      await audit(request, { action: 'deleted', libraryId: request.params.id, version: request.params.version });
      return reply.code(204).send();
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.delete<{ Params: IconParams }>('/admin/libraries/:id/:version/icons/:iconId', { preHandler: admin, schema: schema({ params: iconParams }) }, async (request, reply) => {
    try {
      const { id, version, iconId } = request.params;
      await deleteIcon(id, version, iconId);
      await audit(request, { action: 'icon_deleted', libraryId: id, version, iconId });
      return reply.code(204).send();
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.put<{ Params: { id: string }; Body: { diagramTypeIds: string[] } }>(
    '/admin/libraries/:id/diagram-types',
    {
      preHandler: admin,
      schema: schema({
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        body: { type: 'object', required: ['diagramTypeIds'], properties: { diagramTypeIds: { type: 'array', items: { type: 'string' }, maxItems: 500 } } },
      }),
    },
    async (request, reply) => {
      try {
        await setLibraryPalette(request.params.id, request.body.diagramTypeIds);
        await audit(request, { action: 'palette_set', libraryId: request.params.id, diagramTypeIds: request.body.diagramTypeIds });
        return reply.code(204).send();
      } catch (error) {
        return handleError(error, reply);
      }
    },
  );
}
