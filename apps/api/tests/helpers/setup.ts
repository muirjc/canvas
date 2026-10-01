import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { closePool, getPool } from '../../src/db/pool.js';
import { closeDb, getDb } from '../../src/db/client.js';
import { setDiagramTypePersonas, setDiagramTypePaletteLibraries } from '../../src/db/array-columns.js';
import { dbBoolean } from '../../src/db/sql-helpers.js';
import { hashPassword } from '../../src/auth/password.js';
import { runMigrations } from '../../src/db/migrate.js';

export async function buildTestApp(): Promise<FastifyInstance> {
  process.env.NODE_ENV = 'test';
  const config = loadConfig();
  config.allowLocalAuth = true;
  await runMigrations();
  return buildApp({ config, logger: false });
}

/**
 * canvas-jtm.7: dialect-branches between Postgres's `TRUNCATE ... CASCADE` (fast, and already
 * handles every FK-dependent table via CASCADE with no explicit ordering) and SQLite, which has no
 * `TRUNCATE` at all — the portable replacement is a dependency-ordered sequence of `DELETE FROM`
 * statements via Kysely (not raw SQL, so one definition works against either engine's actual
 * driver). `diagrams.current_version_id` / `diagram_versions.diagram_id` form a real FK cycle
 * (0001_init.sql's own late `ALTER TABLE ... ADD CONSTRAINT`, mirrored as an inline forward
 * reference in the SQLite migration) — nulled out first so neither delete violates the other's FK.
 */
async function resetDatabaseSqlite(): Promise<void> {
  const db = getDb();
  await db.updateTable('diagrams').set({ current_version_id: null }).execute();
  await db.deleteFrom('ai_persona_reference_material_families').execute();
  await db.deleteFrom('chat_messages').execute();
  await db.deleteFrom('diagram_chats').execute();
  await db.deleteFrom('ai_persona_reference_material').execute();
  await db.deleteFrom('ai_personas').execute();
  await db.deleteFrom('share_grants').execute();
  await db.deleteFrom('diagram_versions').execute();
  await db.deleteFrom('diagrams').execute();
  await db.deleteFrom('standard_allowed_shapes').execute();
  await db.deleteFrom('standard_mandatory_shapes').execute();
  await db.deleteFrom('standards').execute();
  await db.deleteFrom('icon_keywords').execute();
  await db.deleteFrom('icons').execute();
  await db.deleteFrom('icon_libraries').execute();
  await db.deleteFrom('diagram_type_palette_libraries').execute();
  await db.deleteFrom('diagram_types_personas').execute();
  await db.deleteFrom('templates').execute();
  await db.deleteFrom('diagram_types').execute();
  await db.deleteFrom('local_credentials').execute();
  await db.deleteFrom('users_personas').execute();
  await db.deleteFrom('projects').execute();
  await db.deleteFrom('users').execute();
  // ai_settings is a singleton row (CHECK (id = 1) constraint) seeded by the migration, not
  // recreated by app code — reset its value instead of deleting so the row keeps existing.
  await db.updateTable('ai_settings').set({ chat_enabled: dbBoolean(false) }).execute();
}

async function resetDatabasePostgres(): Promise<void> {
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

export async function resetDatabase(): Promise<void> {
  const config = loadConfig();
  return config.dbClient === 'sqlite' ? resetDatabaseSqlite() : resetDatabasePostgres();
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
  const db = getDb();
  const id = randomUUID();
  await db
    .insertInto('users')
    .values({ id, name: options.name ?? options.email, email: options.email, role: options.role ?? 'architect' })
    .execute();
  const { hash, salt } = hashPassword(options.password);
  await db.insertInto('local_credentials').values({ user_id: id, password_hash: hash, password_salt: salt }).execute();
  return { id };
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
  const db = getDb();
  const owner = ownerId ?? (await db.selectFrom('users').select('id').orderBy('created_at').limit(1).executeTakeFirst())?.id;
  if (!owner) throw new Error('seedProject needs a user to own the project — call seedUser first.');
  const id = randomUUID();
  await db.insertInto('projects').values({ id, name, owner_id: owner }).execute();
  return { id };
}
