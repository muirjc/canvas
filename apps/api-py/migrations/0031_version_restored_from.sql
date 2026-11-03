-- canvas-3fha: a restored version records which version it came from, so History can show
-- "v7 · Restored from v1". Restoring never rewrites history (FR-017); this only labels the new row.
ALTER TABLE diagram_versions ADD COLUMN restored_from_version_id UUID REFERENCES diagram_versions (id) ON DELETE SET NULL;
