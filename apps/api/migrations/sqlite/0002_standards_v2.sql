-- canvas-tfr: SQLite mirror of Postgres migration 0014_standards_v2.sql (see that file for why).
-- A new file rather than an edit to 0001_init.sql: the runner (db/migrate.ts) applies every file
-- in this directory once, so an already-created SQLite database would never re-run 0001.
-- JSON is TEXT here (db/sqlite-json-plugin.ts parses it on read).
ALTER TABLE standards ADD COLUMN kind_rules TEXT NOT NULL DEFAULT '{}';
ALTER TABLE diagram_types ADD COLUMN origin TEXT NOT NULL DEFAULT 'builtin' CHECK (origin IN ('builtin', 'custom'));
ALTER TABLE diagram_types ADD COLUMN description TEXT;
