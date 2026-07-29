-- Standards gain a human-readable identity and a retirement date (feature 006, User Story 4).
-- See specs/006-authoring-admin-console/data-model.md.
--
-- Additive only: no column is removed or retyped, and no validation behaviour changes. Before
-- this, a standard was identifiable solely by its UUID and version number, which made a list of
-- them unreadable.

ALTER TABLE standards ADD COLUMN name TEXT;
ALTER TABLE standards ADD COLUMN description TEXT;
ALTER TABLE standards ADD COLUMN retired_at TIMESTAMPTZ;

-- Backfill existing rows from data already present rather than inventing intent: a name derived
-- from diagram type and version, so no stored standard is ever nameless (FR-026, SC-006).
-- `description` stays null — there is nothing truthful to put in it.
-- `retired_at` stays null even for already-retired rows: that date was never recorded and cannot
-- be recovered, and guessing it would be worse than leaving it absent.
UPDATE standards
SET name = diagram_type_id || ' v' || version
WHERE name IS NULL;
