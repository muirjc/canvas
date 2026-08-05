import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { closePool, getPool } from '../../src/db/pool.js';
import { hashPassword } from '../../src/auth/password.js';
import { runMigrations } from '../../src/db/migrate.js';

export async function buildTestApp(): Promise<FastifyInstance> {
  process.env.NODE_ENV = 'test';
  const config = loadConfig();
  config.allowLocalAuth = true;
  await runMigrations();
  return buildApp({ config, logger: false });
}

export async function resetDatabase(): Promise<void> {
  const pool = getPool();
  // canvas-uw8: defense-in-depth on top of config.ts's own hard test-mode override — refuses to
  // run this TRUNCATE against anything that isn't clearly a test database, so a future code path
  // that somehow bypasses loadConfig()'s guard still can't wipe the real dev/prod data.
  const { rows } = await pool.query<{ current_database: string }>('SELECT current_database()');
  const dbName = rows[0].current_database;
  if (!dbName.endsWith('_test')) {
    throw new Error(
      `resetDatabase() refused to TRUNCATE database "${dbName}" — expected a name ending in ` +
        `"_test". This guard exists specifically to prevent wiping the dev database (canvas-uw8).`,
    );
  }
  await pool.query(
    `TRUNCATE TABLE
       chat_messages, diagram_chats, ai_personas,
       share_grants, diagram_versions, diagrams, templates, standards, icons, icon_libraries,
       projects, diagram_types, local_credentials, users
     RESTART IDENTITY CASCADE`,
  );
  // ai_settings is a singleton row (CHECK (id) constraint) seeded by the migration, not
  // recreated by app code — reset its value instead of truncating so the row keeps existing.
  await pool.query('UPDATE ai_settings SET chat_enabled = false');
}

export async function closeTestDb(): Promise<void> {
  await closePool();
}

interface SeedUserOptions {
  email: string;
  name?: string;
  role?: 'admin' | 'architect' | 'viewer';
  password: string;
}

export async function seedUser(options: SeedUserOptions): Promise<{ id: string }> {
  const pool = getPool();
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users (name, email, role) VALUES ($1, $2, $3) RETURNING id`,
    [options.name ?? options.email, options.email, options.role ?? 'architect'],
  );
  const { hash, salt } = hashPassword(options.password);
  await pool.query(
    'INSERT INTO local_credentials (user_id, password_hash, password_salt) VALUES ($1, $2, $3)',
    [rows[0].id, hash, salt],
  );
  return rows[0];
}

export async function seedFlowchartDiagramType(): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO diagram_types (id, name, personas, abstraction_level, dsl_family, default_palette_library_ids)
     VALUES ('flowchart', 'Generic Flowchart', ARRAY['Business','Enterprise','Solution','Technical'], 'N/A', 'flowchart', ARRAY['generic'])
     ON CONFLICT (id) DO NOTHING`,
  );
}

/**
 * `ownerId` became required with feature 007 (`projects.owner_id` is NOT NULL). Callers that
 * don't care who owns the project may omit it, in which case any existing user is used — seeding
 * a user first is a precondition of every caller anyway.
 */
export async function seedProject(name = 'Test Project', ownerId?: string): Promise<{ id: string }> {
  const pool = getPool();
  const owner = ownerId ?? (await pool.query<{ id: string }>('SELECT id FROM users ORDER BY created_at LIMIT 1')).rows[0]?.id;
  if (!owner) throw new Error('seedProject needs a user to own the project — call seedUser first.');
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO projects (name, owner_id) VALUES ($1, $2) RETURNING id',
    [name, owner],
  );
  return rows[0];
}
