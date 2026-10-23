-- canvas-bj7: SQLite mirror of Postgres 0023_session_revocation.sql.
ALTER TABLE sessions ADD COLUMN revoked INTEGER NOT NULL DEFAULT 0;
