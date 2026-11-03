-- canvas-zs0: per-model prices (per million tokens) for an estimated cost on Admin > AI usage.
-- No rows by default: prices change and differ per provider, so an admin enters them.
CREATE TABLE ai_model_prices (
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  input_per_million DOUBLE PRECISION NOT NULL,
  output_per_million DOUBLE PRECISION NOT NULL,
  cache_read_per_million DOUBLE PRECISION NOT NULL DEFAULT 0,
  cache_write_per_million DOUBLE PRECISION NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (provider, model_id)
);

-- canvas-4k9: token counts in the chat panel -- shown to everyone unless an admin turns it off
-- (admins always see them). Each usage row links to the assistant reply it produced.
ALTER TABLE ai_settings ADD COLUMN show_usage_to_users BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE ai_usage ADD COLUMN chat_message_id UUID;
CREATE INDEX ai_usage_diagram_idx ON ai_usage (diagram_id);
