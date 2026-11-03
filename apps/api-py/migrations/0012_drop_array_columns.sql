-- canvas-jtm.3: drops the 7 TEXT[] columns backfilled into join tables by
-- 0011_array_columns_to_join_tables.sql. Kept as its own migration (not combined with the
-- backfill) so a bad backfill is caught before this irreversible step runs — see that file's own
-- header comment. Every application call site was converted to read/write the new join tables in
-- the same change that ships this migration, not left pointing at columns this drops.

ALTER TABLE users DROP COLUMN personas;
ALTER TABLE diagram_types DROP COLUMN personas;
ALTER TABLE diagram_types DROP COLUMN default_palette_library_ids;
ALTER TABLE icons DROP COLUMN keywords;
ALTER TABLE standards DROP COLUMN allowed_shape_ids;
ALTER TABLE standards DROP COLUMN mandatory_shape_ids;
ALTER TABLE ai_persona_reference_material DROP COLUMN diagram_families;
