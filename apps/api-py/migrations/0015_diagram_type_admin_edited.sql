-- canvas-chq: built-in diagram types become admin-editable (name, description, personas, palette
-- libraries; never the DSL family). admin_edited marks a built-in row an admin has changed so the
-- idempotent catalog seed (seed/diagram-types.seed.ts) stops overwriting it; unedited built-in rows
-- keep receiving catalog updates exactly as before.
ALTER TABLE diagram_types ADD COLUMN admin_edited BOOLEAN NOT NULL DEFAULT false;
