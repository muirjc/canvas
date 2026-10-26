import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { requireAuth } from '../auth/middleware.js';
import { getDb } from '../db/client.js';
import { dbBoolean } from '../db/sql-helpers.js';

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
        .where('active', '=', dbBoolean(true))
        .executeTakeFirst();
      return reply.send({ user: user ?? null });
    },
  );

  /**
   * canvas-cyt: the share dialog's picker -- active users whose name or email contains `q`
   * (case-insensitive), at most 20, by name. Any signed-in user may search: they can already share
   * with anyone whose email they know. Deactivated users are never listed.
   */
  app.get<{ Querystring: { q: string } }>(
    '/users/search',
    {
      preHandler: requireAuth,
      schema: {
        tags: ['Users'],
        security: [{ cookieAuth: [] }],
        querystring: { type: 'object', required: ['q'], properties: { q: { type: 'string', minLength: 1, maxLength: 100 } } },
      },
    },
    async (request, reply) => {
      const q = request.query.q.trim().toLowerCase();
      if (!q) return reply.send({ users: [] });
      // LIKE wildcards in the input are matched literally.
      const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const users = await getDb()
        .selectFrom('users')
        .select(['id', 'name', 'email'])
        .where('active', '=', dbBoolean(true))
        .where((eb) =>
          eb.or([
            eb(sql`lower(name)`, 'like', sql`${pattern} escape '\\'`),
            eb(sql`lower(email)`, 'like', sql`${pattern} escape '\\'`),
          ]),
        )
        .orderBy('name')
        .orderBy('email')
        .limit(20)
        .execute();
      return reply.send({ users });
    },
  );
}
