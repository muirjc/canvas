-- canvas-jtm.10: ids become app-generated (crypto.randomUUID(), always passed explicitly on
-- INSERT) instead of DB-generated. Deliberately sequenced after canvas-jtm.6 (every apps/api/src
-- file off db/pool.ts) — dropping this default any earlier would have silently broken every
-- not-yet-converted raw-SQL INSERT, which omitted `id` and relied on this default implicitly.
--
-- Only drops the DEFAULT clause, not the column or its UUID type/PRIMARY KEY — every row that
-- already has an id keeps it unchanged; this only affects what happens on a *future* INSERT that
-- omits the column (which, after this migration, is "NOT NULL constraint violation" instead of
-- "silently filled in" — exactly the point, since the app now always supplies it explicitly).
ALTER TABLE users ALTER COLUMN id DROP DEFAULT;
ALTER TABLE projects ALTER COLUMN id DROP DEFAULT;
ALTER TABLE standards ALTER COLUMN id DROP DEFAULT;
ALTER TABLE diagrams ALTER COLUMN id DROP DEFAULT;
ALTER TABLE diagram_versions ALTER COLUMN id DROP DEFAULT;
ALTER TABLE templates ALTER COLUMN id DROP DEFAULT;
ALTER TABLE share_grants ALTER COLUMN id DROP DEFAULT;
ALTER TABLE ai_personas ALTER COLUMN id DROP DEFAULT;
ALTER TABLE diagram_chats ALTER COLUMN id DROP DEFAULT;
ALTER TABLE chat_messages ALTER COLUMN id DROP DEFAULT;
ALTER TABLE ai_persona_reference_material ALTER COLUMN id DROP DEFAULT;

-- No longer used by any column default now that every one of the above is dropped.
DROP EXTENSION IF EXISTS pgcrypto;
