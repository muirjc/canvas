/**
 * Hand-typed Kysely schema mirroring `apps/api/migrations/*.sql` exactly — not generated, to
 * avoid a codegen dependency (canvas-jtm Phase 0, see
 * /home/jmuir/.claude/plans/we-need-to-make-graceful-ocean.md).
 *
 * This is a types-only module: it has zero runtime behavior and is Postgres-flavored for now
 * (`UUID`/`TEXT[]`/`JSONB`/`TIMESTAMPTZ` columns typed as what node-postgres actually hands back).
 * It intentionally covers every table in the real schema, not just the ones Phase 0 converts —
 * every later phase builds on this one definition rather than each file inventing its own partial
 * row type, which is exactly the drift problem the current "no shared layer at all" design has.
 *
 * `Generated<T>` marks a column optional on insert (DB fills it via `DEFAULT`) — used here for
 * every `DEFAULT gen_random_uuid()`/`DEFAULT now()`/`DEFAULT <literal>` column. Phase 2 removes
 * `gen_random_uuid()` entirely (ids become app-generated), at which point those `id` columns stop
 * being `Generated` — a deliberate, tracked future change, not an oversight today.
 *
 * Timestamp columns are typed `Timestamp` (see below), matching node-postgres's actual runtime
 * behavior (a native `Date`) rather than perpetuating the `created_at: string` convention some
 * existing hand-written service-layer interfaces use (that convention is harmless today only
 * because Fastify's `reply.send()` JSON-serializes a `Date` to an ISO string on the way out — it
 * is not what callers hold in hand before that point, and this schema should not encode a
 * different runtime reality than the one node-postgres actually produces).
 *
 * `TEXT[]` array columns are typed `string[]` — accurate for Postgres via node-postgres today.
 * Phase 2 replaces all 7 of these with join tables; this type goes away on that column at that
 * point, not before.
 *
 * `JSONB` columns are typed via `JsonColumn<T>` — node-postgres auto (de)serializes JSON/JSONB,
 * so the Select/Insert/Update shapes are symmetric (unlike Kysely's own `JSONColumnType`, which
 * assumes a driver that hands back a raw string needing `JSON.parse`).
 */
import type { ColumnType, Generated } from 'kysely';

/**
 * What node-postgres actually returns for `TIMESTAMPTZ`/`TIMESTAMP` columns: a `Date` on read,
 * accepting a `Date` or an ISO string on write.
 *
 * Two variants, matching Kysely's own documented pattern for a column whose select/insert/update
 * types genuinely differ (`ColumnType<S, I, U>`) — `Generated<ColumnType<...>>` double-wraps and
 * breaks Kysely's type-level insert/update extraction (confirmed via `tsc`: wrapping a
 * `ColumnType` in `Generated<>` produced an unassignable `ValueExpression` on `.set()`), so a
 * generated timestamp column gets its own `undefined`-inclusive Insert type directly instead of
 * composing with `Generated<T>`.
 */
export type Timestamp = ColumnType<Date, Date | string, Date | string>;
/** A `TIMESTAMPTZ ... DEFAULT now()` column — optional on insert, same read/update shape as
 *  {@link Timestamp} otherwise. */
export type GeneratedTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;

/**
 * A `JSONB`/`JSON` column. Select gives back the already-parsed value `T` (node-postgres
 * deserializes JSONB automatically on read) — but Insert/Update is deliberately typed `string`,
 * NOT `T`, requiring the caller to `JSON.stringify()` explicitly before writing.
 *
 * This is not symmetry for its own sake: node-postgres's default parameter serialization only
 * calls `JSON.stringify()` on a plain *object*. A JS *array* — which is what every JSONB column in
 * this schema actually stores (`allowed_icon_library_refs`, `color_palette`,
 * `last_validation_result`, `violations_at_save`, `tool_calls`) — is instead converted to a
 * Postgres ARRAY-literal (`pg/lib/utils.js`'s `arrayString()`), not JSON text. Confirmed the hard
 * way during canvas-jtm.2: passing `chat_messages.tool_calls` an array value straight through
 * Kysely produced a real Postgres error, `invalid input syntax for type json`, where the original
 * raw-SQL code had always called `JSON.stringify()` first. Typing Insert/Update as `string` turns
 * that mistake into a compile error for every future call site instead of a runtime one.
 */
export type JsonColumn<T> = ColumnType<T, string, string>;
/** A `JSONB ... DEFAULT '...'` column — see {@link GeneratedTimestamp} for why this is a second,
 *  `undefined`-inclusive `ColumnType` rather than `Generated<JsonColumn<T>>`, and {@link JsonColumn}
 *  for why Insert/Update is `string`, not `T`. */
export type GeneratedJsonColumn<T> = ColumnType<T, string | undefined, string>;

export interface UsersTable {
  id: Generated<string>;
  name: string;
  email: string;
  role: 'admin' | 'architect' | 'viewer';
  /** TEXT[] — join-table candidate, see module doc. `DEFAULT '{}'` (0001_init.sql), unlike
   *  diagram_types.personas below, which has no default. */
  personas: Generated<string[]>;
  active: Generated<boolean>;
  created_at: GeneratedTimestamp;
}

export interface ProjectsTable {
  id: Generated<string>;
  name: string;
  parent_project_id: string | null;
  owner_id: string;
  created_at: GeneratedTimestamp;
  deleted_at: Timestamp | null;
  deleted_by_user_id: string | null;
  restored_at: Timestamp | null;
  restored_by_user_id: string | null;
}

