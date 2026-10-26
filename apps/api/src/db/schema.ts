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
 * every `DEFAULT now()`/`DEFAULT <literal>` column. `id` columns are NOT `Generated` (as of
 * canvas-jtm.10, 0013_app_generated_uuids.sql): every table's primary key used to default to
 * `gen_random_uuid()`, dropped once every apps/api/src call site was off `db/pool.ts`
 * (canvas-jtm.6) and could be updated in one pass to supply `crypto.randomUUID()` explicitly —
 * removing `pgcrypto` as a database-level dependency this schema no longer needs.
 *
 * Timestamp columns are typed `Timestamp` (see below), matching node-postgres's actual runtime
 * behavior (a native `Date`) rather than perpetuating the `created_at: string` convention some
 * existing hand-written service-layer interfaces use (that convention is harmless today only
 * because Fastify's `reply.send()` JSON-serializes a `Date` to an ISO string on the way out — it
 * is not what callers hold in hand before that point, and this schema should not encode a
 * different runtime reality than the one node-postgres actually produces).
 *
 * The 7 `TEXT[]` array columns this schema used to carry (`users.personas`,
 * `diagram_types.personas`/`default_palette_library_ids`, `icons.keywords`,
 * `standards.allowed_shape_ids`/`mandatory_shape_ids`,
 * `ai_persona_reference_material.diagram_families`) are gone as of canvas-jtm.3
 * (0011_array_columns_to_join_tables.sql / 0012_drop_array_columns.sql) — native arrays have no
 * SQLite equivalent. Each is now a real join table (`users_personas`, `diagram_types_personas`,
 * `diagram_type_palette_libraries`, `icon_keywords`, `standard_allowed_shapes`,
 * `standard_mandatory_shapes`, `ai_persona_reference_material_families`), keyed by the owning
 * row's id plus the value, with no synthetic surrogate id of its own.
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
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'architect' | 'viewer';
  active: Generated<boolean>;
  created_at: GeneratedTimestamp;
  /** canvas-0se: deleted by an admin -- an anonymised placeholder kept for history. */
  deleted_at: Timestamp | null;
}

/** Join table replacing `users.personas TEXT[]` (canvas-jtm.3). No surrogate id — the composite
 *  (user_id, persona) pair is the whole row. */
export interface UsersPersonasTable {
  user_id: string;
  persona: string;
  position: number;
}

export interface ProjectsTable {
  id: string;
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
  abstraction_level: string;
  dsl_family: string;
  /** canvas-tfr: 'builtin' (seeded catalog) or 'custom' (admin-created); the seed never touches custom rows. */
  origin: Generated<'builtin' | 'custom'>;
  /** canvas-chq: a built-in row an admin has edited -- the catalog seed leaves it alone. */
  admin_edited: Generated<boolean>;
  /** canvas-9ff: hidden from the create pickers; existing diagrams unaffected. */
  hidden: Generated<boolean>;
  description: string | null;
}

/** Join table replacing `diagram_types.personas TEXT[]` (canvas-jtm.3). No surrogate id — the
 *  composite (diagram_type_id, persona) pair is the whole row. */
export interface DiagramTypesPersonasTable {
  diagram_type_id: string;
  persona: string;
  position: number;
}

/** Join table replacing `diagram_types.default_palette_library_ids TEXT[]` (canvas-jtm.3). No FK
 *  to icon_libraries — see the migration's own comment: this was never validated against a real
 *  library version before, and this redesign preserves that leniency rather than tightening it. */
export interface DiagramTypePaletteLibrariesTable {
  diagram_type_id: string;
  library_id: string;
  position: number;
}

export interface IconLibrariesTable {
  id: string;
  version: string;
  license: string | null;
  created_at: GeneratedTimestamp;
  /** canvas-3dq: 'builtin' (catalog seed; retire only) or 'custom' (admin-imported; editable). */
  origin: Generated<'builtin' | 'custom'>;
  display_name: string | null;
  retired_at: Timestamp | null;
}

export interface IconsTable {
  library_id: string;
  library_version: string;
  id: string;
  display_name: string;
  category: string;
  asset_ref: string;
  /** canvas-3dq: hidden from palettes/search; still resolves for diagrams that use it. */
  retired_at: Timestamp | null;
}

/** Join table replacing `icons.keywords TEXT[]` (canvas-jtm.3) — the one array column that was
 *  actually used for in-app search filtering (`@canvas/diagram-core`'s `searchIcons()`), not just
 *  stored. No surrogate id — the composite key is the whole row. */
export interface IconKeywordsTable {
  library_id: string;
  library_version: string;
  icon_id: string;
  keyword: string;
  position: number;
}

