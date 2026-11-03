-- Diagram soft-delete + restore audit trail (feature 002, User Story 4 + clarifications).
-- See specs/002-editing-lifecycle-enhancements/data-model.md.

ALTER TABLE diagrams
  ADD COLUMN deleted_at TIMESTAMPTZ,
  ADD COLUMN deleted_by_user_id UUID REFERENCES users (id),
  ADD COLUMN restored_at TIMESTAMPTZ,
  ADD COLUMN restored_by_user_id UUID REFERENCES users (id);

-- Every existing read path filters on this; index it so that filter stays cheap at scale.
CREATE INDEX diagrams_deleted_at_idx ON diagrams (deleted_at);
