-- canvas-zs0 / canvas-4k9: SQLite mirror of Postgres 0022_ai_prices_and_usage_display.sql.
CREATE TABLE ai_model_prices (
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  input_per_million REAL NOT NULL,
  output_per_million REAL NOT NULL,
  cache_read_per_million REAL NOT NULL DEFAULT 0,
  cache_write_per_million REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (provider, model_id)
);

ALTER TABLE ai_settings ADD COLUMN show_usage_to_users INTEGER NOT NULL DEFAULT 1;
ALTER TABLE ai_usage ADD COLUMN chat_message_id TEXT;
CREATE INDEX ai_usage_diagram_idx ON ai_usage (diagram_id);
