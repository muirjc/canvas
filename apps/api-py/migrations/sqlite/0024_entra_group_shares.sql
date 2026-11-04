-- canvas-2h2w.3: SQLite mirror of Postgres 0036_entra_group_shares.sql. share_grants is rebuilt
-- (SQLite can't drop NOT NULL or add a CHECK in place; nothing references share_grants).
CREATE TABLE entra_groups (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE user_group_memberships (
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  group_id TEXT NOT NULL,
  PRIMARY KEY (user_id, group_id)
);
CREATE INDEX user_group_memberships_group_idx ON user_group_memberships (group_id);
CREATE TABLE share_grants_new (
  id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('diagram', 'project')),
  subject_id TEXT NOT NULL,
  grantee_user_id TEXT REFERENCES users (id),
  grantee_group_id TEXT REFERENCES entra_groups (id),
  access_level TEXT NOT NULL CHECK (access_level IN ('view', 'comment', 'edit', 'manage')),
  granted_by_user_id TEXT NOT NULL REFERENCES users (id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (subject_type, subject_id, grantee_user_id),
  CHECK ((grantee_user_id IS NULL) <> (grantee_group_id IS NULL))
);
INSERT INTO share_grants_new (id, subject_type, subject_id, grantee_user_id, access_level, granted_by_user_id, created_at)
  SELECT id, subject_type, subject_id, grantee_user_id, access_level, granted_by_user_id, created_at FROM share_grants;
DROP TABLE share_grants;
ALTER TABLE share_grants_new RENAME TO share_grants;
CREATE INDEX share_grants_subject_idx ON share_grants (subject_type, subject_id);
CREATE INDEX share_grants_grantee_idx ON share_grants (grantee_user_id, subject_type);
CREATE UNIQUE INDEX share_grants_group_unique ON share_grants (subject_type, subject_id, grantee_group_id)
  WHERE grantee_group_id IS NOT NULL;
CREATE INDEX share_grants_group_idx ON share_grants (grantee_group_id, subject_type);
