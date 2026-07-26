import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/middleware.js';
import { getPool } from '../db/pool.js';

/**
 * A minimal, non-admin-gated user lookup — any authenticated user needs this to share a diagram
 * they own (FR-020) without needing the full admin user-management view (FR-022, admin-only).
 * Deliberately returns only what a share dialog needs: id, name, email.
 */
export async function registerUserLookupRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { email?: string } }>('/users/lookup', { preHandler: requireAuth }, async (request, reply) => {
    if (!request.query.email) {
      reply.code(400).send({ error: 'email is required' });
      return;
    }
    const pool = getPool();
    const { rows } = await pool.query<{ id: string; name: string; email: string }>(
      'SELECT id, name, email FROM users WHERE email = $1 AND active = true',
      [request.query.email],
    );
    reply.send({ user: rows[0] ?? null });
  });
}
