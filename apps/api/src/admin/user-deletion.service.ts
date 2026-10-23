import { sql } from 'kysely';
import { getDb } from '../db/client.js';
import { dbBoolean } from '../db/sql-helpers.js';
import { revokeSessions } from '../auth/session-store.js';
import { recordAudit } from '../audit/audit.service.js';
import { UserNotFoundError } from './admin.service.js';

/**
 * canvas-0se: deleting a user. Many tables point at users with strict foreign keys (owners,
 * version authors, who granted a share, who deleted/restored something), so the row isn't removed:
 * it becomes an anonymised placeholder ("Deleted user", a unique placeholder email that frees the
 * real one, inactive, deleted_at set). Their projects and diagrams go to another user; their
 * credentials, MFA, personas, sessions and the shares they received are removed; history stays.
 */

export class CannotDeleteUserError extends Error {}

export interface DeletionImpact {
  ownedProjects: number;
  ownedDiagrams: number;
  sharesReceived: number;
  /** Deleting would leave no active admin. */
  isLastActiveAdmin: boolean;
}

async function activeUser(userId: string) {
  return getDb()
    .selectFrom('users')
    .select(['id', 'email', 'name', 'role', 'active'])
    .where('id', '=', userId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
}

const count = sql<string>`COUNT(*)`.as('count');

export async function deletionImpact(userId: string): Promise<DeletionImpact> {
  const user = await activeUser(userId);
  if (!user) throw new UserNotFoundError(`No user with id ${userId}`);
  const db = getDb();
  const [projects, diagrams, shares, admins] = await Promise.all([
    db.selectFrom('projects').select(count).where('owner_id', '=', userId).executeTakeFirstOrThrow(),
    db.selectFrom('diagrams').select(count).where('owner_id', '=', userId).executeTakeFirstOrThrow(),
    db.selectFrom('share_grants').select(count).where('grantee_user_id', '=', userId).executeTakeFirstOrThrow(),
    db
      .selectFrom('users')
      .select(count)
      .where('role', '=', 'admin')
      .where('active', '=', dbBoolean(true))
      .where('deleted_at', 'is', null)
      .executeTakeFirstOrThrow(),
  ]);
  const isActiveAdmin = user.role === 'admin' && Boolean(user.active);
  return {
    ownedProjects: Number(projects.count),
    ownedDiagrams: Number(diagrams.count),
    sharesReceived: Number(shares.count),
    isLastActiveAdmin: isActiveAdmin && Number(admins.count) <= 1,
  };
}

export async function deleteUser(input: {
  userId: string;
  actorUserId: string;
  transferToUserId?: string;
  ip?: string;
}): Promise<{ transferredProjects: number; transferredDiagrams: number }> {
  const { userId, actorUserId, transferToUserId } = input;
  if (userId === actorUserId) throw new CannotDeleteUserError("You can't delete your own account.");
  const user = await activeUser(userId);
  if (!user) throw new UserNotFoundError(`No user with id ${userId}`);
  const impact = await deletionImpact(userId);
  if (impact.isLastActiveAdmin) throw new CannotDeleteUserError("This is the only active admin -- make someone else an admin first.");
  const owns = impact.ownedProjects + impact.ownedDiagrams > 0;
  if (owns && !transferToUserId) {
    throw new CannotDeleteUserError('Choose who receives their projects and diagrams.');
  }
  let transferToEmail: string | null = null;
  if (transferToUserId) {
    if (transferToUserId === userId) throw new CannotDeleteUserError("Their content can't be transferred to them.");
    const target = await activeUser(transferToUserId);
    if (!target || !target.active) throw new CannotDeleteUserError('Transfer to an active user.');
    transferToEmail = target.email;
  }

  await getDb()
    .transaction()
    .execute(async (trx) => {
      if (transferToUserId) {
        await trx.updateTable('projects').set({ owner_id: transferToUserId }).where('owner_id', '=', userId).execute();
        await trx.updateTable('diagrams').set({ owner_id: transferToUserId }).where('owner_id', '=', userId).execute();
      }
      await trx.deleteFrom('share_grants').where('grantee_user_id', '=', userId).execute();
      await trx.deleteFrom('mfa_recovery_codes').where('user_id', '=', userId).execute();
      await trx.deleteFrom('user_mfa').where('user_id', '=', userId).execute();
      await trx.deleteFrom('local_credentials').where('user_id', '=', userId).execute();
      await trx.deleteFrom('users_personas').where('user_id', '=', userId).execute();
      await revokeSessions({ userId }, trx);
      await trx
        .updateTable('users')
        .set({
          name: 'Deleted user',
          email: `deleted-${userId}@deleted.invalid`,
          active: dbBoolean(false),
          deleted_at: new Date(),
        })
        .where('id', '=', userId)
        .execute();
    });

  // The placeholder keeps no name or email, so the audit entry records them.
  await recordAudit({
    event: 'user_deleted',
    actorUserId,
    targetUserId: userId,
    ip: input.ip,
    detail: {
      email: user.email,
      name: user.name,
      transferredTo: transferToUserId ?? null,
      transferredToEmail: transferToEmail,
      projects: impact.ownedProjects,
      diagrams: impact.ownedDiagrams,
      sharesRemoved: impact.sharesReceived,
    },
  });
  return { transferredProjects: transferToUserId ? impact.ownedProjects : 0, transferredDiagrams: transferToUserId ? impact.ownedDiagrams : 0 };
}
