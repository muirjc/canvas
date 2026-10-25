-- canvas-tj1: the AI model an admin chose from the provider's list. NULL = the default
-- (AI_MODEL if set, else the built-in default for the provider).
ALTER TABLE ai_settings ADD COLUMN model_id TEXT;
