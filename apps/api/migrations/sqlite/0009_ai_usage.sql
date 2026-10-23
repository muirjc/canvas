-- canvas-9af: SQLite mirror of Postgres 0021_ai_usage.sql.
CREATE TABLE ai_usage (
  id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  user_id TEXT,
  diagram_id TEXT,
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  steps INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  succeeded INTEGER NOT NULL
);
CREATE INDEX ai_usage_occurred_at_idx ON ai_usage (occurred_at);
CREATE INDEX ai_usage_user_occurred_at_idx ON ai_usage (user_id, occurred_at);
