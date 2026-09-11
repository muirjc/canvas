import type { FastifyInstance, FastifyReply } from 'fastify';
import { requireRole } from '../auth/middleware.js';
import { getAdminOverview, listUsers, updateUser, UserNotFoundError, type UpdateUserInput } from './admin.service.js';

const VALID_ROLES = ['admin', 'architect', 'viewer'];

function handleError(error: unknown, reply: FastifyReply): void {
  if (error instanceof UserNotFoundError) {
    reply.code(404).send({ error: error.message });
    return;
  }
  throw error;
}

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  app.get('/admin/users', { preHandler: requireRole('admin') }, async (_request, reply) => {
    reply.send({ users: await listUsers() });
  });

  app.patch<{ Params: { id: string }; Body: UpdateUserInput }>(
    '/admin/users/:id',
    {
      preHandler: requireRole('admin'),
      // canvas-80m: declarative request validation instead of a hand-rolled `if` check --
      // Fastify's own JSON-Schema validation (already understood by @fastify/swagger, canvas-lfc,
      // with no extra dependency) throws a 400 through the existing global setErrorHandler
      // (app.ts) before the handler body ever runs.
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        body: {
          type: 'object',
          properties: {
            role: { type: 'string', enum: VALID_ROLES },
            personas: { type: 'array', items: { type: 'string' } },
            active: { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const user = await updateUser(request.params.id, request.body);
        reply.send({ user });
      } catch (error) {
        handleError(error, reply);
      }
    },
  );

  app.get('/admin/overview', { preHandler: requireRole('admin') }, async (_request, reply) => {
    reply.send({ overview: await getAdminOverview() });
  });
}
