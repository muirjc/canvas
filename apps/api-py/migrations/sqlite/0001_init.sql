-- canvas-jtm.7: one squashed SQLite migration expressing the full schema as of Postgres migration
-- 0013 (apps/api/migrations/0001..0013_*.sql) — not a replay of those 13 files. SQLite cannot
-- parse several constructs they use (`CREATE EXTENSION`, `gen_random_uuid()`, a `DO $$...END$$`
-- procedural block, `ALTER TABLE ... ADD CONSTRAINT`, `ALTER COLUMN ... DROP DEFAULT`, `unnest()`),
-- and replaying 13 files' worth of incremental ALTERs (several of them data backfills that only
-- make sense against pre-existing rows) buys nothing for a database that starts empty either way.
-- This file is the END STATE those 13 files reach, expressed directly:
--  - ids are TEXT (app-generated via crypto.randomUUID(), per 0013) — no DB-side UUID generation,
--    so no pgcrypto-equivalent extension is needed at all.
--  - every array column (TEXT[] in Postgres) is already a join table (0011/0012) — this file goes
--    straight to that shape, no TEXT[] column is ever declared here.
--  - timestamp columns are TEXT (SQLite has no native TIMESTAMPTZ) with `DEFAULT CURRENT_TIMESTAMP`
--    (ANSI SQL, portable) in place of Postgres's `now()`.
--  - JSON columns are TEXT (SQLite has no native JSONB); app code already calls `JSON.stringify()`
--    before every write on both engines (schema.ts's `JsonColumn<T>` contract), and
--    `db/sqlite-json-plugin.ts` parses them back into real values on read, matching node-postgres's
--    own automatic JSONB deserialization.
--  - boolean columns are INTEGER 0/1 (SQLite has no native boolean type); `db/sql-helpers.ts`'s
--    `dbBoolean()`/`fromDbBoolean()` convert at the handful of call sites that write or return a
--    literal boolean.
--  - every foreign key is declared inline at CREATE TABLE time (SQLite has no
--    `ALTER TABLE ... ADD CONSTRAINT`) — including `diagrams.current_version_id`, a forward
--    reference to `diagram_versions` (created later in this same file): SQLite does not validate
--    that a REFERENCES target exists at CREATE TABLE time, only when a row is actually written and
--    `PRAGMA foreign_keys = ON` is active (db/client.ts sets this per-connection), so the same
--    circular diagrams<->diagram_versions relationship Postgres expresses via a late
--    `ALTER TABLE ADD CONSTRAINT` works here declared upfront instead.
--
-- Posture reminder (see /home/jmuir/.claude/plans/we-need-to-make-graceful-ocean.md): SQLite is a
-- supported target for local dev, evaluation, and small/single-team self-hosted use — not
-- recommended for larger concurrent production deployments (single-writer serialization).

PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'architect', 'viewer')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE users_personas (
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  persona TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (user_id, position)
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parent_project_id TEXT REFERENCES projects (id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users (id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT,
  deleted_by_user_id TEXT REFERENCES users (id),
  restored_at TEXT,
  restored_by_user_id TEXT REFERENCES users (id)
);
CREATE INDEX projects_owner_id_idx ON projects (owner_id);
CREATE INDEX projects_deleted_at_idx ON projects (deleted_at);

CREATE TABLE diagram_types (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  abstraction_level TEXT NOT NULL,
  dsl_family TEXT NOT NULL
);

CREATE TABLE diagram_types_personas (
  diagram_type_id TEXT NOT NULL REFERENCES diagram_types (id) ON DELETE CASCADE,
  persona TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (diagram_type_id, position)
);
CREATE INDEX diagram_types_personas_persona_idx ON diagram_types_personas (persona);

CREATE TABLE diagram_type_palette_libraries (
  diagram_type_id TEXT NOT NULL REFERENCES diagram_types (id) ON DELETE CASCADE,
  library_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (diagram_type_id, position)
);

CREATE TABLE icon_libraries (
  id TEXT NOT NULL,
  version TEXT NOT NULL,
  license TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id, version)
);

CREATE TABLE icons (
  library_id TEXT NOT NULL,
  library_version TEXT NOT NULL,
  id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  category TEXT NOT NULL,
  asset_ref TEXT NOT NULL,
  PRIMARY KEY (library_id, library_version, id),
  FOREIGN KEY (library_id, library_version) REFERENCES icon_libraries (id, version) ON DELETE CASCADE
);

CREATE TABLE icon_keywords (
  library_id TEXT NOT NULL,
  library_version TEXT NOT NULL,
  icon_id TEXT NOT NULL,
  keyword TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (library_id, library_version, icon_id, position),
  FOREIGN KEY (library_id, library_version, icon_id) REFERENCES icons (library_id, library_version, id)
    ON DELETE CASCADE
);

CREATE TABLE standards (
  id TEXT PRIMARY KEY,
  diagram_type_id TEXT NOT NULL REFERENCES diagram_types (id),
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'retired')),
  allowed_icon_library_refs TEXT NOT NULL DEFAULT '[]',
  color_palette TEXT NOT NULL DEFAULT '[]',
  font_constraints TEXT,
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  name TEXT,
  description TEXT,
  retired_at TEXT,
  UNIQUE (diagram_type_id, version)
);
CREATE UNIQUE INDEX standards_one_published_per_type
  ON standards (diagram_type_id)
  WHERE status = 'published';

