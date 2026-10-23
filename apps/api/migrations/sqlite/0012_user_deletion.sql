-- canvas-0se: SQLite mirror of Postgres 0024_user_deletion.sql.
ALTER TABLE users ADD COLUMN deleted_at TEXT;
