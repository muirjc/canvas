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

  async function ensureUser(name: string, email: string, role: 'admin' | 'architect', password: string): Promise<string> {
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

  await ensureUser('Admin', 'admin@example.com', 'admin', 'admin-dev-password');
  await ensureUser('Architect', 'architect@example.com', 'architect', 'architect-dev-password');

  const { rows: existingProjects } = await pool.query('SELECT id FROM projects WHERE name = $1', [
    'Smoke Test',
  ]);
  const projectId = existingProjects[0]
    ? existingProjects[0].id
    : (await pool.query<{ id: string }>("INSERT INTO projects (name) VALUES ('Smoke Test') RETURNING id"))
        .rows[0].id;

  console.log('Seed complete.');
  console.log(`  Admin login: admin@example.com / admin-dev-password`);
  console.log(`  Architect login: architect@example.com / architect-dev-password`);
  console.log(`  Project id: ${projectId}`);
}

seed()
  .then(() => closePool())
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
    return closePool();
  });
