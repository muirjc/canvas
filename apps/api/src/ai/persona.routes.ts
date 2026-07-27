import type { FastifyInstance, FastifyReply } from 'fastify';
import { requireAuth, requireRole } from '../auth/middleware.js';
import {
  archivePersona,
  createPersona,
  InvalidPersonaCategoryError,
  listActivePersonas,
  listAllPersonas,
  updatePersona,
} from './persona.service.js';

function handleError(error: unknown, reply: FastifyReply): void {
  if (error instanceof InvalidPersonaCategoryError) {
    reply.code(400).send({ error: error.message });
    return;
  }
  throw error;
}

export async function registerPersonaRoutes(app: FastifyInstance): Promise<void> {
  app.get('/ai-personas', { preHandler: requireAuth }, async (_request, reply) => {
    reply.send({ personas: await listActivePersonas() });
  });

  app.get('/admin/ai-personas', { preHandler: requireRole('admin') }, async (_request, reply) => {
    reply.send({ personas: await listAllPersonas() });
  });

  app.post<{ Body: { name: string; category: string; systemPrompt: string } }>(
    '/admin/ai-personas',
    { preHandler: requireRole('admin') },
    async (request, reply) => {
      try {
        const persona = await createPersona(request.body);
        reply.code(201).send({ persona });
      } catch (error) {
        handleError(error, reply);
      }
    },
  );

  app.patch<{ Params: { id: string }; Body: { name?: string; category?: string; systemPrompt?: string } }>(
    '/admin/ai-personas/:id',
    { preHandler: requireRole('admin') },
    async (request, reply) => {
      try {
        const persona = await updatePersona(request.params.id, request.body);
        if (!persona) {
          reply.code(404).send({ error: 'Persona not found' });
          return;
        }
        reply.send({ persona });
      } catch (error) {
        handleError(error, reply);
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    '/admin/ai-personas/:id/archive',
    { preHandler: requireRole('admin') },
    async (request, reply) => {
      const persona = await archivePersona(request.params.id);
      if (!persona) {
        reply.code(404).send({ error: 'Persona not found' });
        return;
      }
      reply.send({ persona });
    },
  );
}
