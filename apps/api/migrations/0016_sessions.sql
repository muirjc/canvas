-- canvas-4xo: server-side sessions move out of @fastify/session's in-memory default store (lost on
-- every restart, unbounded, single-replica only) into the database. `data` is the session as JSON;
-- `expires_at` is epoch milliseconds, so the same numeric comparison works on Postgres and SQLite.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);
