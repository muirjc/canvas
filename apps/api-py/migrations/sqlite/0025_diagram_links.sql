-- canvas-8uh1.2: SQLite mirror of Postgres 0037_diagram_links.sql.
CREATE TABLE diagram_links (
  source_diagram_id TEXT NOT NULL REFERENCES diagrams (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('link', 'frame')),
  element_id TEXT NOT NULL,
  target_diagram_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (source_diagram_id, kind, element_id)
);
CREATE INDEX diagram_links_target_idx ON diagram_links (target_diagram_id);
