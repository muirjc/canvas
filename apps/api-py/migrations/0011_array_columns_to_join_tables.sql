-- canvas-jtm.3: replaces 7 TEXT[] columns with real join tables ahead of dropping them in
-- 0012_drop_array_columns.sql. Native Postgres arrays have no SQLite equivalent, so this is part
-- of making apps/api's database layer engine-agnostic (see
-- /home/jmuir/.claude/plans/we-need-to-make-graceful-ocean.md). Split into two migrations
-- (create+backfill, then drop) deliberately, not combined, so a bad backfill is caught here before
-- the irreversible column drop runs.
--
-- Every table carries a `position` column: a plain TEXT[] column's element order is real content
-- (confirmed by persona-reference-material.test.ts's round-trip assertion on
-- `diagramFamilies: ['uml', 'c4']`, order preserved exactly) — a join table has no natural row
-- order, so this is required, not a defensive extra, and applied uniformly to all 7 rather than
-- special-cased onto just the one table a test happens to cover today. Backfilled via Postgres's
-- `unnest(...) WITH ORDINALITY`, which hands back each array element paired with its 1-based
-- position in one pass; stored 0-based (`- 1`) to match how app code indexes a JS array.
--
-- No `SELECT DISTINCT` here (unlike an earlier draft of this migration): with `position` in the
-- primary key, a genuine duplicate value at two different array positions is representable and
-- preserved, matching a plain TEXT[] column's own lack of a uniqueness constraint — position, not
-- the value, is what make each row unique now.

CREATE TABLE users_personas (
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  persona TEXT NOT NULL,
  position SMALLINT NOT NULL,
  PRIMARY KEY (user_id, position)
);
INSERT INTO users_personas (user_id, persona, position)
SELECT u.id, t.persona, t.position - 1
FROM users u, unnest(u.personas) WITH ORDINALITY AS t (persona, position);

CREATE TABLE diagram_types_personas (
  diagram_type_id TEXT NOT NULL REFERENCES diagram_types (id) ON DELETE CASCADE,
  persona TEXT NOT NULL,
  position SMALLINT NOT NULL,
  PRIMARY KEY (diagram_type_id, position)
);
-- Supports the reverse lookup direction (diagram-type.routes.ts's "list types for persona X") —
-- the only one of these 7 tables actually queried by its non-leading column.
CREATE INDEX diagram_types_personas_persona_idx ON diagram_types_personas (persona);
INSERT INTO diagram_types_personas (diagram_type_id, persona, position)
SELECT dt.id, t.persona, t.position - 1
FROM diagram_types dt, unnest(dt.personas) WITH ORDINALITY AS t (persona, position);

-- No FK to icon_libraries: a palette library id here was never validated against icon_libraries'
-- own (id, version) composite key (library.service.ts's searchIconsForDiagramType reads this list
-- and matches icons.library_id with no version filtering at all) — preserving that existing
-- leniency, not tightening it as a side effect of this migration.
CREATE TABLE diagram_type_palette_libraries (
  diagram_type_id TEXT NOT NULL REFERENCES diagram_types (id) ON DELETE CASCADE,
  library_id TEXT NOT NULL,
  position SMALLINT NOT NULL,
  PRIMARY KEY (diagram_type_id, position)
);
INSERT INTO diagram_type_palette_libraries (diagram_type_id, library_id, position)
SELECT dt.id, t.library_id, t.position - 1
FROM diagram_types dt, unnest(dt.default_palette_library_ids) WITH ORDINALITY AS t (library_id, position);

CREATE TABLE icon_keywords (
  library_id TEXT NOT NULL,
  library_version TEXT NOT NULL,
  icon_id TEXT NOT NULL,
  keyword TEXT NOT NULL,
  position SMALLINT NOT NULL,
  PRIMARY KEY (library_id, library_version, icon_id, position),
  FOREIGN KEY (library_id, library_version, icon_id) REFERENCES icons (library_id, library_version, id)
    ON DELETE CASCADE
);
INSERT INTO icon_keywords (library_id, library_version, icon_id, keyword, position)
SELECT i.library_id, i.library_version, i.id, t.keyword, t.position - 1
FROM icons i, unnest(i.keywords) WITH ORDINALITY AS t (keyword, position);

CREATE TABLE standard_allowed_shapes (
  standard_id UUID NOT NULL REFERENCES standards (id) ON DELETE CASCADE,
  shape_id TEXT NOT NULL,
  position SMALLINT NOT NULL,
  PRIMARY KEY (standard_id, position)
);
INSERT INTO standard_allowed_shapes (standard_id, shape_id, position)
SELECT s.id, t.shape_id, t.position - 1
FROM standards s, unnest(s.allowed_shape_ids) WITH ORDINALITY AS t (shape_id, position);

CREATE TABLE standard_mandatory_shapes (
  standard_id UUID NOT NULL REFERENCES standards (id) ON DELETE CASCADE,
  shape_id TEXT NOT NULL,
  position SMALLINT NOT NULL,
  PRIMARY KEY (standard_id, position)
);
INSERT INTO standard_mandatory_shapes (standard_id, shape_id, position)
SELECT s.id, t.shape_id, t.position - 1
FROM standards s, unnest(s.mandatory_shape_ids) WITH ORDINALITY AS t (shape_id, position);

CREATE TABLE ai_persona_reference_material_families (
  reference_material_id UUID NOT NULL REFERENCES ai_persona_reference_material (id) ON DELETE CASCADE,
  diagram_family TEXT NOT NULL,
  position SMALLINT NOT NULL,
  PRIMARY KEY (reference_material_id, position)
);
INSERT INTO ai_persona_reference_material_families (reference_material_id, diagram_family, position)
SELECT m.id, t.diagram_family, t.position - 1
FROM ai_persona_reference_material m, unnest(m.diagram_families) WITH ORDINALITY AS t (diagram_family, position);
