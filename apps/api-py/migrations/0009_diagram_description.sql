-- A diagram gains a free-text description field (canvas-hbk): a few lines summarizing what the
-- diagram represents, distinct from Mermaid's inline `%%` comments (which live inside the DSL
-- body, not a diagram-level summary visible without opening the DSL panel).
--
-- Additive only: no column is removed or retyped, and no existing behaviour changes. Nullable,
-- no backfill — there is nothing truthful to put in it for diagrams that predate this column.

ALTER TABLE diagrams ADD COLUMN description TEXT;
