-- canvas-ez1.2: SQLite mirror of Postgres 0018_local_accounts.sql (booleans are INTEGER 0/1).
ALTER TABLE local_credentials ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN user_id TEXT;
CREATE INDEX sessions_user_id_idx ON sessions (user_id);
