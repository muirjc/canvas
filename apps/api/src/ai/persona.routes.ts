import type { FastifyInstance, FastifyReply } from 'fastify';
import { envelope, errorResponse, listEnvelope } from '../contract/schemas.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import {
  archivePersona,
  createPersona,
  InvalidPersonaCategoryError,
  listActivePersonas,
  listAllPersonas,
  updatePersona,
} from './persona.service.js';

function handleError(error: unknown, reply: FastifyReply): FastifyReply {
  if (error instanceof InvalidPersonaCategoryError) {
    return reply.code(400).send({ error: error.message });
  }
  throw error;
}

export async function registerPersonaRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/ai-personas',
    { preHandler: requireAuth, schema: { tags: ['AI'], security: [{ cookieAuth: [] }], response: { 200: listEnvelope('personas', 'AiPersona'), '4xx': errorResponse } } },
    async (_request, reply) => {
      return reply.send({ personas: await listActivePersonas() });
    },
  );

  app.get(
    '/admin/ai-personas',
    { preHandler: requireRole('admin'), schema: { tags: ['AI'], security: [{ cookieAuth: [] }], response: { 200: listEnvelope('personas', 'AiPersona'), '4xx': errorResponse } } },
    async (_request, reply) => {
      return reply.send({ personas: await listAllPersonas() });
    },
  );

  app.post<{ Body: { name: string; category: string; systemPrompt: string } }>(
    '/admin/ai-personas',
    { preHandler: requireRole('admin'), schema: { tags: ['AI'], security: [{ cookieAuth: [] }], response: { 201: envelope('persona', 'AiPersona'), '4xx': errorResponse } } },
    async (request, reply) => {
      try {
        const persona = await createPersona(request.body);
        return reply.code(201).send({ persona });
      } catch (error) {
        return handleError(error, reply);
      }
    },
  );

  app.patch<{ Params: { id: string }; Body: { name?: string; category?: string; systemPrompt?: string } }>(
    '/admin/ai-personas/:id',
    { preHandler: requireRole('admin'), schema: { tags: ['AI'], security: [{ cookieAuth: [] }], response: { 200: envelope('persona', 'AiPersona'), '4xx': errorResponse } } },
    async (request, reply) => {
      try {
        const persona = await updatePersona(request.params.id, request.body);
        if (!persona) {
          return reply.code(404).send({ error: 'Persona not found' });
        }
        return reply.send({ persona });
      } catch (error) {
        return handleError(error, reply);
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    '/admin/ai-personas/:id/archive',
    { preHandler: requireRole('admin'), schema: { tags: ['AI'], security: [{ cookieAuth: [] }], response: { 200: envelope('persona', 'AiPersona'), '4xx': errorResponse } } },
    async (request, reply) => {
      const persona = await archivePersona(request.params.id);
      if (!persona) {
        return reply.code(404).send({ error: 'Persona not found' });
      }
      return reply.send({ persona });
    },
  );
}
