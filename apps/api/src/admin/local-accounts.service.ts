import { randomUUID } from 'node:crypto';
import { getDb } from '../db/client.js';
import { getUserPersonas, setUserPersonas } from '../db/array-columns.js';
import { dbBoolean } from '../db/sql-helpers.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { checkPasswordPolicy, generateOneTimePassword } from '../auth/password-policy.js';
import { destroyUserSessions } from '../auth/session-store.js';
import type { UserRole } from '../auth/types.js';
import { UserNotFoundError, type UserRecord } from './admin.service.js';

/**
 * canvas-ez1.2: Canvas-managed accounts (AUTH_MODE=local, docs/ip-allowlist-security-plan.md
 * option B). An admin creates a user or resets a password; either way the API generates a
 * one-time password, returns it once for the admin to hand over, and stores only its hash. The
 * user must change it at their next sign-in before anything else works.
 */

export class EmailInUseError extends Error {}
export class PasswordPolicyError extends Error {}
export class WrongPasswordError extends Error {}
export class NoLocalPasswordError extends Error {}
export class AccountLockedError extends Error {}

/** canvas-ez1.4: this many consecutive failed attempts lock the account until an admin unlocks it. */
export const MAX_FAILED_ATTEMPTS = 3;
export const LOCKED_MESSAGE = 'This account is locked after too many failed sign-in attempts. Ask an admin to unlock it.';

/** Counts a failed password attempt; returns true when this attempt locked the account. */
export async function recordFailedAttempt(userId: string): Promise<boolean> {
  const db = getDb();
  const row = await db
    .updateTable('local_credentials')
    .set((eb) => ({ failed_attempts: eb('failed_attempts', '+', 1) }))
    .where('user_id', '=', userId)
    .returning(['failed_attempts', 'locked_at'])
    .executeTakeFirst();
  if (!row || row.locked_at || row.failed_attempts < MAX_FAILED_ATTEMPTS) return false;
  await db.updateTable('local_credentials').set({ locked_at: new Date() }).where('user_id', '=', userId).execute();
  await destroyUserSessions(userId);
  return true;
}

export async function clearFailedAttempts(userId: string): Promise<void> {
  await getDb().updateTable('local_credentials').set({ failed_attempts: 0 }).where('user_id', '=', userId).execute();
}

/** Admin unlock. Returns false when the account wasn't locked (or has no Canvas password). */
export async function unlockAccount(userId: string): Promise<boolean> {
  const user = await getDb().selectFrom('users').select('id').where('id', '=', userId).executeTakeFirst();
  if (!user) throw new UserNotFoundError(`No user with id ${userId}`);
  const result = await getDb()
    .updateTable('local_credentials')
    .set({ failed_attempts: 0, locked_at: null })
    .where('user_id', '=', userId)
    .where('locked_at', 'is not', null)
    .executeTakeFirst();
  return Number(result.numUpdatedRows) > 0;
}

export interface CreateLocalUserInput {
  email: string;
  name: string;
  role: UserRole;
  personas?: string[];
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** `temporaryPassword` defaults to a generated one; bootstrap-admin passes the operator's. */
export async function createLocalUser(
  input: CreateLocalUserInput,
  temporaryPassword: string = generateOneTimePassword(),
): Promise<{ user: UserRecord; temporaryPassword: string }> {
  const email = normalizeEmail(input.email);
  const name = input.name.trim() || email;
  const { hash, salt } = hashPassword(temporaryPassword);
  const db = getDb();
  const user = await db.transaction().execute(async (trx) => {
    const existing = await trx.selectFrom('users').select('id').where('email', '=', email).executeTakeFirst();
    if (existing) throw new EmailInUseError('A user with that email already exists.');
    const id = randomUUID();
    await trx.insertInto('users').values({ id, email, name, role: input.role }).execute();
    await trx
      .insertInto('local_credentials')
      .values({ user_id: id, password_hash: hash, password_salt: salt, must_change_password: dbBoolean(true) })
      .execute();
    await setUserPersonas(trx, id, input.personas ?? []);
    return { id, email, name, role: input.role, active: true, personas: await getUserPersonas(trx, id) };
  });
  return { user, temporaryPassword };
}

/** Issues a new one-time password and signs the user out everywhere. */
export async function resetLocalPassword(userId: string): Promise<{ temporaryPassword: string }> {
  const temporaryPassword = generateOneTimePassword();
  await setOneTimePassword(userId, temporaryPassword);
  return { temporaryPassword };
}

/**
 * Makes `password` the user's one-time password (must be changed at next sign-in), creating their
 * Canvas credentials if they had none, and signs them out everywhere. Used by an admin's reset and
 * by the bootstrap-admin recovery (seed/bootstrap-admin.ts).
 */
export async function setOneTimePassword(userId: string, password: string): Promise<void> {
  const { hash, salt } = hashPassword(password);
  const db = getDb();
  await db.transaction().execute(async (trx) => {
    const user = await trx.selectFrom('users').select('id').where('id', '=', userId).executeTakeFirst();
    if (!user) throw new UserNotFoundError(`No user with id ${userId}`);
    // A reset also unlocks (canvas-ez1.4): the new one-time password is the way back in.
    const values = { password_hash: hash, password_salt: salt, must_change_password: dbBoolean(true), failed_attempts: 0, locked_at: null };
    await trx
      .insertInto('local_credentials')
      .values({ user_id: userId, ...values })
      .onConflict((oc) => oc.column('user_id').doUpdateSet(values))
      .execute();
  });
  await destroyUserSessions(userId);
}

/** A signed-in user changing their own password. Other sessions of theirs are ended. */
export async function changeOwnPassword(input: {
  userId: string;
  email: string;
  currentPassword: string;
  newPassword: string;
  sessionId: string;
}): Promise<void> {
  const db = getDb();
  const row = await db
    .selectFrom('local_credentials')
    .select(['password_hash', 'password_salt'])
    .where('user_id', '=', input.userId)
    .executeTakeFirst();
  if (!row) throw new NoLocalPasswordError('This account signs in with single sign-on and has no Canvas password.');
  if (!verifyPassword(input.currentPassword, row.password_hash, row.password_salt)) {
    // Counts toward the lockout like a failed sign-in (someone at an unattended session).
    if (await recordFailedAttempt(input.userId)) throw new AccountLockedError(LOCKED_MESSAGE);
    throw new WrongPasswordError('Your current password is incorrect.');
  }
  await clearFailedAttempts(input.userId);
  if (input.newPassword === input.currentPassword) {
    throw new PasswordPolicyError('Choose a new password, different from the current one.');
  }
  const problem = checkPasswordPolicy(input.newPassword, { email: input.email });
  if (problem) throw new PasswordPolicyError(problem);
  const { hash, salt } = hashPassword(input.newPassword);
  await db
    .updateTable('local_credentials')
    .set({ password_hash: hash, password_salt: salt, must_change_password: dbBoolean(false) })
    .where('user_id', '=', input.userId)
    .execute();
  await destroyUserSessions(input.userId, input.sessionId);
}
