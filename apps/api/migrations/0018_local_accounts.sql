-- canvas-ez1.2: user management for local accounts. A one-time password (set by an admin when
-- creating a user or resetting a password) must be changed before anything else works. And each
-- session records its user, so a password reset or a deactivation can end that user's sessions.
ALTER TABLE local_credentials ADD COLUMN must_change_password BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE sessions ADD COLUMN user_id TEXT;
CREATE INDEX sessions_user_id_idx ON sessions (user_id);
