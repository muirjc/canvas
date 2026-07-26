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
    { preHandler: requireRole('admin') },
    async (request, reply) => {
      if (request.body.role && !VALID_ROLES.includes(request.body.role)) {
        reply.code(400).send({ error: `role must be one of: ${VALID_ROLES.join(', ')}` });
        return;
      }
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
