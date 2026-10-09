import type { FastifyInstance, FastifyReply } from 'fastify';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { loadDiagramTypeDslFamily, UnknownDiagramTypeError } from '../diagrams/diagram.service.js';
import { parseStandardBody } from './standard-rules.schema.js';
import {
  cloneStandard,
  createDraftStandard,
  getStandardRecord,
  getActiveStandard,
  listStandards,
  publishStandard,
  retireStandard,
  updateDraftStandard,
  StandardNotFoundError,
  StandardStateError,
} from './standard.service.js';
import { revalidateDiagramsForType } from './revalidate.service.js';

function handleServiceError(error: unknown, reply: FastifyReply): void {
  if (error instanceof StandardNotFoundError) {
    reply.code(404).send({ error: error.message });
    return;
  }
  if (error instanceof UnknownDiagramTypeError) {
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
  app.get<{ Params: { id: string } }>(
    '/diagram-types/:id/standard',
    { preHandler: requireAuth, schema: { tags: ['Standards'], security: [{ cookieAuth: [] }] } },
    async (request, reply) => {
      const standard = await getActiveStandard(request.params.id);
      if (!standard) {
        reply.code(404).send({ error: `No published standard for diagram type ${request.params.id}` });
        return;
      }
      reply.send({ standard });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/diagram-types/:id/standards',
    { preHandler: requireAuth, schema: { tags: ['Standards'], security: [{ cookieAuth: [] }] } },
    async (request, reply) => {
      reply.send({ standards: await listStandards(request.params.id) });
    },
  );

  app.post<{ Params: { id: string }; Body: unknown }>(
    '/diagram-types/:id/standards',
    { preHandler: requireRole('admin'), schema: { tags: ['Standards'], security: [{ cookieAuth: [] }] } },
    async (request, reply) => {
      try {
        const family = await loadDiagramTypeDslFamily(request.params.id);
        const parsed = parseStandardBody(request.body, family);
        if (!parsed.ok) {
          reply.code(400).send({ error: 'Invalid standard definition', issues: parsed.issues });
          return;
        }
        const standard = await createDraftStandard({
          diagramTypeId: request.params.id,
          rules: parsed.rules,
          name: parsed.name,
          description: parsed.description ?? undefined,
        });
        reply.code(201).send({ standard });
      } catch (error) {
        handleServiceError(error, reply);
      }
    },
  );

  // canvas-tfr: edit a draft in place (published/retired standards are immutable -- clone instead).
  app.put<{ Params: { id: string }; Body: unknown }>(
    '/standards/:id',
    { preHandler: requireRole('admin'), schema: { tags: ['Standards'], security: [{ cookieAuth: [] }] } },
    async (request, reply) => {
      try {
        const existing = await getStandardRecord(request.params.id);
        const family = await loadDiagramTypeDslFamily(existing.diagramTypeId);
        const parsed = parseStandardBody(request.body, family);
        if (!parsed.ok) {
          reply.code(400).send({ error: 'Invalid standard definition', issues: parsed.issues });
          return;
        }
        const standard = await updateDraftStandard(request.params.id, {
          rules: parsed.rules,
          name: parsed.name,
          description: parsed.description,
        });
        reply.send({ standard });
      } catch (error) {
        handleServiceError(error, reply);
      }
    },
  );

  // canvas-tfr: copy any version into a new draft (the safe way to change a published standard).
  app.post<{ Params: { id: string } }>(
    '/standards/:id/clone',
    { preHandler: requireRole('admin'), schema: { tags: ['Standards'], security: [{ cookieAuth: [] }] } },
    async (request, reply) => {
      try {
        reply.code(201).send({ standard: await cloneStandard(request.params.id) });
      } catch (error) {
        handleServiceError(error, reply);
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    '/standards/:id/publish',
    { preHandler: requireRole('admin'), schema: { tags: ['Standards'], security: [{ cookieAuth: [] }] } },
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
    { preHandler: requireRole('admin'), schema: { tags: ['Standards'], security: [{ cookieAuth: [] }] } },
    async (request, reply) => {
      try {
        const standard = await retireStandard(request.params.id);
        // canvas-tfr: retiring removes the rules in force, so cached violations must be refreshed
        // too (previously only publish re-checked, leaving stale flags after a retire).
        void revalidateDiagramsForType(standard.diagramTypeId);
        reply.send({ standard });
      } catch (error) {
        handleServiceError(error, reply);
      }
    },
  );
}
