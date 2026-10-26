-- canvas-3dq: admin management of icon/shape libraries. Built-in libraries (loaded by the catalog
-- seed) can only be retired; custom ones (imported by an admin) are fully editable. Retired
-- libraries/icons leave palettes and search, but diagrams already using them still render.
ALTER TABLE icon_libraries ADD COLUMN origin TEXT NOT NULL DEFAULT 'builtin' CHECK (origin IN ('builtin', 'custom'));
ALTER TABLE icon_libraries ADD COLUMN display_name TEXT;
ALTER TABLE icon_libraries ADD COLUMN retired_at TIMESTAMPTZ;
ALTER TABLE icons ADD COLUMN retired_at TIMESTAMPTZ;
