-- canvas-3fha: SQLite mirror of Postgres 0031_version_restored_from.sql.
ALTER TABLE diagram_versions ADD COLUMN restored_from_version_id TEXT REFERENCES diagram_versions (id) ON DELETE SET NULL;
