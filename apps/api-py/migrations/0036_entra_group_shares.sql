-- canvas-2h2w.3: share a project or diagram with an Entra group (one assigned to the Canvas app).
-- entra_groups: the groups picked so far, with the name Graph gave (refreshed whenever one is picked).
-- user_group_memberships: the groups each person was in at their last Entra sign-in (the ID token's
-- `groups` claim), so access checks read membership from the database like everything else.
-- share_grants: a grant goes to a person OR a group, never both.
CREATE TABLE entra_groups (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE user_group_memberships (
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  group_id TEXT NOT NULL,
  PRIMARY KEY (user_id, group_id)
);
CREATE INDEX user_group_memberships_group_idx ON user_group_memberships (group_id);
ALTER TABLE share_grants ALTER COLUMN grantee_user_id DROP NOT NULL;
ALTER TABLE share_grants ADD COLUMN grantee_group_id TEXT REFERENCES entra_groups (id);
ALTER TABLE share_grants ADD CONSTRAINT share_grants_one_grantee
  CHECK ((grantee_user_id IS NULL) <> (grantee_group_id IS NULL));
CREATE UNIQUE INDEX share_grants_group_unique ON share_grants (subject_type, subject_id, grantee_group_id)
  WHERE grantee_group_id IS NOT NULL;
CREATE INDEX share_grants_group_idx ON share_grants (grantee_group_id, subject_type);
