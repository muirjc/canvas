-- canvas-tj1: SQLite mirror of Postgres 0028_ai_model_choice.sql.
ALTER TABLE ai_settings ADD COLUMN model_id TEXT;