export interface StandardsTable {
  id: string;
  diagram_type_id: string;
  version: number;
  status: 'draft' | 'published' | 'retired';
  allowed_icon_library_refs: GeneratedJsonColumn<unknown>;
  color_palette: GeneratedJsonColumn<unknown>;
  font_constraints: JsonColumn<unknown> | null;
  published_at: Timestamp | null;
  created_at: GeneratedTimestamp;
  name: string | null;
  description: string | null;
  retired_at: Timestamp | null;
  /** canvas-tfr: v2 rule fields (elementKinds, connectorRules, ...) as one JSON document; '{}' = none. */
  kind_rules: GeneratedJsonColumn<unknown>;
}

/** Join table replacing `standards.allowed_shape_ids TEXT[]` (canvas-jtm.3) — checked on every
 *  diagram save (a hot path), one reason array redesign chose a real join table over JSON-TEXT
 *  here. No surrogate id — the composite key is the whole row. */
export interface StandardAllowedShapesTable {
  standard_id: string;
  shape_id: string;
  position: number;
}

/** Join table replacing `standards.mandatory_shape_ids TEXT[]` (canvas-jtm.3). */
export interface StandardMandatoryShapesTable {
  standard_id: string;
  shape_id: string;
  position: number;
}

export interface DiagramsTable {
  id: string;
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
  id: string;
  diagram_id: string;
  sequence_number: number;
  dsl_content: string;
  author_id: string;
  violations_at_save: GeneratedJsonColumn<unknown>;
  created_at: GeneratedTimestamp;
}

export interface TemplatesTable {
  id: string;
  diagram_type_id: string;
  persona: string;
  name: string;
  description: string | null;
  seed_dsl_content: string;
}

export interface ShareGrantsTable {
  id: string;
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
  /** canvas-ez1.2: set by an admin-issued one-time password; cleared when the user changes it. */
  must_change_password: Generated<boolean>;
  /** canvas-ez1.4: consecutive failed sign-ins; the third locks the account (locked_at). */
  failed_attempts: Generated<number>;
  locked_at: Timestamp | null;
}

/** canvas-3s5.1: a project linked to a GitHub repository + folder (github/github-link.service.ts). */
export interface GithubLinksTable {
  id: string;
  project_id: string;
  /** BIGINT: node-postgres returns these as strings. */
  repo_id: ColumnType<number | string, number, number>;
  repo_owner: string;
  repo_name: string;
  installation_id: ColumnType<number | string, number, number>;
  base_branch: string;
  folder: string;
  created_by_user_id: string | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
  last_checked_at: Timestamp | null;
  last_check_error: string | null;
}

/** canvas-3s5.1: one pull request Canvas opened for a diagram (github/submission.service.ts). */
export interface DiagramSubmissionsTable {
  id: string;
  diagram_id: string;
  github_link_id: string | null;
  repo_id: ColumnType<number | string, number, number>;
  repo_owner: string;
  repo_name: string;
  installation_id: ColumnType<number | string, number, number>;
  base_branch: string;
  path: string;
  branch: string;
  pr_number: number | null;
  pr_url: string | null;
  state: 'open' | 'merged' | 'closed';
  submitted_version_sequence: number | null;
  submitted_fingerprint: string | null;
  last_pushed_commit_sha: string | null;
  head_sha: string | null;
  submitted_by_user_id: string | null;
  first_submitted_at: Timestamp;
  last_submitted_at: Timestamp;
  submitting_since: Timestamp | null;
  review_state: Generated<string>;
  checks_state: Generated<string>;
  /** JSON text (check runs, reviewers). */
  status_detail: string | null;
  last_synced_at: Timestamp | null;
  last_sync_error: string | null;
  merged_at: Timestamp | null;
  merged_by_login: string | null;
  merge_commit_sha: string | null;
  merged_head_matches: boolean | null;
  closed_at: Timestamp | null;
  /** canvas-3s5.2: withdrawn from Canvas (vs rejected on GitHub). */
  withdrawn_at: Timestamp | null;
  withdrawn_by_user_id: string | null;
}

export interface DiagramSubmissionPushesTable {
  id: string;
  submission_id: string;
  version_sequence: number;
  commit_sha: string;
  pushed_by_user_id: string | null;
  pushed_at: Timestamp;
  warning_count: Generated<number>;
}

/** canvas-bw4: diagram comments (comments/comment.service.ts). */
export interface DiagramCommentsTable {
  id: string;
  diagram_id: string;
  thread_root_id: string | null;
  author_id: string;
  body: string;
  anchor_type: 'node' | 'edge' | null;
  anchor_id: string | null;
  created_at: GeneratedTimestamp;
  edited_at: Timestamp | null;
  deleted_at: Timestamp | null;
  resolved_at: Timestamp | null;
  resolved_by_user_id: string | null;
}

export interface DiagramCommentReadsTable {
  user_id: string;
  diagram_id: string;
  last_read_at: Timestamp;
}

