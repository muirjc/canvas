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
import { replaceSession, startAuthenticatedSession } from './session.js';
import {
  confirmMfaEnrollment,
  InvalidMfaCodeError,
  isMfaEnabled,
  MfaAlreadyEnabledError,
  MfaNotStartedError,
  remainingRecoveryCodes,
  startMfaEnrollment,
  verifySecondFactor,
} from './mfa.service.js';
import { otpauthUri } from './totp.js';

/** canvas-ez1.5: how long the second sign-in step may take after the password. */
const MFA_PENDING_MS = 5 * 60 * 1000;

/** The signed-in session's user for a Canvas-password account. */
async function localSessionUser(userId: string, mfaRequired: boolean): Promise<SessionUser | undefined> {
  const db = getDb();
  const row = await db
    .selectFrom('users')
    .innerJoin('local_credentials', 'local_credentials.user_id', 'users.id')
    .select(['users.id', 'users.email', 'users.name', 'users.role', 'local_credentials.must_change_password'])
    .where('users.id', '=', userId)
    .executeTakeFirst();
  if (!row) return undefined;
  const mfaEnabled = await isMfaEnabled(row.id);
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    personas: await getUserPersonas(db, row.id),
    localAccount: true,
    mustChangePassword: fromDbBoolean(row.must_change_password),
    mfaEnabled,
    mustEnrollMfa: mfaRequired && !mfaEnabled,
  };
}

/**
 * Local email/password login — only registered when config.allowLocalAuth is true.
 * `/auth/me` and `/auth/logout` are NOT here — see session.ts's registerSessionInfoRoutes, which
 * both this route and the OIDC callback (auth/oidc.ts) rely on and which is always registered.
 */
// canvas-ez1.4: compared against when the email is unknown, so a wrong email takes as long as a
// wrong password (no telling which accounts exist from response times).
const DUMMY_CREDENTIAL = hashPassword('not-a-real-password-dummy');

export async function registerLocalAuthRoutes(
  app: FastifyInstance,
  config: Pick<AppConfig, 'loginRateLimitPerMinute' | 'mfaRequired' | 'mfaEncryptionKey'>,
): Promise<void> {
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
      // canvas-ez1.5: with two-step verification set up, the password alone signs no one in. The
      // failed-attempt count isn't reset yet either -- otherwise someone who knows the password
      // could guess codes forever by re-entering it after every two wrong codes.
      if (await isMfaEnabled(row.id)) {
        await replaceSession(request);
        request.session.mfaPending = { userId: row.id, startedAt: Date.now() };
        return reply.send({ mfaRequired: true });
      }
      await clearFailedAttempts(row.id);

      const user = (await localSessionUser(row.id, config.mfaRequired))!;
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

  // canvas-ez1.5: the second sign-in step -- an authenticator code or a recovery code. Wrong codes
  // count toward the lockout like wrong passwords.
  app.post<{ Body: { code: string } }>(
    '/auth/mfa/verify',
    {
      schema: {
        tags: ['Auth'],
        security: [],
        body: { type: 'object', required: ['code'], properties: { code: { type: 'string', maxLength: 64 } } },
      },
    },
    async (request, reply) => {
      const pending = request.session.mfaPending;
      if (!pending || Date.now() - pending.startedAt > MFA_PENDING_MS) {
        if (pending) await request.session.destroy();
        return reply.code(401).send({ error: 'Your sign-in timed out. Sign in again.' });
      }
      const ip = clientIp(request);
      const creds = await getDb()
        .selectFrom('local_credentials')
        .innerJoin('users', 'users.id', 'local_credentials.user_id')
        .select(['local_credentials.locked_at', 'users.active'])
        .where('local_credentials.user_id', '=', pending.userId)
        .executeTakeFirst();
      if (!creds || !creds.active) {
        await request.session.destroy();
        return reply.code(401).send({ error: 'Sign in again.' });
      }
      if (creds.locked_at) {
        await request.session.destroy();
        return reply.code(423).send({ error: LOCKED_MESSAGE });
      }
      const method = await verifySecondFactor(pending.userId, request.body.code, config.mfaEncryptionKey);
      if (!method) {
        await recordAudit({ event: 'sign_in_failed', targetUserId: pending.userId, ip, detail: { reason: 'wrong_mfa_code' } });
        if (await recordFailedAttempt(pending.userId)) {
          await recordAudit({ event: 'account_locked', targetUserId: pending.userId, ip });
          await request.session.destroy();
          return reply.code(423).send({ error: LOCKED_MESSAGE });
        }
        return reply.code(401).send({ error: "That code isn't right. Try the current code from your app, or a recovery code." });
      }
      await clearFailedAttempts(pending.userId);
      const user = await localSessionUser(pending.userId, config.mfaRequired);
      if (!user) {
        await request.session.destroy();
        return reply.code(401).send({ error: 'Sign in again.' });
      }
      await startAuthenticatedSession(request, user);
      await recordAudit({
        event: 'sign_in',
        actorUserId: user.id,
        targetUserId: user.id,
        ip,
        detail: { method: method === 'totp' ? 'password+authenticator' : 'password+recovery_code' },
      });
      if (method === 'recovery_code') {
        return reply.send({ user, recoveryCodesRemaining: await remainingRecoveryCodes(user.id) });
      }
      return reply.send({ user });
    },
  );

  // canvas-ez1.5: setting up two-step verification -- at first sign-in when it's required, or by
  // choice. Step 1 returns the secret (for the QR code / manual entry); step 2 confirms a code and
  // returns the recovery codes, shown once.
  app.post(
    '/auth/mfa/enroll',
    { preHandler: requireAuth, schema: { tags: ['Auth'], security: [{ cookieAuth: [] }] } },
    async (request, reply) => {
      const user = request.session.user!;
      if (!user.localAccount) return reply.code(400).send({ error: 'This account signs in with single sign-on.' });
      try {
        const secret = await startMfaEnrollment(user.id, config.mfaEncryptionKey);
        return reply.send({ secret, otpauthUri: otpauthUri(secret, user.email) });
      } catch (error) {
        if (error instanceof MfaAlreadyEnabledError) return reply.code(409).send({ error: error.message });
        throw error;
      }
    },
  );

  app.post<{ Body: { code: string } }>(
    '/auth/mfa/enroll/confirm',
    {
      preHandler: requireAuth,
      schema: {
        tags: ['Auth'],
        security: [{ cookieAuth: [] }],
        body: { type: 'object', required: ['code'], properties: { code: { type: 'string', maxLength: 64 } } },
      },
    },
    async (request, reply) => {
      const user = request.session.user!;
      try {
        const recoveryCodes = await confirmMfaEnrollment(user.id, request.body.code, config.mfaEncryptionKey);
        request.session.user = { ...user, mfaEnabled: true, mustEnrollMfa: false };
        await recordAudit({ event: 'mfa_enrolled', actorUserId: user.id, targetUserId: user.id, ip: clientIp(request) });
        return reply.send({ user: request.session.user, recoveryCodes });
      } catch (error) {
        if (error instanceof MfaAlreadyEnabledError) return reply.code(409).send({ error: error.message });
        if (error instanceof MfaNotStartedError || error instanceof InvalidMfaCodeError) {
          return reply.code(400).send({ error: error.message });
        }
        throw error;
      }
    },
  );
}
