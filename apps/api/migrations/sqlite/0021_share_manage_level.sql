-- canvas-2h2w.1: SQLite mirror of Postgres 0033_share_manage_level.sql. SQLite can't change a
-- CHECK constraint in place, so the table is rebuilt (nothing references share_grants).
CREATE TABLE share_grants_new (
  id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('diagram', 'project')),
  subject_id TEXT NOT NULL,
  grantee_user_id TEXT NOT NULL REFERENCES users (id),
  access_level TEXT NOT NULL CHECK (access_level IN ('view', 'comment', 'edit', 'manage')),
  granted_by_user_id TEXT NOT NULL REFERENCES users (id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (subject_type, subject_id, grantee_user_id)
);
INSERT INTO share_grants_new (id, subject_type, subject_id, grantee_user_id, access_level, granted_by_user_id, created_at)
  SELECT id, subject_type, subject_id, grantee_user_id, access_level, granted_by_user_id, created_at FROM share_grants;
DROP TABLE share_grants;
ALTER TABLE share_grants_new RENAME TO share_grants;
CREATE INDEX share_grants_subject_idx ON share_grants (subject_type, subject_id);
CREATE INDEX share_grants_grantee_idx ON share_grants (grantee_user_id, subject_type);
