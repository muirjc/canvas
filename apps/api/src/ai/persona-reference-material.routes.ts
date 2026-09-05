import type { FastifyInstance, FastifyReply } from 'fastify';
import { requireRole } from '../auth/middleware.js';
import { getPersona } from './persona.service.js';
import {
  createReferenceMaterial,
  deleteReferenceMaterial,
  InvalidReferenceMaterialContentError,
  InvalidReferenceMaterialFamilyError,
  listReferenceMaterial,
  updateReferenceMaterial,
} from './persona-reference-material.service.js';

function handleError(error: unknown, reply: FastifyReply): void {
  if (error instanceof InvalidReferenceMaterialContentError || error instanceof InvalidReferenceMaterialFamilyError) {
    reply.code(400).send({ error: error.message });
    return;
  }
  throw error;
}

/**
 * 010-ai-diagram-knowledge, T029 (User Story 4, contracts/api-ai-chat-contract.md): admin-only —
 * unlike `GET /ai-personas` (needed for the chat picker), no architect-facing endpoint exists for
 * reference material at all, since it only ever affects chat responses indirectly (FR-006/FR-010).
 */
export async function registerPersonaReferenceMaterialRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>(
    '/admin/ai-personas/:id/reference-material',
    { preHandler: requireRole('admin') },
    async (request, reply) => {
      if (!(await getPersona(request.params.id))) {
        reply.code(404).send({ error: 'Persona not found' });
        return;
      }
      reply.send({ entries: await listReferenceMaterial(request.params.id) });
    },
  );

  app.post<{ Params: { id: string }; Body: { content: string; diagramFamilies?: string[] } }>(
    '/admin/ai-personas/:id/reference-material',
    { preHandler: requireRole('admin') },
    async (request, reply) => {
      if (!(await getPersona(request.params.id))) {
        reply.code(404).send({ error: 'Persona not found' });
        return;
      }
      try {
        const entry = await createReferenceMaterial(request.params.id, request.body);
        reply.code(201).send({ entry });
      } catch (error) {
        handleError(error, reply);
      }
    },
  );

  app.patch<{ Params: { personaId: string; entryId: string }; Body: { content?: string; diagramFamilies?: string[] } }>(
    '/admin/ai-personas/:personaId/reference-material/:entryId',
    { preHandler: requireRole('admin') },
    async (request, reply) => {
      try {
        const entry = await updateReferenceMaterial(request.params.personaId, request.params.entryId, request.body);
        if (!entry) {
          reply.code(404).send({ error: 'Reference material entry not found' });
          return;
        }
        reply.send({ entry });
      } catch (error) {
        handleError(error, reply);
      }
    },
  );

  app.delete<{ Params: { personaId: string; entryId: string } }>(
    '/admin/ai-personas/:personaId/reference-material/:entryId',
    { preHandler: requireRole('admin') },
    async (request, reply) => {
      const deleted = await deleteReferenceMaterial(request.params.personaId, request.params.entryId);
      if (!deleted) {
        reply.code(404).send({ error: 'Reference material entry not found' });
        return;
      }
      reply.code(204).send();
    },
  );
}
