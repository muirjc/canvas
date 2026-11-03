-- Projects gain an owner (feature 007, User Story 3).
-- See specs/007-project-context/data-model.md.
--
-- Why this exists: choosing a project requires knowing which projects are available to you, and
-- "available to me" was not expressible — `projects` had no owner and no membership. That absence
-- is also why "just fall back to the user's project" was rejected as a shortcut fix for the
-- reported defect (docs/project-context-brief.md §3).
--
-- Additive only. Mirrors `diagrams.owner_id` exactly, including NOT NULL.

-- Added nullable first: NOT NULL cannot be applied to a populated table before the backfill runs.
ALTER TABLE projects ADD COLUMN owner_id UUID REFERENCES users (id);

-- Backfill step 1 — infer from data already present rather than inventing intent: if every
-- diagram in a project has the same owner, that person is the project's owner. Soft-deleted
-- diagrams are deliberately included; they still evidence who filled the project, and excluding
-- them would push a project whose diagrams were all deleted onto the fallback below for no
-- reason.
UPDATE projects p
SET owner_id = sub.owner_id
FROM (
  SELECT project_id, MIN(owner_id::text)::uuid AS owner_id
  FROM diagrams
  GROUP BY project_id
  HAVING COUNT(DISTINCT owner_id) = 1
) sub
WHERE p.id = sub.project_id
  AND p.owner_id IS NULL;

-- Backfill step 2 — the fallback, and it is not a formality. A project with mixed diagram owners
-- has no unanimous answer, and an EMPTY project has nothing to infer from at all. The seeded
-- project may be empty, so a migration implementing only step 1 fails on exactly the data this
-- repository ships with.
--
-- Failing loudly beats leaving NULL: once visibility follows ownership, an ownerless project is
-- invisible to everyone, which is the precise failure FR-013b exists to prevent. The runner wraps
-- each migration in a transaction, so this exception rolls the whole file back.
DO $$
DECLARE
  fallback_owner UUID;
BEGIN
  IF EXISTS (SELECT 1 FROM projects WHERE owner_id IS NULL) THEN
    SELECT id INTO fallback_owner
    FROM users
    WHERE role = 'admin'
    ORDER BY created_at, id
    LIMIT 1;

    IF fallback_owner IS NULL THEN
      RAISE EXCEPTION
        'Cannot backfill projects.owner_id: % project(s) have no unanimous diagram owner and no admin user exists to fall back to. Create an admin user, then re-run this migration.',
        (SELECT count(*) FROM projects WHERE owner_id IS NULL);
    END IF;

    UPDATE projects SET owner_id = fallback_owner WHERE owner_id IS NULL;
  END IF;
END $$;

ALTER TABLE projects ALTER COLUMN owner_id SET NOT NULL;

-- The project list filters on this on every page load; `diagrams_project_id_idx` sets the
-- precedent for indexing the column an access check reads.
CREATE INDEX projects_owner_id_idx ON projects (owner_id);