/** canvas-9af: AI token usage, one row per chat turn (ai/ai-usage.service.ts). */
export interface AiUsageTable {
  id: string;
  occurred_at: GeneratedTimestamp;
  user_id: string | null;
  diagram_id: string | null;
  provider: string;
  model_id: string;
  mode: string;
  steps: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: Generated<number>;
  cache_write_tokens: Generated<number>;
  succeeded: boolean;
  /** canvas-4k9: the assistant reply this turn produced (null for a failed turn). */
  chat_message_id: string | null;
}

/** canvas-ez1.5: two-step verification (auth/mfa.service.ts). */
export interface UserMfaTable {
  user_id: string;
  secret_encrypted: string;
  enabled_at: Timestamp | null;
  /** BIGINT: node-postgres returns it as a string. */
  last_used_step: ColumnType<number | string | null, number | null | undefined, number | null>;
}

export interface MfaRecoveryCodesTable {
  id: string;
  user_id: string;
  code_hash: string;
  used_at: Timestamp | null;
}

/** canvas-ez1.4: the audit log (audit/audit.service.ts). `detail` is JSON text. */
export interface AuditEventsTable {
  id: string;
  occurred_at: GeneratedTimestamp;
  event: string;
  actor_user_id: string | null;
  target_user_id: string | null;
  ip: string | null;
  detail: string | null;
}

export interface AiPersonasTable {
  id: string;
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
  id: string;
  diagram_id: string;
  persona_id: string | null;
  created_at: GeneratedTimestamp;
}

export interface ChatMessagesTable {
  id: string;
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
  /** canvas-4k9: token counts in the chat panel for non-admins (admins always see them). */
  show_usage_to_users: Generated<boolean>;
  /** canvas-tj1: the admin's chosen model; null = AI_MODEL / the provider's built-in default. */
  model_id: string | null;
  updated_at: GeneratedTimestamp;
}

/** canvas-zs0: price per million tokens, per provider + model (ai/ai-prices.service.ts). */
export interface AiModelPricesTable {
  provider: string;
  model_id: string;
  input_per_million: number;
  output_per_million: number;
  cache_read_per_million: Generated<number>;
  cache_write_per_million: Generated<number>;
  updated_at: GeneratedTimestamp;
}

export interface AiPersonaReferenceMaterialTable {
  id: string;
  persona_id: string;
  content: string;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

/** Join table replacing `ai_persona_reference_material.diagram_families TEXT[]` (canvas-jtm.3).
 *  No row at all (not a NULL marker, not an empty-set marker) means "unscoped" — the absence
 *  itself now carries the meaning NULL/'{}' used to (see 0010's own comment on the old column),
 *  so persona-reference-material.service.ts's `toStoredFamilies`'s empty-array-to-NULL collapsing
 *  is replaced by simply not inserting any rows. */
export interface AiPersonaReferenceMaterialFamiliesTable {
  reference_material_id: string;
  diagram_family: string;
  position: number;
}

export interface SchemaMigrationsTable {
  filename: string;
  applied_at: GeneratedTimestamp;
}

/** canvas-4xo: server-side sessions (auth/session-store.ts). `expires_at` is epoch milliseconds;
 *  node-postgres returns BIGINT as a string, SQLite as a number -- only compared in SQL, never read. */
export interface SessionsTable {
  id: string;
  data: string;
  expires_at: ColumnType<number | string, number, number>;
  /** canvas-ez1.2: the signed-in user, so their sessions can be ended (null before sign-in). */
  user_id: string | null;
  /** canvas-bj7: ended (sign-out, admin action). Never written over; reads as no session. */
  revoked: Generated<boolean>;
}

export interface DB {
  sessions: SessionsTable;
  audit_events: AuditEventsTable;
  user_mfa: UserMfaTable;
  ai_usage: AiUsageTable;
  diagram_comments: DiagramCommentsTable;
  github_links: GithubLinksTable;
  diagram_submissions: DiagramSubmissionsTable;
  diagram_submission_pushes: DiagramSubmissionPushesTable;
  diagram_comment_reads: DiagramCommentReadsTable;
  ai_model_prices: AiModelPricesTable;
  mfa_recovery_codes: MfaRecoveryCodesTable;
  users: UsersTable;
  users_personas: UsersPersonasTable;
  projects: ProjectsTable;
  diagram_types: DiagramTypesTable;
  diagram_types_personas: DiagramTypesPersonasTable;
  diagram_type_palette_libraries: DiagramTypePaletteLibrariesTable;
  icon_libraries: IconLibrariesTable;
  icons: IconsTable;
  icon_keywords: IconKeywordsTable;
  standards: StandardsTable;
  standard_allowed_shapes: StandardAllowedShapesTable;
  standard_mandatory_shapes: StandardMandatoryShapesTable;
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
  ai_persona_reference_material_families: AiPersonaReferenceMaterialFamiliesTable;
  schema_migrations: SchemaMigrationsTable;
}
