import { getPool, closePool } from '../db/pool.js';
import { hashPassword } from '../auth/password.js';
import { runMigrations } from '../db/migrate.js';
import { seedDiagramTypes } from './diagram-types.seed.js';
import { seedLibraries } from './libraries.seed.js';
import { seedAiPersonas } from './ai-personas.seed.js';

/**
 * Seeds a minimal dev/demo dataset: the full built-in DiagramType catalog, the bundled Icon/Shape
 * Libraries, one default Project, and one admin user with local-auth credentials — matches
 * quickstart.md's local setup steps.
 */
async function seed(): Promise<void> {
  await runMigrations();
  const pool = getPool();

  await seedDiagramTypes();
  await seedLibraries();
  await seedAiPersonas();

  async function ensureUser(
    name: string,
    email: string,
    role: 'admin' | 'architect' | 'viewer',
    password: string,
  ): Promise<string> {
    const { rows: existing } = await pool.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [email]);
    if (existing[0]) return existing[0].id;

    const { rows } = await pool.query<{ id: string }>(
      'INSERT INTO users (name, email, role) VALUES ($1, $2, $3) RETURNING id',
      [name, email, role],
    );
    const { hash, salt } = hashPassword(password);
    await pool.query('INSERT INTO local_credentials (user_id, password_hash, password_salt) VALUES ($1, $2, $3)', [
      rows[0].id,
      hash,
      salt,
    ]);
    return rows[0].id;
  }

  const adminId = await ensureUser('Admin', 'admin@example.com', 'admin', 'admin-dev-password');
  const architectId = await ensureUser('Architect', 'architect@example.com', 'architect', 'architect-dev-password');
  // Deliberately given no project ownership and no project-level grant (feature 008,
  // research.md §5). Every other seeded user always has some project access — admin owns one,
  // architect is explicitly granted one below — so neither can stand in for "a user with a
  // diagram-level grant and zero project access", which is this feature's own primary scenario.
  await ensureUser('Guest', 'guest@example.com', 'viewer', 'guest-dev-password');

  const { rows: existingProjects } = await pool.query('SELECT id FROM projects WHERE name = $1', [
    'Smoke Test',
  ]);
  const projectId = existingProjects[0]
    ? existingProjects[0].id
    : (
        await pool.query<{ id: string }>(
          "INSERT INTO projects (name, owner_id) VALUES ('Smoke Test', $1) RETURNING id",
          [adminId],
        )
      ).rows[0].id;

  // The architect needs an explicit grant now that project visibility follows ownership
  // (feature 007, FR-013a). Without this the seeded environment has a signed-in user who can see
  // no projects at all and therefore cannot do anything — which is exactly what the backfill
  // produces for every non-owner on a real installation, so it is worth seeing in dev.
  await pool.query(
    `INSERT INTO share_grants (subject_type, subject_id, grantee_user_id, access_level, granted_by_user_id)
     VALUES ('project', $1, $2, 'edit', $3)
     ON CONFLICT (subject_type, subject_id, grantee_user_id) DO NOTHING`,
    [projectId, architectId, adminId],
  );

  console.log('Seed complete.');
  console.log(`  Admin login: admin@example.com / admin-dev-password`);
  console.log(`  Architect login: architect@example.com / architect-dev-password`);
  console.log(`  Guest login: guest@example.com / guest-dev-password (no project access)`);
  console.log(`  Project id: ${projectId}`);
}

seed()
  .then(() => closePool())
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
    return closePool();
  });
