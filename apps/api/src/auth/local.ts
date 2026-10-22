import type { FastifyInstance } from 'fastify';
import { getDb } from '../db/client.js';
import { getUserPersonas } from '../db/array-columns.js';
import { fromDbBoolean } from '../db/sql-helpers.js';
import { verifyPassword } from './password.js';
import { requireAuth } from './middleware.js';
import {
  changeOwnPassword,
  NoLocalPasswordError,
  normalizeEmail,
  PasswordPolicyError,
  WrongPasswordError,
} from '../admin/local-accounts.service.js';
import type { SessionUser } from './types.js';
import { startAuthenticatedSession } from './session.js';

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
        return reply.code(400).send({ error: 'email and password are required' });
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
          'users.active',
          'local_credentials.password_hash',
          'local_credentials.password_salt',
          'local_credentials.must_change_password',
        ])
        .where('users.email', '=', normalizeEmail(email))
        .executeTakeFirst();
      if (!row || !row.active || !verifyPassword(password, row.password_hash, row.password_salt)) {
        return reply.code(401).send({ error: 'Invalid email or password' });
      }

      const user: SessionUser = {
        id: row.id,
        email: row.email,
        name: row.name,
        role: row.role,
        personas: await getUserPersonas(db, row.id),
        localAccount: true,
        mustChangePassword: fromDbBoolean(row.must_change_password),
      };
      // canvas-4xo: a new session id on sign-in (no fixation), stamped for the absolute lifetime.
      await startAuthenticatedSession(request, user);
      return reply.send({ user });
    },
  );

  // canvas-ez1.2: a signed-in local account changes its own password -- required after signing in
  // with a one-time password (the session's mustChangePassword gate, session.ts).
  app.post<{ Body: { currentPassword: string; newPassword: string } }>(
    '/auth/password',
    {
      preHandler: requireAuth,
      schema: {
        tags: ['Auth'],
        security: [{ cookieAuth: [] }],
        body: {
          type: 'object',
          required: ['currentPassword', 'newPassword'],
          properties: { currentPassword: { type: 'string' }, newPassword: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      const user = request.session.user!;
      try {
        await changeOwnPassword({
          userId: user.id,
          email: user.email,
          currentPassword: request.body.currentPassword,
          newPassword: request.body.newPassword,
          sessionId: request.session.sessionId,
        });
      } catch (error) {
        if (error instanceof WrongPasswordError || error instanceof PasswordPolicyError || error instanceof NoLocalPasswordError) {
          return reply.code(400).send({ error: error.message });
        }
        throw error;
      }
      request.session.user = { ...user, mustChangePassword: false };
      return reply.send({ user: request.session.user });
    },
  );
}
