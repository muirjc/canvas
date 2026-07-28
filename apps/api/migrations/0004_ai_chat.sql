-- AI-assisted diagram chat: personas, per-diagram conversations, and the platform-wide
-- enable/disable toggle (feature 004). See specs/004-ai-diagram-chat/data-model.md.
--
-- ai_personas is intentionally NOT named "personas" — that word already means a simple
-- architect-category tag array on users/diagram_types (see 0001_init.sql), an unrelated,
-- pre-existing concept. research.md §4.

CREATE TABLE ai_personas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('Business', 'Enterprise', 'Solution', 'Technical')),
  system_prompt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One conversation per diagram, for its whole life (FR-008b) — the UNIQUE constraint is what
-- makes this a single shared thread rather than one of several.
CREATE TABLE diagram_chats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  diagram_id UUID NOT NULL UNIQUE REFERENCES diagrams (id),
  persona_id UUID REFERENCES ai_personas (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  diagram_chat_id UUID NOT NULL REFERENCES diagram_chats (id),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  tool_calls JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX chat_messages_diagram_chat_id_created_at_idx ON chat_messages (diagram_chat_id, created_at);

-- Singleton settings row (FR-020) — the `id` CHECK constraint makes a second row impossible.
CREATE TABLE ai_settings (
  id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  chat_enabled BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO ai_settings (id, chat_enabled) VALUES (true, false);
