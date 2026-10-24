-- canvas-bw4: SQLite mirror of Postgres 0025_diagram_comments.sql.
CREATE TABLE diagram_comments (
  id TEXT PRIMARY KEY,
  diagram_id TEXT NOT NULL REFERENCES diagrams (id) ON DELETE CASCADE,
  thread_root_id TEXT REFERENCES diagram_comments (id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users (id),
  body TEXT NOT NULL,
  anchor_type TEXT,
  anchor_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  edited_at TEXT,
  deleted_at TEXT,
  resolved_at TEXT,
  resolved_by_user_id TEXT REFERENCES users (id)
);
CREATE INDEX diagram_comments_diagram_idx ON diagram_comments (diagram_id, created_at);
CREATE INDEX diagram_comments_thread_idx ON diagram_comments (thread_root_id);

CREATE TABLE diagram_comment_reads (
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  diagram_id TEXT NOT NULL REFERENCES diagrams (id) ON DELETE CASCADE,
  last_read_at TEXT NOT NULL,
  PRIMARY KEY (user_id, diagram_id)
);
