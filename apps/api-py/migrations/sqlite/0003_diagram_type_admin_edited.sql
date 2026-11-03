-- canvas-chq: SQLite mirror of Postgres 0015_diagram_type_admin_edited.sql (booleans are INTEGER 0/1).
ALTER TABLE diagram_types ADD COLUMN admin_edited INTEGER NOT NULL DEFAULT 0;
