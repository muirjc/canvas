import type { FastifyInstance } from 'fastify';
import { getDb } from '../db/client.js';
import { getUserPersonas } from '../db/array-columns.js';
import { fromDbBoolean } from '../db/sql-helpers.js';
import { hashPassword, verifyPassword } from './password.js';
import { requireAuth } from './middleware.js';
import { clientIp, recordAudit } from '../audit/audit.service.js';
import type { AppConfig } from '../config.js';
import { LoginRateLimiter } from './login-rate-limit.js';
import {
  AccountLockedError,
  changeOwnPassword,
  clearFailedAttempts,
  LOCKED_MESSAGE,
  recordFailedAttempt,
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
// canvas-ez1.4: compared against when the email is unknown, so a wrong email takes as long as a
// wrong password (no telling which accounts exist from response times).
const DUMMY_CREDENTIAL = hashPassword('not-a-real-password-dummy');

export async function registerLocalAuthRoutes(app: FastifyInstance, config: Pick<AppConfig, 'loginRateLimitPerMinute'>): Promise<void> {
  const rateLimiter = new LoginRateLimiter(config.loginRateLimitPerMinute);

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

      if (!rateLimiter.allow(clientIp(request))) {
        return reply.code(429).send({ error: 'Too many sign-in attempts from this network. Wait a minute and try again.' });
      }

      const db = getDb();
      const normalizedEmail = normalizeEmail(email);
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
          'local_credentials.locked_at',
        ])
        .where('users.email', '=', normalizedEmail)
        .executeTakeFirst();
      const ip = clientIp(request);
      if (!row) {
        verifyPassword(password, DUMMY_CREDENTIAL.hash, DUMMY_CREDENTIAL.salt);
        await recordAudit({ event: 'sign_in_failed', ip, detail: { email: normalizedEmail, reason: 'unknown_email' } });
        return reply.code(401).send({ error: 'Invalid email or password' });
      }
      // canvas-ez1.4: a locked account stays locked whatever is typed, until an admin unlocks it.
      // Saying so (rather than "invalid") does reveal the account exists -- accepted so its owner
      // knows to ask an admin, inside the IP allow-list (docs/ip-allowlist-security-plan.md).
      if (row.locked_at) {
        await recordAudit({ event: 'sign_in_failed', targetUserId: row.id, ip, detail: { reason: 'locked' } });
        return reply.code(423).send({ error: LOCKED_MESSAGE });
      }
      if (!verifyPassword(password, row.password_hash, row.password_salt)) {
        await recordAudit({ event: 'sign_in_failed', targetUserId: row.id, ip, detail: { reason: 'wrong_password' } });
        if (await recordFailedAttempt(row.id)) {
          await recordAudit({ event: 'account_locked', targetUserId: row.id, ip });
          return reply.code(423).send({ error: LOCKED_MESSAGE });
        }
        return reply.code(401).send({ error: 'Invalid email or password' });
      }
      if (!row.active) {
        await recordAudit({ event: 'sign_in_failed', targetUserId: row.id, ip, detail: { reason: 'inactive' } });
        return reply.code(401).send({ error: 'Invalid email or password' });
      }
      await clearFailedAttempts(row.id);

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
      await recordAudit({ event: 'sign_in', actorUserId: row.id, targetUserId: row.id, ip, detail: { method: 'password' } });
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
        const ip = clientIp(request);
        if (error instanceof AccountLockedError) {
          await recordAudit({ event: 'password_change_failed', actorUserId: user.id, targetUserId: user.id, ip, detail: { reason: 'wrong_password' } });
          await recordAudit({ event: 'account_locked', targetUserId: user.id, ip });
          // Locking signed the user out everywhere; end this session too (or it'd be saved again).
          await request.session.destroy();
          return reply.code(423).send({ error: error.message });
        }
        if (error instanceof WrongPasswordError) {
          await recordAudit({ event: 'password_change_failed', actorUserId: user.id, targetUserId: user.id, ip, detail: { reason: 'wrong_password' } });
        }
        if (error instanceof WrongPasswordError || error instanceof PasswordPolicyError || error instanceof NoLocalPasswordError) {
          return reply.code(400).send({ error: error.message });
        }
        throw error;
      }
      await recordAudit({ event: 'password_changed', actorUserId: user.id, targetUserId: user.id, ip: clientIp(request) });
      request.session.user = { ...user, mustChangePassword: false };
      return reply.send({ user: request.session.user });
    },
  );
}
