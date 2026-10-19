-- canvas-9ff: an admin can hide any diagram type (built-in or custom). A hidden type is left out of
-- the create pickers; existing diagrams of it keep working. The catalog seed never touches this.
ALTER TABLE diagram_types ADD COLUMN hidden BOOLEAN NOT NULL DEFAULT false;
