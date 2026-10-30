-- canvas-j6v: SQLite mirror of Postgres 0034_diagram_draft.sql (booleans are INTEGER 0/1).
ALTER TABLE diagrams ADD COLUMN draft INTEGER NOT NULL DEFAULT 0;
