-- canvas-ez1.4: SQLite mirror of Postgres 0019_lockout_and_audit.sql.
ALTER TABLE local_credentials ADD COLUMN failed_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE local_credentials ADD COLUMN locked_at TEXT;

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  event TEXT NOT NULL,
  actor_user_id TEXT,
  target_user_id TEXT,
  ip TEXT,
  detail TEXT
);
CREATE INDEX audit_events_occurred_at_idx ON audit_events (occurred_at);
