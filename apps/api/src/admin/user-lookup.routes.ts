import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/middleware.js';
import { getDb } from '../db/client.js';

/**
 * A minimal, non-admin-gated user lookup — any authenticated user needs this to share a diagram
 * they own (FR-020) without needing the full admin user-management view (FR-022, admin-only).
 * Deliberately returns only what a share dialog needs: id, name, email.
 */
export async function registerUserLookupRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { email: string } }>(
    '/users/lookup',
    {
      preHandler: requireAuth,
      // canvas-80m: declarative validation (Fastify JSON Schema) instead of a hand-rolled `if`.
      schema: {
        tags: ['Users'],
        security: [{ cookieAuth: [] }],
        querystring: { type: 'object', required: ['email'], properties: { email: { type: 'string', minLength: 1 } } },
      },
    },
    async (request, reply) => {
      const db = getDb();
      const user = await db
        .selectFrom('users')
        .select(['id', 'name', 'email'])
        .where('email', '=', request.query.email)
        .where('active', '=', true)
        .executeTakeFirst();
      reply.send({ user: user ?? null });
    },
  );
}
