import { createHash, randomInt, randomUUID } from 'node:crypto';
import { getDb } from '../db/client.js';
import { destroyUserSessions } from './session-store.js';
import { decryptSecret, encryptSecret } from './mfa-crypto.js';
import { generateTotpSecret, verifyTotp } from './totp.js';

/**
 * canvas-ez1.5: two-step verification for Canvas-password accounts -- an authenticator-app code
 * (TOTP) after the password, or a single-use recovery code. The secret is stored encrypted.
 */

export class MfaAlreadyEnabledError extends Error {}
export class MfaNotStartedError extends Error {}
export class InvalidMfaCodeError extends Error {}

export const RECOVERY_CODE_COUNT = 10;

export async function isMfaEnabled(userId: string): Promise<boolean> {
  const row = await getDb().selectFrom('user_mfa').select('enabled_at').where('user_id', '=', userId).executeTakeFirst();
  return Boolean(row?.enabled_at);
}

/** Starts (or restarts) set-up: a new secret, not active until confirmed with a code. */
export async function startMfaEnrollment(userId: string, key: Buffer): Promise<string> {
  if (await isMfaEnabled(userId)) throw new MfaAlreadyEnabledError('Two-step verification is already set up.');
  const secret = generateTotpSecret();
  const secretEncrypted = encryptSecret(secret, key);
  await getDb()
    .insertInto('user_mfa')
    .values({ user_id: userId, secret_encrypted: secretEncrypted, enabled_at: null, last_used_step: null })
    .onConflict((oc) => oc.column('user_id').doUpdateSet({ secret_encrypted: secretEncrypted, enabled_at: null, last_used_step: null }))
    .execute();
  return secret;
}

/** Confirms set-up with a code from the app; returns the recovery codes (shown once). */
export async function confirmMfaEnrollment(userId: string, code: string, key: Buffer, nowMs = Date.now()): Promise<string[]> {
  const db = getDb();
  const row = await db.selectFrom('user_mfa').select(['secret_encrypted', 'enabled_at']).where('user_id', '=', userId).executeTakeFirst();
  if (row?.enabled_at) throw new MfaAlreadyEnabledError('Two-step verification is already set up.');
  if (!row) throw new MfaNotStartedError('Start setting up two-step verification first.');
  const step = verifyTotp(decryptSecret(row.secret_encrypted, key), code, nowMs, null);
  if (step === null) throw new InvalidMfaCodeError("That code didn't match. Check the time on your phone and try the current code.");
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
  await db.transaction().execute(async (trx) => {
    await trx.updateTable('user_mfa').set({ enabled_at: new Date(nowMs), last_used_step: step }).where('user_id', '=', userId).execute();
    await trx.deleteFrom('mfa_recovery_codes').where('user_id', '=', userId).execute();
    await trx
      .insertInto('mfa_recovery_codes')
      .values(codes.map((c) => ({ id: randomUUID(), user_id: userId, code_hash: hashRecoveryCode(c), used_at: null })))
      .execute();
  });
  return codes;
}

/**
 * The second sign-in step: an authenticator code (not one already used) or an unused recovery
 * code. Returns which one matched, or null.
 */
export async function verifySecondFactor(userId: string, code: string, key: Buffer, nowMs = Date.now()): Promise<'totp' | 'recovery_code' | null> {
  const db = getDb();
  const row = await db
    .selectFrom('user_mfa')
    .select(['secret_encrypted', 'enabled_at', 'last_used_step'])
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (!row?.enabled_at) return null;
  const trimmed = code.trim();
  if (/^\d{3}\s?\d{3}$/.test(trimmed)) {
    const lastUsed = row.last_used_step === null ? null : Number(row.last_used_step);
    const step = verifyTotp(decryptSecret(row.secret_encrypted, key), trimmed, nowMs, lastUsed);
    if (step === null) return null;
    // Conditional update: two requests racing with the same code can't both succeed.
    const result = await db
      .updateTable('user_mfa')
      .set({ last_used_step: step })
      .where('user_id', '=', userId)
      .where((eb) => eb.or([eb('last_used_step', 'is', null), eb('last_used_step', '<', step)]))
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0 ? 'totp' : null;
  }
  const result = await db
    .updateTable('mfa_recovery_codes')
    .set({ used_at: new Date(nowMs) })
    .where('user_id', '=', userId)
    .where('code_hash', '=', hashRecoveryCode(trimmed))
    .where('used_at', 'is', null)
    .executeTakeFirst();
  return Number(result.numUpdatedRows) > 0 ? 'recovery_code' : null;
}

export async function remainingRecoveryCodes(userId: string): Promise<number> {
  const rows = await getDb().selectFrom('mfa_recovery_codes').select('id').where('user_id', '=', userId).where('used_at', 'is', null).execute();
  return rows.length;
}

/** Admin reset (lost phone): removes MFA; the user sets it up again at next sign-in. */
export async function resetMfa(userId: string): Promise<void> {
  const db = getDb();
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom('mfa_recovery_codes').where('user_id', '=', userId).execute();
    await trx.deleteFrom('user_mfa').where('user_id', '=', userId).execute();
  });
  await destroyUserSessions(userId);
}

const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** "xxxxx-xxxxx" from a 31-character alphabet (~50 bits). */
function generateRecoveryCode(): string {
  let code = '';
  for (let i = 0; i < 10; i++) code += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

/** Recovery codes are random (not chosen by people), so a plain SHA-256 is enough. */
function hashRecoveryCode(code: string): string {
  const normalized = code.toLowerCase().replace(/[\s-]/g, '');
  return createHash('sha256').update(`canvas-recovery:${normalized}`).digest('hex');
}
