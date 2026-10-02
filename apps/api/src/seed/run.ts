import { randomUUID } from 'node:crypto';
import { closePool } from '../db/pool.js';
import { closeDb, getDb } from '../db/client.js';
import { hashPassword } from '../auth/password.js';
import { seedCatalog } from './catalog.js';

/**
 * Seeds a minimal dev/demo dataset: catalog.ts's reference data (DiagramTypes, Icon/Shape
 * Libraries, AiPersonas) plus one default Project and one admin user with local-auth
 * credentials — matches quickstart.md's local setup steps. See catalog.ts's own doc comment for
 * why the reference-data portion lives there instead of here: it's safe to run unconditionally on
 * a clean environment build, unlike the demo account this function also creates.
 */
async function seed(): Promise<void> {
  await seedCatalog();
  const db = getDb();

  async function ensureUser(
    name: string,
    email: string,
    role: 'admin' | 'architect' | 'viewer',
    password: string,
  ): Promise<string> {
    const existing = await db.selectFrom('users').select('id').where('email', '=', email).executeTakeFirst();
    if (existing) return existing.id;

    const user = await db
      .insertInto('users')
      .values({ id: randomUUID(), name, email, role })
      .returning('id')
      .executeTakeFirstOrThrow();
    const { hash, salt } = hashPassword(password);
    await db
      .insertInto('local_credentials')
      .values({ user_id: user.id, password_hash: hash, password_salt: salt })
      .execute();
    return user.id;
  }

  const adminId = await ensureUser('Admin', 'admin@example.com', 'admin', 'admin-dev-password');
  const architectId = await ensureUser('Architect', 'architect@example.com', 'architect', 'architect-dev-password');
  // Deliberately given no project ownership and no project-level grant (feature 008,
  // research.md §5). Every other seeded user always has some project access — admin owns one,
  // architect is explicitly granted one below — so neither can stand in for "a user with a
  // diagram-level grant and zero project access", which is this feature's own primary scenario.
  await ensureUser('Guest', 'guest@example.com', 'viewer', 'guest-dev-password');

  const existingProject = await db.selectFrom('projects').select('id').where('name', '=', 'Smoke Test').executeTakeFirst();
  const projectId = existingProject
    ? existingProject.id
    : (
        await db
          .insertInto('projects')
          .values({ id: randomUUID(), name: 'Smoke Test', owner_id: adminId })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;

  // The architect needs an explicit grant now that project visibility follows ownership
  // (feature 007, FR-013a). Without this the seeded environment has a signed-in user who can see
  // no projects at all and therefore cannot do anything — which is exactly what the backfill
  // produces for every non-owner on a real installation, so it is worth seeing in dev.
  await db
    .insertInto('share_grants')
    .values({
      id: randomUUID(),
      subject_type: 'project',
      subject_id: projectId,
      grantee_user_id: architectId,
      access_level: 'edit',
      granted_by_user_id: adminId,
    })
    .onConflict((oc) => oc.columns(['subject_type', 'subject_id', 'grantee_user_id']).doNothing())
    .execute();

  console.log('Seed complete.');
  console.log(`  Admin login: admin@example.com / admin-dev-password`);
  console.log(`  Architect login: architect@example.com / architect-dev-password`);
  console.log(`  Guest login: guest@example.com / guest-dev-password (no project access)`);
  console.log(`  Project id: ${projectId}`);
}

// canvas-jtm.6: every application-level query in this script is on Kysely now, but
// runMigrations() (db/migrate.ts) deliberately stays on db/pool.ts's raw pg.Pool — a dependency-
// free migration runner is a permanent design choice (Constitution VI), not a conversion still
// pending — so both pools still need closing here.
seed()
  .then(() => Promise.all([closeDb(), closePool()]))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
    return Promise.all([closeDb(), closePool()]);
  });