CREATE TABLE standard_allowed_shapes (
  standard_id TEXT NOT NULL REFERENCES standards (id) ON DELETE CASCADE,
  shape_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (standard_id, position)
);

CREATE TABLE standard_mandatory_shapes (
  standard_id TEXT NOT NULL REFERENCES standards (id) ON DELETE CASCADE,
  shape_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (standard_id, position)
);

CREATE TABLE diagrams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  diagram_type_id TEXT NOT NULL REFERENCES diagram_types (id),
  project_id TEXT NOT NULL REFERENCES projects (id),
  owner_id TEXT NOT NULL REFERENCES users (id),
  current_version_id TEXT REFERENCES diagram_versions (id),
  standard_version_at_last_check INTEGER,
  last_validation_result TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT,
  deleted_by_user_id TEXT REFERENCES users (id),
  restored_at TEXT,
  restored_by_user_id TEXT REFERENCES users (id),
  description TEXT
);
CREATE INDEX diagrams_project_id_idx ON diagrams (project_id);
CREATE INDEX diagrams_name_idx ON diagrams (name);
CREATE INDEX diagrams_deleted_at_idx ON diagrams (deleted_at);

CREATE TABLE diagram_versions (
  id TEXT PRIMARY KEY,
  diagram_id TEXT NOT NULL REFERENCES diagrams (id) ON DELETE CASCADE,
  sequence_number INTEGER NOT NULL,
  dsl_content TEXT NOT NULL,
  author_id TEXT NOT NULL REFERENCES users (id),
  violations_at_save TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (diagram_id, sequence_number)
);

CREATE TABLE templates (
  id TEXT PRIMARY KEY,
  diagram_type_id TEXT NOT NULL REFERENCES diagram_types (id),
  persona TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  seed_dsl_content TEXT NOT NULL
);

CREATE TABLE share_grants (
  id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('diagram', 'project')),
  subject_id TEXT NOT NULL,
  grantee_user_id TEXT NOT NULL REFERENCES users (id),
  access_level TEXT NOT NULL CHECK (access_level IN ('view', 'comment', 'edit')),
  granted_by_user_id TEXT NOT NULL REFERENCES users (id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (subject_type, subject_id, grantee_user_id)
);
CREATE INDEX share_grants_subject_idx ON share_grants (subject_type, subject_id);
CREATE INDEX share_grants_grantee_idx ON share_grants (grantee_user_id, subject_type);

CREATE TABLE local_credentials (
  user_id TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL
);

CREATE TABLE ai_personas (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('Business', 'Enterprise', 'Solution', 'Technical')),
  system_prompt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE diagram_chats (
  id TEXT PRIMARY KEY,
  diagram_id TEXT NOT NULL UNIQUE REFERENCES diagrams (id),
  persona_id TEXT REFERENCES ai_personas (id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE chat_messages (
  id TEXT PRIMARY KEY,
  diagram_chat_id TEXT NOT NULL REFERENCES diagram_chats (id),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  tool_calls TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX chat_messages_diagram_chat_id_created_at_idx ON chat_messages (diagram_chat_id, created_at);

-- Singleton settings row (FR-020) — `CHECK (id = 1)` makes a second row impossible, the SQLite
-- equivalent of Postgres's `BOOLEAN PRIMARY KEY DEFAULT true CHECK (id)`.
CREATE TABLE ai_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  chat_enabled INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO ai_settings (id, chat_enabled) VALUES (1, 0);

CREATE TABLE ai_persona_reference_material (
  id TEXT PRIMARY KEY,
  persona_id TEXT NOT NULL REFERENCES ai_personas (id),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ai_persona_reference_material_persona_id_idx ON ai_persona_reference_material (persona_id);

CREATE TABLE ai_persona_reference_material_families (
  reference_material_id TEXT NOT NULL REFERENCES ai_persona_reference_material (id) ON DELETE CASCADE,
  diagram_family TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (reference_material_id, position)
);
