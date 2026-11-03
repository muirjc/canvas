-- canvas-3dq: SQLite mirror of Postgres 0029_icon_library_admin.sql.
ALTER TABLE icon_libraries ADD COLUMN origin TEXT NOT NULL DEFAULT 'builtin' CHECK (origin IN ('builtin', 'custom'));
ALTER TABLE icon_libraries ADD COLUMN display_name TEXT;
ALTER TABLE icon_libraries ADD COLUMN retired_at TEXT;
ALTER TABLE icons ADD COLUMN retired_at TEXT;
