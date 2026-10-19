-- canvas-9ff: SQLite mirror of Postgres 0017_diagram_type_hidden.sql (booleans are INTEGER 0/1).
ALTER TABLE diagram_types ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
