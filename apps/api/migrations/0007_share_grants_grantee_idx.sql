-- Index only, no column, no backfill (feature 008, data-model.md).
--
-- `share_grants_subject_idx (subject_type, subject_id)` (0001_init.sql) supports "who can access
-- THIS diagram/project" (resolveDiagramAccess, resolveProjectAccess) — the subject is known and
-- specific. Feature 008 asks the opposite question, "every diagram granted to THIS user", filtered
-- by grantee_user_id with no subject_id to narrow on, which that index cannot serve. Every other
-- "list mine" query in this codebase has its own supporting index (projects_owner_id_idx,
-- feature 007); this is that same precedent applied here.
CREATE INDEX share_grants_grantee_idx ON share_grants (grantee_user_id, subject_type);
