-- canvas-obp0: SQLite mirror of Postgres 0032_diagram_edit_sessions.sql.
CREATE TABLE diagram_edit_sessions (
  diagram_id TEXT NOT NULL REFERENCES diagrams (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (diagram_id, user_id, session_id)
);
CREATE INDEX diagram_edit_sessions_seen_idx ON diagram_edit_sessions (diagram_id, last_seen_at);
