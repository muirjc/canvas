import type { FastifyInstance, FastifyReply } from 'fastify';
import { requireAuth, requireRole } from '../auth/middleware.js';
import {
  createCustomDiagramType,
  DiagramTypeConflictError,
  DiagramTypeNotFoundError,
  DiagramTypeValidationError,
  listDiagramTypeRecords,
  updateCustomDiagramType,
  type CustomDiagramTypeInput,
} from './diagram-type.service.js';

function handleError(error: unknown, reply: FastifyReply): void {
  if (error instanceof DiagramTypeValidationError) {
    reply.code(400).send({ error: error.message });
    return;
  }
  if (error instanceof DiagramTypeNotFoundError) {
    reply.code(404).send({ error: error.message });
    return;
  }
  if (error instanceof DiagramTypeConflictError) {
    reply.code(409).send({ error: error.message });
    return;
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
  app.get<{ Querystring: { persona?: string } }>(
    '/diagram-types',
    { preHandler: requireAuth, schema: { tags: ['DiagramTypes'], security: [{ cookieAuth: [] }] } },
    async (request, reply) => {
      const diagramTypes = (await listDiagramTypeRecords()).filter(
        (t) => !request.query.persona || t.personas.includes(request.query.persona),
      );
      reply.send({ diagramTypes });
    },
  );

  // canvas-tfr: admin-defined diagram types (the grain a standard attaches to).
  app.post<{ Body: CustomDiagramTypeInput }>(
    '/admin/diagram-types',
    { preHandler: requireRole('admin'), schema: { tags: ['DiagramTypes'], security: [{ cookieAuth: [] }] } },
    async (request, reply) => {
      try {
        const body = request.body ?? ({} as CustomDiagramTypeInput);
        reply.code(201).send({
          diagramType: await createCustomDiagramType({
            name: String(body.name ?? ''),
            dslFamily: String(body.dslFamily ?? ''),
            personas: Array.isArray(body.personas) ? body.personas.map(String) : [],
            paletteLibraryIds: Array.isArray(body.paletteLibraryIds) ? body.paletteLibraryIds.map(String) : [],
            description: typeof body.description === 'string' ? body.description : null,
          }),
        });
      } catch (error) {
        handleError(error, reply);
      }
    },
  );

  app.patch<{ Params: { id: string }; Body: Partial<CustomDiagramTypeInput> }>(
    '/admin/diagram-types/:id',
    { preHandler: requireRole('admin'), schema: { tags: ['DiagramTypes'], security: [{ cookieAuth: [] }] } },
    async (request, reply) => {
      try {
        reply.send({ diagramType: await updateCustomDiagramType(request.params.id, request.body ?? {}) });
      } catch (error) {
        handleError(error, reply);
      }
    },
  );
}
