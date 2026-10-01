import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { closePool, getPool } from '../../src/db/pool.js';
import { closeDb, getDb } from '../../src/db/client.js';
import { setDiagramTypePersonas, setDiagramTypePaletteLibraries } from '../../src/db/array-columns.js';
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
  // The `CASCADE` clause already empties every table with an FK pointing at one of these —
  // `ai_persona_reference_material` (-> ai_personas) was never listed explicitly either, and the 7
  // join tables canvas-jtm.3 added (-> users/diagram_types/icons/standards/
  // ai_persona_reference_material) don't need to be either, for the same reason.
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
  // db/client.ts (Kysely) wraps its own separate pg.Pool instance alongside db/pool.ts's — both
  // must close, or a connection leaks past test teardown. Both stay needed permanently
  // (canvas-jtm.6): runMigrations() (db/migrate.ts, called by buildTestApp()) deliberately stays
  // on db/pool.ts's raw pg.Pool — a dependency-free migration runner is a permanent design choice
  // (Constitution VI), not a conversion still pending.
  await closeDb();
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
    `INSERT INTO users (id, name, email, role) VALUES ($1, $2, $3, $4) RETURNING id`,
    [randomUUID(), options.name ?? options.email, options.email, options.role ?? 'architect'],
  );
  const { hash, salt } = hashPassword(options.password);
  await pool.query(
    'INSERT INTO local_credentials (user_id, password_hash, password_salt) VALUES ($1, $2, $3)',
    [rows[0].id, hash, salt],
  );
  return rows[0];
}

const ALL_PERSONAS = ['Business', 'Enterprise', 'Solution', 'Technical'];

/** `ON CONFLICT ... DO NOTHING` + `.returning()` returns no row when the conflict branch fires
 *  (Postgres semantics) — used here to skip the personas/palette-library writes entirely when the
 *  diagram type already existed, matching the original single-statement upsert's "do nothing at
 *  all on conflict" behavior exactly (not just "don't re-insert the row but still touch its
 *  join-table rows"). */
export async function seedFlowchartDiagramType(): Promise<void> {
  const db = getDb();
  await db.transaction().execute(async (trx) => {
    const row = await trx
      .insertInto('diagram_types')
      .values({ id: 'flowchart', name: 'Generic Flowchart', abstraction_level: 'N/A', dsl_family: 'flowchart' })
      .onConflict((oc) => oc.column('id').doNothing())
      .returning('id')
      .executeTakeFirst();
    if (row) {
      await setDiagramTypePersonas(trx, row.id, ALL_PERSONAS);
      await setDiagramTypePaletteLibraries(trx, row.id, ['generic']);
    }
  });
}

/** 010-ai-diagram-knowledge: a generic diagram-type seeder for the 5 non-flowchart families —
 *  `seedFlowchartDiagramType` above stays as-is (many other test files already call it by name)
 *  rather than being rewritten in terms of this one. `id` and `dslFamily` are the same value for
 *  every one of this platform's own seeded diagram types today, but kept as separate parameters
 *  since nothing requires that to remain true. */
export async function seedDiagramType(id: string, dslFamily: string, name = id): Promise<void> {
  const db = getDb();
  await db.transaction().execute(async (trx) => {
    const row = await trx
      .insertInto('diagram_types')
      .values({ id, name, abstraction_level: 'N/A', dsl_family: dslFamily })
      .onConflict((oc) => oc.column('id').doNothing())
      .returning('id')
      .executeTakeFirst();
    if (row) {
      await setDiagramTypePersonas(trx, row.id, ALL_PERSONAS);
      await setDiagramTypePaletteLibraries(trx, row.id, ['generic']);
    }
  });
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
    'INSERT INTO projects (id, name, owner_id) VALUES ($1, $2, $3) RETURNING id',
    [randomUUID(), name, owner],
  );
  return rows[0];
}
