-- canvas-tfr: Standards v2 (element kinds) + admin-defined diagram types.
--
-- standards.kind_rules holds the v2 rule fields (elementKinds, connectorRules, connectorPolicy,
-- containers, requireKnownKinds, severityOverrides, guidance) as one JSON document: they are
-- always read and written as a whole and never queried into, unlike the v1 shape lists (which
-- stay in their join tables, checked on the save hot path). '{}' = no v2 rules, so every existing
-- standard keeps behaving exactly as before.
--
-- diagram_types.origin separates the seeded built-in catalog from admin-created types, so the
-- idempotent catalog seed (seed/diagram-types.seed.ts) can never overwrite an admin's type.
ALTER TABLE standards ADD COLUMN kind_rules JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE diagram_types ADD COLUMN origin TEXT NOT NULL DEFAULT 'builtin' CHECK (origin IN ('builtin', 'custom'));
ALTER TABLE diagram_types ADD COLUMN description TEXT;
