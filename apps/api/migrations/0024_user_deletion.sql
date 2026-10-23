-- canvas-0se: an admin can delete a user. The row stays as an anonymised placeholder ("Deleted
-- user", a unique placeholder email, inactive) so the history that points at it -- diagram
-- versions they wrote, shares they gave, who deleted/restored what, the audit log and AI usage --
-- stays intact; their projects/diagrams are transferred and their credentials removed.
ALTER TABLE users ADD COLUMN deleted_at TIMESTAMPTZ;
