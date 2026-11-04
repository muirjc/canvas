-- canvas-2h2w.4: SQLite mirror of Postgres 0035_notifications.sql.
CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('added', 'level_changed', 'removed', 'ownership')),
  actor_user_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('project', 'diagram')),
  subject_id TEXT NOT NULL,
  subject_name TEXT NOT NULL,
  access_level TEXT,
  previous_level TEXT,
  created_at TEXT NOT NULL,
  read_at TEXT
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at);
