import type { FastifyInstance, FastifyReply } from 'fastify';
import { requireRole } from '../auth/middleware.js';
import { getAdminOverview, listUsers, updateUser, UserNotFoundError, type UpdateUserInput } from './admin.service.js';
import { createLocalUser, EmailInUseError, resetLocalPassword, type CreateLocalUserInput } from './local-accounts.service.js';

const VALID_ROLES = ['admin', 'architect', 'viewer'];

function handleError(error: unknown, reply: FastifyReply): FastifyReply {
  if (error instanceof UserNotFoundError) {
    return reply.code(404).send({ error: error.message });
  }
  if (error instanceof EmailInUseError) {
    return reply.code(409).send({ error: error.message });
  }
  throw error;
}

/**
 * `localAccounts`: Canvas-managed passwords are in use (config.allowLocalAuth -- always in
 * AUTH_MODE=local). Only then do the create-user and reset-password routes exist: with Entra,
 * users are created at their first sign-in and have no Canvas password to reset.
 */
export async function registerAdminRoutes(app: FastifyInstance, options: { localAccounts: boolean }): Promise<void> {
  app.get(
    '/admin/users',
    { preHandler: requireRole('admin'), schema: { tags: ['Admin'], security: [{ cookieAuth: [] }] } },
    async (_request, reply) => {
      return reply.send({ users: await listUsers() });
    },
  );

  app.patch<{ Params: { id: string }; Body: UpdateUserInput }>(
    '/admin/users/:id',
    {
      preHandler: requireRole('admin'),
      // canvas-80m: declarative request validation instead of a hand-rolled `if` check --
      // Fastify's own JSON-Schema validation (already understood by @fastify/swagger, canvas-lfc,
      // with no extra dependency) throws a 400 through the existing global setErrorHandler
      // (app.ts) before the handler body ever runs.
      schema: {
        tags: ['Admin'],
        security: [{ cookieAuth: [] }],
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
        return reply.send({ user });
      } catch (error) {
        return handleError(error, reply);
      }
    },
  );

  if (options.localAccounts) {
    // canvas-ez1.2: the response's temporaryPassword is shown once to the admin and never stored
    // in the clear -- only its hash is kept, and the user must change it at their next sign-in.
    app.post<{ Body: CreateLocalUserInput }>(
      '/admin/users',
      {
        preHandler: requireRole('admin'),
        schema: {
          tags: ['Admin'],
          security: [{ cookieAuth: [] }],
          body: {
            type: 'object',
            required: ['email', 'name', 'role'],
            properties: {
              email: { type: 'string', pattern: '^\\s*[^@\\s]+@[^@\\s]+\\.[^@\\s]+\\s*$', maxLength: 320 },
              name: { type: 'string', maxLength: 200 },
              role: { type: 'string', enum: VALID_ROLES },
              personas: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
      async (request, reply) => {
        try {
          return reply.code(201).send(await createLocalUser(request.body));
        } catch (error) {
          return handleError(error, reply);
        }
      },
    );

    app.post<{ Params: { id: string } }>(
      '/admin/users/:id/reset-password',
      {
        preHandler: requireRole('admin'),
        schema: {
          tags: ['Admin'],
          security: [{ cookieAuth: [] }],
          params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        },
      },
      async (request, reply) => {
        // Resetting signs the user out everywhere -- for your own account, Change password instead.
        if (request.params.id === request.session.user?.id) {
          return reply.code(400).send({ error: 'Use Change password for your own account.' });
        }
        try {
          return reply.send(await resetLocalPassword(request.params.id));
        } catch (error) {
          return handleError(error, reply);
        }
      },
    );
  }

  app.get(
    '/admin/overview',
    { preHandler: requireRole('admin'), schema: { tags: ['Admin'], security: [{ cookieAuth: [] }] } },
    async (_request, reply) => {
      return reply.send({ overview: await getAdminOverview() });
    },
  );
}
