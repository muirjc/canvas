-- canvas-8em: SQLite mirror of Postgres 0030_app_settings.sql.
CREATE TABLE app_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  sharing_enabled INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO app_settings (id, sharing_enabled) VALUES (1, 0);
