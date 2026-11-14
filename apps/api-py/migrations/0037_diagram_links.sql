-- canvas-8uh1.2: the index of drill-down links between diagrams, copied out of each diagram's own text (front
-- matter canvas.links) whenever it is written, so "which diagrams link to this one" needs no scan. The target is
-- text, not a foreign key: a link to a purged diagram is still found and shown as broken. kind is 'link' now;
-- embedded frames (canvas-8uh1.6) will add 'frame'.
CREATE TABLE diagram_links (
  source_diagram_id UUID NOT NULL REFERENCES diagrams (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('link', 'frame')),
  element_id TEXT NOT NULL,
  target_diagram_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (source_diagram_id, kind, element_id)
);
CREATE INDEX diagram_links_target_idx ON diagram_links (target_diagram_id);
