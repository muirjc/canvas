import { closePool } from '../db/pool.js';
import { closeDb, getDb } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { purgeProjectDiagrams } from '../diagrams/diagram.service.js';

/**
 * canvas-fbv: local e2e runs left ~500-600 diagrams per run in the seeded "Smoke Test" project
 * (E2E_PROJECT_ID) -- 1,486 to 3,147 in one day -- so every screen showing it, and the specs that
 * render it, got steadily slower. apps/web's Playwright global setup runs this before each LOCAL
 * run (CI starts from an empty database) to permanently delete every diagram in that project; the
 * seed then restores the project's starting state (the project and the architect's access -- it
 * creates no diagrams). Only the "Smoke Test" fixture is touched. Refuses in production.
 *
 * Usage: npm run e2e:reset --workspace=@canvas/api
 */
async function resetE2e(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('e2e:reset refuses to run with NODE_ENV=production.');
  }
  await runMigrations();
  await removeE2eUsers();
  const project = await getDb().selectFrom('projects').select('id').where('name', '=', 'Smoke Test').executeTakeFirst();
  if (!project) {
    console.log('e2e reset: no "Smoke Test" project yet -- nothing to clear.');
    return;
  }
  const purged = await purgeProjectDiagrams(project.id);
  console.log(`e2e reset: removed ${purged.length} diagram(s) from the "Smoke Test" project.`);
}

/** canvas-ez1.2: local-user-management.spec.ts creates an e2e-user-<timestamp> account per run. */
async function removeE2eUsers(): Promise<void> {
  const db = getDb();
  const users = await db.selectFrom('users').select('id').where('email', 'like', 'e2e-user-%@example.com').execute();
  let removed = 0;
  for (const { id } of users) {
    try {
      await db.transaction().execute(async (trx) => {
        await trx.deleteFrom('sessions').where('user_id', '=', id).execute();
        await trx.deleteFrom('users_personas').where('user_id', '=', id).execute();
        await trx.deleteFrom('local_credentials').where('user_id', '=', id).execute();
        await trx.deleteFrom('users').where('id', '=', id).execute();
      });
      removed++;
    } catch {
      // Owns or is referenced by something (a project, a share): leave it.
    }
  }
  if (users.length) console.log(`e2e reset: removed ${removed} of ${users.length} e2e user account(s).`);
}

resetE2e()
  .then(() => Promise.all([closeDb(), closePool()]))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
    return Promise.all([closeDb(), closePool()]);
  });
