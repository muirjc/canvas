import type { FastifyInstance, FastifyReply } from 'fastify';
import { requireRole } from '../auth/middleware.js';
import { PERSONAS } from '../seed/diagram-types.seed.js';
import { getDb } from '../db/client.js';
import { getAdminOverview, LastAdminError, listUsers, updateUser, UserNotFoundError, type UpdateUserInput } from './admin.service.js';
import { createLocalUser, EmailInUseError, resetLocalPassword, unlockAccount, type CreateLocalUserInput } from './local-accounts.service.js';
import { clientIp, listAuditEvents, recordAudit } from '../audit/audit.service.js';
import { resetMfa } from '../auth/mfa.service.js';
import { CannotDeleteUserError, deleteUser, deletionImpact } from './user-deletion.service.js';

const VALID_ROLES = ['admin', 'architect', 'viewer'];
// canvas-2sk: a user's personas decide which diagram types they're offered first -- only the four.
const PERSONAS_SCHEMA = { type: 'array', items: { type: 'string', enum: [...PERSONAS] }, uniqueItems: true, maxItems: 4 } as const;

function handleError(error: unknown, reply: FastifyReply): FastifyReply {
  if (error instanceof UserNotFoundError) {
    return reply.code(404).send({ error: error.message });
  }
  if (error instanceof EmailInUseError) {
    return reply.code(409).send({ error: error.message });
  }
  if (error instanceof LastAdminError) {
    return reply.code(409).send({ error: error.message });
  }
  if (error instanceof CannotDeleteUserError) {
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
            personas: PERSONAS_SCHEMA,
            active: { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const user = await updateUser(request.params.id, request.body);
        await recordAudit({
          event: 'user_updated',
          actorUserId: request.session.user?.id,
          targetUserId: user.id,
          ip: clientIp(request),
          detail: { ...request.body },
        });
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
              personas: PERSONAS_SCHEMA,
            },
          },
        },
      },
      async (request, reply) => {
        try {
          const created = await createLocalUser(request.body);
          await recordAudit({
            event: 'user_created',
            actorUserId: request.session.user?.id,
            targetUserId: created.user.id,
            ip: clientIp(request),
            detail: { role: created.user.role },
          });
          return reply.code(201).send(created);
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
          const result = await resetLocalPassword(request.params.id);
          await recordAudit({ event: 'password_reset', actorUserId: request.session.user?.id, targetUserId: request.params.id, ip: clientIp(request) });
          return reply.send(result);
        } catch (error) {
          return handleError(error, reply);
        }
      },
    );

    // canvas-ez1.5: a lost phone -- removes two-step verification and signs the user out; they set
    // it up again at their next sign-in.
    app.post<{ Params: { id: string } }>(
      '/admin/users/:id/reset-mfa',
      {
        preHandler: requireRole('admin'),
        schema: {
          tags: ['Admin'],
          security: [{ cookieAuth: [] }],
          params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        },
      },
      async (request, reply) => {
        if (request.params.id === request.session.user?.id) {
          return reply.code(400).send({ error: "You can't reset your own two-step verification." });
        }
        const exists = await getDb()
          .selectFrom('users')
          .select('id')
          .where('id', '=', request.params.id)
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
        if (!exists) return reply.code(404).send({ error: `No user with id ${request.params.id}` });
        await resetMfa(request.params.id);
        await recordAudit({ event: 'mfa_reset', actorUserId: request.session.user?.id, targetUserId: request.params.id, ip: clientIp(request) });
        return reply.send({ reset: true });
      },
    );

    // canvas-ez1.4: the only way out of a lockout besides a password reset (no time-based unlock).
    app.post<{ Params: { id: string } }>(
      '/admin/users/:id/unlock',
      {
        preHandler: requireRole('admin'),
        schema: {
          tags: ['Admin'],
          security: [{ cookieAuth: [] }],
          params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        },
      },
      async (request, reply) => {
        try {
          const unlocked = await unlockAccount(request.params.id);
          if (unlocked) {
            await recordAudit({ event: 'account_unlocked', actorUserId: request.session.user?.id, targetUserId: request.params.id, ip: clientIp(request) });
          }
          return reply.send({ unlocked });
        } catch (error) {
          return handleError(error, reply);
        }
      },
    );
  }

  // canvas-ez1.4: the audit log, newest first; `before` pages backwards, `userId` filters.
  app.get<{ Querystring: { limit?: string; before?: string; userId?: string } }>(
    '/admin/audit',
    {
      preHandler: requireRole('admin'),
      schema: {
        tags: ['Admin'],
        security: [{ cookieAuth: [] }],
        querystring: {
          type: 'object',
          properties: {
            // A string pattern, not `type: 'integer'`: querystring values arrive as strings and app.ts
            // disables AJV coercion, so an integer schema would reject every ?limit=.
            limit: { type: 'string', pattern: '^([1-9]|[1-9][0-9]|1[0-9][0-9]|200)$' },
            before: { type: 'string', format: 'date-time' },
            userId: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const { limit, before, userId } = request.query;
      return reply.send({ events: await listAuditEvents({ limit: limit ? Number(limit) : 50, before, userId }) });
    },
  );

  // canvas-0se: what deleting a user would transfer/remove, for the confirmation dialog.
  app.get<{ Params: { id: string } }>(
    '/admin/users/:id/deletion-impact',
    {
      preHandler: requireRole('admin'),
      schema: {
        tags: ['Admin'],
        security: [{ cookieAuth: [] }],
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      },
    },
    async (request, reply) => {
      try {
        return reply.send(await deletionImpact(request.params.id));
      } catch (error) {
        return handleError(error, reply);
      }
    },
  );

  // canvas-0se: delete a user (both auth modes). Their projects/diagrams go to transferToUserId
  // (required when they own any); see user-deletion.service.ts for what stays and what goes.
  app.delete<{ Params: { id: string }; Body: { transferToUserId?: string } | undefined }>(
    '/admin/users/:id',
    {
      preHandler: requireRole('admin'),
      schema: {
        tags: ['Admin'],
        security: [{ cookieAuth: [] }],
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        body: { type: ['object', 'null'], properties: { transferToUserId: { type: 'string', minLength: 1 } } },
      },
    },
    async (request, reply) => {
      try {
        const result = await deleteUser({
          userId: request.params.id,
          actorUserId: request.session.user!.id,
          transferToUserId: request.body?.transferToUserId,
          ip: clientIp(request),
        });
        return reply.send({ deleted: true, ...result });
      } catch (error) {
        return handleError(error, reply);
      }
    },
  );

  app.get(
    '/admin/overview',
    { preHandler: requireRole('admin'), schema: { tags: ['Admin'], security: [{ cookieAuth: [] }] } },
    async (_request, reply) => {
      return reply.send({ overview: await getAdminOverview() });
    },
  );
}
