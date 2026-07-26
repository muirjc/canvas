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
  await pool.query(
    `TRUNCATE TABLE
       share_grants, diagram_versions, diagrams, templates, standards, icons, icon_libraries,
       projects, diagram_types, local_credentials, users
     RESTART IDENTITY CASCADE`,
  );
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

export async function seedProject(name = 'Test Project'): Promise<{ id: string }> {
  const pool = getPool();
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO projects (name) VALUES ($1) RETURNING id',
    [name],
  );
  return rows[0];
}
