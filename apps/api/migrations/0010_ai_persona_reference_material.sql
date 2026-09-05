-- Persona-scoped reference material (010-ai-diagram-knowledge, User Story 4): zero or more
-- admin-authored reference-material entries per persona, each optionally scoped to one or more
-- diagram-type families. See specs/010-ai-diagram-knowledge/data-model.md.
--
-- No status/lifecycle column, unlike ai_personas' active/archived -- an entry is either present
-- or removed (FR-009), no intermediate state.

CREATE TABLE ai_persona_reference_material (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id UUID NOT NULL REFERENCES ai_personas (id),
  content TEXT NOT NULL,
  -- NULL or '{}' means the entry is unscoped (applies regardless of diagram type). Otherwise one
  -- or more of registry.ts's dslFamily ids -- validated at the service layer, not here, mirroring
  -- ai_personas.category's own "validate before insert, don't rely on a DB constraint" precedent
  -- (a CHECK here would need updating every time a new DSL family is registered).
  diagram_families TEXT[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ai_persona_reference_material_persona_id_idx ON ai_persona_reference_material (persona_id);
