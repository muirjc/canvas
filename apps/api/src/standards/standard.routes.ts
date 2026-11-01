import type { FastifyBaseLogger, FastifyInstance, FastifyReply } from 'fastify';
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
import { runInBackground } from '../background/tasks.js';
import { envelope, errorResponse, idParams, listEnvelope } from '../contract/schemas.js';

// canvas-1bty.9: response shapes (apps/api/src/contract/schemas.ts).
const standardResponse = (status: 200 | 201 = 200) => ({
  [status]: envelope('standard', 'Standard'),
  '4xx': errorResponse,
});
import { revalidateDiagramsForType } from './revalidate.service.js';

function handleServiceError(error: unknown, reply: FastifyReply): FastifyReply {
  if (error instanceof StandardNotFoundError) {
    return reply.code(404).send({ error: error.message });
  }
  if (error instanceof UnknownDiagramTypeError) {
    return reply.code(404).send({ error: error.message });
  }
  if (error instanceof StandardStateError) {
    return reply.code(409).send({ error: error.message });
  }
  throw error;
}

/**
 * Re-checks every diagram of a type against its current standard without holding up the response.
 * The promise MUST be caught: an unhandled rejection terminates a Node process by default, so a
 * failed background re-check (e.g. a transient database error) would otherwise take the API down.
 * It also surfaced in CI as a Postgres deadlock, when a still-running re-check collided with the next
 * test's TRUNCATE -- hence runInBackground, which lets that work be drained (canvas-yrp). Cached violations are refreshed again on each
 * diagram's next save, so a failed re-check is logged, not retried.
 */
function revalidateInBackground(log: FastifyBaseLogger, diagramTypeId: string): void {
  // canvas-yrp: tracked, so app.close() and the tests' resetDatabase() wait for it to finish.
  runInBackground(
    () => revalidateDiagramsForType(diagramTypeId),
    (error: unknown) => {
      // The error's name only, not the object: driver errors can carry query detail.
      log.warn(
        { diagramTypeId, errorName: error instanceof Error ? error.name : 'unknown' },
        'Background standards revalidation failed',
      );
    },
  );
}

export async function registerStandardRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>(
    '/diagram-types/:id/standard',
    {
      preHandler: requireAuth,
      schema: {
        tags: ['Standards'],
        security: [{ cookieAuth: [] }],
        params: idParams,
        response: standardResponse(),
      },
    },
    async (request, reply) => {
      const standard = await getActiveStandard(request.params.id);
      if (!standard) {
        return reply
          .code(404)
          .send({ error: `No published standard for diagram type ${request.params.id}` });
      }
      return reply.send({ standard });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/diagram-types/:id/standards',
    {
      preHandler: requireAuth,
      schema: {
        tags: ['Standards'],
        security: [{ cookieAuth: [] }],
        params: idParams,
        response: { 200: listEnvelope('standards', 'Standard'), '4xx': errorResponse },
      },
    },
    async (request, reply) => {
      return reply.send({ standards: await listStandards(request.params.id) });
    },
  );

  app.post<{ Params: { id: string }; Body: unknown }>(
    '/diagram-types/:id/standards',
    {
      preHandler: requireRole('admin'),
      schema: {
        tags: ['Standards'],
        security: [{ cookieAuth: [] }],
        params: idParams,
        response: standardResponse(201),
      },
    },
    async (request, reply) => {
      try {
        const family = await loadDiagramTypeDslFamily(request.params.id);
        const parsed = parseStandardBody(request.body, family);
        if (!parsed.ok) {
          return reply
            .code(400)
            .send({ error: 'Invalid standard definition', issues: parsed.issues });
        }
        const standard = await createDraftStandard({
          diagramTypeId: request.params.id,
          rules: parsed.rules,
          name: parsed.name,
          description: parsed.description ?? undefined,
        });
        return reply.code(201).send({ standard });
      } catch (error) {
        return handleServiceError(error, reply);
      }
    },
  );

  // canvas-tfr: edit a draft in place (published/retired standards are immutable -- clone instead).
  app.put<{ Params: { id: string }; Body: unknown }>(
    '/standards/:id',
    {
      preHandler: requireRole('admin'),
      schema: {
        tags: ['Standards'],
        security: [{ cookieAuth: [] }],
        params: idParams,
        response: standardResponse(),
      },
    },
    async (request, reply) => {
      try {
        const existing = await getStandardRecord(request.params.id);
        const family = await loadDiagramTypeDslFamily(existing.diagramTypeId);
        const parsed = parseStandardBody(request.body, family);
        if (!parsed.ok) {
          return reply
            .code(400)
            .send({ error: 'Invalid standard definition', issues: parsed.issues });
        }
        const standard = await updateDraftStandard(request.params.id, {
          rules: parsed.rules,
          name: parsed.name,
          description: parsed.description,
        });
        return reply.send({ standard });
      } catch (error) {
        return handleServiceError(error, reply);
      }
    },
  );

  // canvas-tfr: copy any version into a new draft (the safe way to change a published standard).
  app.post<{ Params: { id: string } }>(
    '/standards/:id/clone',
    {
      preHandler: requireRole('admin'),
      schema: {
        tags: ['Standards'],
        security: [{ cookieAuth: [] }],
        params: idParams,
        response: standardResponse(201),
      },
    },
    async (request, reply) => {
      try {
        return reply.code(201).send({ standard: await cloneStandard(request.params.id) });
      } catch (error) {
        return handleServiceError(error, reply);
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    '/standards/:id/publish',
    {
      preHandler: requireRole('admin'),
      schema: {
        tags: ['Standards'],
        security: [{ cookieAuth: [] }],
        params: idParams,
        response: standardResponse(),
      },
    },
    async (request, reply) => {
      try {
        const standard = await publishStandard(request.params.id);
        // Fire-and-forget: existing diagrams of this type are re-evaluated against the newly
        // published standard, never silently auto-modified (FR-014).
        revalidateInBackground(request.log, standard.diagramTypeId);
        return reply.send({ standard });
      } catch (error) {
        return handleServiceError(error, reply);
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    '/standards/:id/retire',
    {
      preHandler: requireRole('admin'),
      schema: {
        tags: ['Standards'],
        security: [{ cookieAuth: [] }],
        params: idParams,
        response: standardResponse(),
      },
    },
    async (request, reply) => {
      try {
        const standard = await retireStandard(request.params.id);
        // canvas-tfr: retiring removes the rules in force, so cached violations must be refreshed
        // too (previously only publish re-checked, leaving stale flags after a retire).
        revalidateInBackground(request.log, standard.diagramTypeId);
        return reply.send({ standard });
      } catch (error) {
        return handleServiceError(error, reply);
      }
    },
  );
}
