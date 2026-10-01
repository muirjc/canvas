import type { FastifyInstance } from 'fastify';
import { getDb } from '../db/client.js';
import { verifyPassword } from './password.js';
import type { SessionUser } from './types.js';

/**
 * Local email/password login — only registered when config.allowLocalAuth is true.
 * `/auth/me` and `/auth/logout` are NOT here — see session.ts's registerSessionInfoRoutes, which
 * both this route and the OIDC callback (auth/oidc.ts) rely on and which is always registered.
 */
export async function registerLocalAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { email: string; password: string } }>(
    '/auth/local/login',
    // canvas-lfc: no preHandler enforces auth here -- this route IS the login -- so security: []
    // is explicit, not merely omitted.
    { schema: { tags: ['Auth'], security: [] } },
    async (request, reply) => {
      const { email, password } = request.body;
      if (!email || !password) {
        reply.code(400).send({ error: 'email and password are required' });
        return;
      }

      const db = getDb();
      const row = await db
        .selectFrom('users')
        .innerJoin('local_credentials', 'local_credentials.user_id', 'users.id')
        .select([
          'users.id',
          'users.email',
          'users.name',
          'users.role',
          'users.personas',
          'users.active',
          'local_credentials.password_hash',
          'local_credentials.password_salt',
        ])
        .where('users.email', '=', email)
        .executeTakeFirst();
      if (!row || !row.active || !verifyPassword(password, row.password_hash, row.password_salt)) {
        reply.code(401).send({ error: 'Invalid email or password' });
        return;
      }

      const user: SessionUser = {
        id: row.id,
        email: row.email,
        name: row.name,
        role: row.role,
        personas: row.personas,
      };
      request.session.user = user;
      reply.send({ user });
    },
  );
}
