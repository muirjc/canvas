import type { FastifyInstance, FastifyReply } from 'fastify';
import type { StandardRules } from '@canvas/diagram-core';
import { requireAuth, requireRole } from '../auth/middleware.js';
import {
  createDraftStandard,
  getActiveStandard,
  listStandards,
  publishStandard,
  retireStandard,
  StandardNotFoundError,
  StandardStateError,
} from './standard.service.js';
import { revalidateDiagramsForType } from './revalidate.service.js';

function handleServiceError(error: unknown, reply: FastifyReply): void {
  if (error instanceof StandardNotFoundError) {
    reply.code(404).send({ error: error.message });
    return;
  }
  if (error instanceof StandardStateError) {
    reply.code(409).send({ error: error.message });
    return;
  }
  throw error;
}

export async function registerStandardRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>('/diagram-types/:id/standard', { preHandler: requireAuth }, async (request, reply) => {
    const standard = await getActiveStandard(request.params.id);
    if (!standard) {
      reply.code(404).send({ error: `No published standard for diagram type ${request.params.id}` });
      return;
    }
    reply.send({ standard });
  });

  app.get<{ Params: { id: string } }>(
    '/diagram-types/:id/standards',
    { preHandler: requireAuth },
    async (request, reply) => {
      reply.send({ standards: await listStandards(request.params.id) });
    },
  );

  app.post<{ Params: { id: string }; Body: Partial<StandardRules> }>(
    '/diagram-types/:id/standards',
    { preHandler: requireRole('admin') },
    async (request, reply) => {
      const body = request.body;
      const standard = await createDraftStandard({
        diagramTypeId: request.params.id,
        rules: {
          allowedShapeIds: body.allowedShapeIds ?? [],
          mandatoryShapeIds: body.mandatoryShapeIds ?? [],
          allowedIconLibraryRefs: body.allowedIconLibraryRefs ?? [],
          colorPalette: body.colorPalette ?? [],
          fontConstraints: body.fontConstraints,
        },
      });
      reply.code(201).send({ standard });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/standards/:id/publish',
    { preHandler: requireRole('admin') },
    async (request, reply) => {
      try {
        const standard = await publishStandard(request.params.id);
        // Fire-and-forget: existing diagrams of this type are re-evaluated against the newly
        // published standard, never silently auto-modified (FR-014).
        void revalidateDiagramsForType(standard.diagramTypeId);
        reply.send({ standard });
      } catch (error) {
        handleServiceError(error, reply);
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    '/standards/:id/retire',
    { preHandler: requireRole('admin') },
    async (request, reply) => {
      try {
        const standard = await retireStandard(request.params.id);
        reply.send({ standard });
      } catch (error) {
        handleServiceError(error, reply);
      }
    },
  );
}
