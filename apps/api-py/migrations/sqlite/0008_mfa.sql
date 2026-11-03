-- canvas-ez1.5: SQLite mirror of Postgres 0020_mfa.sql.
CREATE TABLE user_mfa (
  user_id TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  secret_encrypted TEXT NOT NULL,
  enabled_at TEXT,
  last_used_step INTEGER
);

CREATE TABLE mfa_recovery_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX mfa_recovery_codes_user_idx ON mfa_recovery_codes (user_id);
