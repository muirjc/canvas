-- canvas-9af: AI token usage per user. One row per chat turn (a turn can be several model calls
-- when the model uses tools; the tokens are summed across them). Failed turns are recorded too --
-- their tokens were still spent.
CREATE TABLE ai_usage (
  id TEXT PRIMARY KEY,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  user_id UUID,
  diagram_id UUID,
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  steps INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  succeeded BOOLEAN NOT NULL
);
CREATE INDEX ai_usage_occurred_at_idx ON ai_usage (occurred_at);
CREATE INDEX ai_usage_user_occurred_at_idx ON ai_usage (user_id, occurred_at);
