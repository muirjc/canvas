-- Project soft-delete + restore audit trail (canvas-228.2), mirroring diagrams' own
-- (0003_diagram_soft_delete.sql) exactly.

ALTER TABLE projects
  ADD COLUMN deleted_at TIMESTAMPTZ,
  ADD COLUMN deleted_by_user_id UUID REFERENCES users (id),
  ADD COLUMN restored_at TIMESTAMPTZ,
  ADD COLUMN restored_by_user_id UUID REFERENCES users (id);

-- Every existing read path filters on this; index it so that filter stays cheap at scale.
CREATE INDEX projects_deleted_at_idx ON projects (deleted_at);
