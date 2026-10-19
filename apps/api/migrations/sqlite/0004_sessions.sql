-- canvas-4xo: SQLite mirror of Postgres 0016_sessions.sql.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);