export interface DiagramTypesTable {
  id: string;
  name: string;
  /** TEXT[] — join-table candidate. */
  personas: string[];
  abstraction_level: string;
  dsl_family: string;
  /** TEXT[] — join-table candidate. */
  default_palette_library_ids: Generated<string[]>;
}

export interface IconLibrariesTable {
  id: string;
  version: string;
  license: string | null;
  created_at: GeneratedTimestamp;
}

export interface IconsTable {
  library_id: string;
  library_version: string;
  id: string;
  display_name: string;
  /** TEXT[] — join-table candidate (also the one used in actual search filtering, see plan). */
  keywords: Generated<string[]>;
  category: string;
  asset_ref: string;
}

export interface StandardsTable {
  id: Generated<string>;
  diagram_type_id: string;
  version: number;
  status: 'draft' | 'published' | 'retired';
  /** TEXT[] — join-table candidate (checked on every diagram save, a hot path — see plan). */
  allowed_shape_ids: Generated<string[]>;
  /** TEXT[] — join-table candidate. */
  mandatory_shape_ids: Generated<string[]>;
  allowed_icon_library_refs: GeneratedJsonColumn<unknown>;
  color_palette: GeneratedJsonColumn<unknown>;
  font_constraints: JsonColumn<unknown> | null;
  published_at: Timestamp | null;
  created_at: GeneratedTimestamp;
  name: string | null;
  description: string | null;
  retired_at: Timestamp | null;
}

export interface DiagramsTable {
  id: Generated<string>;
  name: string;
  diagram_type_id: string;
  project_id: string;
  owner_id: string;
  current_version_id: string | null;
  standard_version_at_last_check: number | null;
  last_validation_result: GeneratedJsonColumn<unknown>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
  deleted_at: Timestamp | null;
  deleted_by_user_id: string | null;
  restored_at: Timestamp | null;
  restored_by_user_id: string | null;
  description: string | null;
}

export interface DiagramVersionsTable {
  id: Generated<string>;
  diagram_id: string;
  sequence_number: number;
  dsl_content: string;
  author_id: string;
  violations_at_save: GeneratedJsonColumn<unknown>;
  created_at: GeneratedTimestamp;
}

export interface TemplatesTable {
  id: Generated<string>;
  diagram_type_id: string;
  persona: string;
  name: string;
  description: string | null;
  seed_dsl_content: string;
}

export interface ShareGrantsTable {
  id: Generated<string>;
  subject_type: 'diagram' | 'project';
  subject_id: string;
  grantee_user_id: string;
  access_level: 'view' | 'comment' | 'edit';
  granted_by_user_id: string;
  created_at: GeneratedTimestamp;
}

export interface LocalCredentialsTable {
  user_id: string;
  password_hash: string;
  password_salt: string;
}

export interface AiPersonasTable {
  id: Generated<string>;
  name: string;
  // Not the 'Business'|'Enterprise'|'Solution'|'Technical' literal union despite the DB's own
  // CHECK constraint: ai/persona.service.ts deliberately validates category at the app layer
  // (AI_PERSONA_CATEGORIES.includes(...)) against a plain `string` input rather than relying on a
  // narrowed type here, matching that file's own existing CreatePersonaInput/AiPersonaRecord shape.
  category: string;
  system_prompt: string;
  status: Generated<'active' | 'archived'>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface DiagramChatsTable {
  id: Generated<string>;
  diagram_id: string;
  persona_id: string | null;
  created_at: GeneratedTimestamp;
}

export interface ChatMessagesTable {
  id: Generated<string>;
  diagram_chat_id: string;
  role: 'user' | 'assistant';
  content: string;
  tool_calls: JsonColumn<unknown> | null;
  created_at: GeneratedTimestamp;
}

/** Singleton row — `id` is always literal `true` (0001_init.sql's `CHECK (id)` makes a second row
 *  impossible). Not `Generated`: every insert (there is exactly one, in the migration itself)
 *  supplies it explicitly. */
export interface AiSettingsTable {
  id: true;
  chat_enabled: Generated<boolean>;
  updated_at: GeneratedTimestamp;
}

export interface AiPersonaReferenceMaterialTable {
  id: Generated<string>;
  persona_id: string;
  content: string;
  /** TEXT[], nullable (NULL/'{}' both mean "unscoped" — see 0010's own comment). Join-table
   *  candidate like every other TEXT[] column above. */
  diagram_families: string[] | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface SchemaMigrationsTable {
  filename: string;
  applied_at: GeneratedTimestamp;
}

export interface DB {
  users: UsersTable;
  projects: ProjectsTable;
  diagram_types: DiagramTypesTable;
  icon_libraries: IconLibrariesTable;
  icons: IconsTable;
  standards: StandardsTable;
  diagrams: DiagramsTable;
  diagram_versions: DiagramVersionsTable;
  templates: TemplatesTable;
  share_grants: ShareGrantsTable;
  local_credentials: LocalCredentialsTable;
  ai_personas: AiPersonasTable;
  diagram_chats: DiagramChatsTable;
  chat_messages: ChatMessagesTable;
  ai_settings: AiSettingsTable;
  ai_persona_reference_material: AiPersonaReferenceMaterialTable;
  schema_migrations: SchemaMigrationsTable;
}
