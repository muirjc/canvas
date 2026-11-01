import type { FastifyInstance, FastifyReply } from 'fastify';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { envelope, errorResponse, idParams, listEnvelope, noContent } from '../contract/schemas.js';
import {
  createCustomDiagramType,
  deleteCustomDiagramType,
  DiagramTypeConflictError,
  DiagramTypeNotFoundError,
  DiagramTypeValidationError,
  listDiagramTypeRecords,
  updateDiagramType,
  type CustomDiagramTypeInput,
} from './diagram-type.service.js';

function handleError(error: unknown, reply: FastifyReply): FastifyReply {
  if (error instanceof DiagramTypeValidationError) {
    return reply.code(400).send({ error: error.message });
  }
  if (error instanceof DiagramTypeNotFoundError) {
    return reply.code(404).send({ error: error.message });
  }
  if (error instanceof DiagramTypeConflictError) {
    return reply.code(409).send({ error: error.message });
  }
  throw error;
}

/**
 * Lists the DiagramType catalog (FR-006) -- the seeded built-ins plus admin-created custom types
 * (canvas-tfr) -- optionally scoped to a persona (Constitution III — a diagram-type picker should
 * only surface types relevant to the current user's persona). The catalog is small, so the persona
 * filter runs in JS.
 */
export async function registerDiagramTypeRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { persona?: string; includeHidden?: string } }>(
    '/diagram-types',
    {
      preHandler: requireAuth,
      schema: {
        tags: ['DiagramTypes'],
        security: [{ cookieAuth: [] }],
        querystring: {
          type: 'object',
          properties: { persona: { type: 'string' }, includeHidden: { type: 'string' } },
        },
        response: { 200: listEnvelope('diagramTypes', 'DiagramType'), '4xx': errorResponse },
      },
    },
    async (request, reply) => {
      // canvas-9ff: hidden types are left out of the create pickers by default; the admin page and
      // the project browser (which labels existing diagrams) pass includeHidden=true.
      const includeHidden = request.query.includeHidden === 'true';
      const diagramTypes = (await listDiagramTypeRecords()).filter(
        (t) =>
          (includeHidden || !t.hidden) &&
          (!request.query.persona || t.personas.includes(request.query.persona)),
      );
      return reply.send({ diagramTypes });
    },
  );

  // canvas-tfr: admin-defined diagram types (the grain a standard attaches to).
  app.post<{ Body: CustomDiagramTypeInput }>(
    '/admin/diagram-types',
    {
      preHandler: requireRole('admin'),
      schema: {
        tags: ['DiagramTypes'],
        security: [{ cookieAuth: [] }],
        body: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            dslFamily: { type: 'string' },
            personas: { type: 'array', items: { type: 'string' } },
            paletteLibraryIds: { type: 'array', items: { type: 'string' } },
            description: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          },
        },
        response: { 201: envelope('diagramType', 'DiagramType'), '4xx': errorResponse },
      },
    },
    async (request, reply) => {
      try {
        const body = request.body ?? ({} as CustomDiagramTypeInput);
        return reply.code(201).send({
          diagramType: await createCustomDiagramType({
            name: String(body.name ?? ''),
            dslFamily: String(body.dslFamily ?? ''),
            personas: Array.isArray(body.personas) ? body.personas.map(String) : [],
            paletteLibraryIds: Array.isArray(body.paletteLibraryIds)
              ? body.paletteLibraryIds.map(String)
              : [],
            description: typeof body.description === 'string' ? body.description : null,
          }),
        });
      } catch (error) {
        return handleError(error, reply);
      }
    },
  );

  app.patch<{ Params: { id: string }; Body: Partial<CustomDiagramTypeInput> }>(
    '/admin/diagram-types/:id',
    {
      preHandler: requireRole('admin'),
      schema: {
        tags: ['DiagramTypes'],
        security: [{ cookieAuth: [] }],
        params: idParams,
        body: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            dslFamily: { type: 'string' },
            personas: { type: 'array', items: { type: 'string' } },
            paletteLibraryIds: { type: 'array', items: { type: 'string' } },
            description: { anyOf: [{ type: 'string' }, { type: 'null' }] },
            hidden: { type: 'boolean' },
          },
        },
        response: { 200: envelope('diagramType', 'DiagramType'), '4xx': errorResponse },
      },
    },
    async (request, reply) => {
      try {
        return reply.send({
          diagramType: await updateDiagramType(request.params.id, request.body ?? {}),
        });
      } catch (error) {
        return handleError(error, reply);
      }
    },
  );

  // canvas-9ff: deletes an unused custom type; a built-in or in-use type answers 409 suggesting Hide.
  app.delete<{ Params: { id: string } }>(
    '/admin/diagram-types/:id',
    {
      preHandler: requireRole('admin'),
      schema: {
        tags: ['DiagramTypes'],
        security: [{ cookieAuth: [] }],
        params: idParams,
        response: { 204: noContent, '4xx': errorResponse },
      },
    },
    async (request, reply) => {
      try {
        await deleteCustomDiagramType(request.params.id);
        return reply.code(204).send();
      } catch (error) {
        return handleError(error, reply);
      }
    },
  );
}
