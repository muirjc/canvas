-- canvas-2h2w.1: a fourth share level, Manage (Edit + add/remove members). Only project grants
-- use it; the API keeps diagram-level shares to View/Comment/Edit.
ALTER TABLE share_grants DROP CONSTRAINT share_grants_access_level_check;
ALTER TABLE share_grants ADD CONSTRAINT share_grants_access_level_check
  CHECK (access_level IN ('view', 'comment', 'edit', 'manage'));
