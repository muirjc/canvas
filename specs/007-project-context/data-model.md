# Phase 1 Data Model: Project Context

Only one persisted structure changes. The rest of this document is about the rules that hang off
it — several of which are decisions the spec left open and that implementation must not improvise.

---

## Changed entity: Project

`projects` today (`0001_init.sql`):

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `name` | TEXT NOT NULL | |
| `parent_project_id` | UUID → `projects(id)` ON DELETE CASCADE | nullable; projects nest |
| `created_at` | TIMESTAMPTZ NOT NULL | |

**Added**:

| Column | Type | Notes |
|---|---|---|
| `owner_id` | UUID **NOT NULL** → `users(id)` | mirrors `diagrams.owner_id` exactly |

Plus `CREATE INDEX projects_owner_id_idx ON projects (owner_id)` — the list query filters on it on
every page load, and `diagrams_project_id_idx` sets the precedent.

### The backfill is a real decision, not a formality

`NOT NULL` cannot be added to a populated table without a value for every existing row, and
FR-013b requires one. There is no obviously correct owner for a project created before ownership
existed, so the rule is stated here rather than left to whoever writes the migration:

1. If every diagram in the project shares one owner, that user becomes the project's owner. This
   is the case that matches intent — the person who filled the project owns it.
2. Otherwise (mixed owners, or **no diagrams at all**), fall back to the earliest-created user
   with role `admin`.

Rule 2 is not a nicety: the seeded project may be empty, and an empty project has no diagram to
infer from. A migration that only implements rule 1 fails on exactly the data this repository
ships with.

The migration MUST fail loudly if no admin user exists rather than inserting NULL or inventing a
user — an installation with no admin is a broken installation, and silently producing an
ownerless project would make every project invisible to everyone (the failure mode FR-013b exists
to prevent).

**Ordering**: add the column nullable → backfill → set `NOT NULL`. Adding it `NOT NULL` outright
fails against any non-empty table.

---

## Not a new entity: Project access

Deliberately introduces **no table**. "Who can see this project" is derived:

```
visible(user, project) := project.owner_id = user.id
                       OR EXISTS (share_grants
                                    WHERE subject_type = 'project'
                                      AND subject_id  = project.id
                                      AND grantee_user_id = user.id)
```

`share_grants` already constrains `subject_type IN ('diagram', 'project')` and is already resolved
for projects by `sharing.service.ts`. Nothing is added to it.

**This rule MUST exist in exactly one place** (`project.access.ts`) and be called by both the
route guard and the list query. Duplicating it means the list and the guard can disagree, and a
disagreement here is a data leak, not a display glitch.

### Nesting: a gap the spec does not close

`projects.parent_project_id` means projects form a tree, and `GET /projects/:id/tree` returns
descendants. So "can this user see project X" has a second half the spec never asked about: **does
access to a parent extend to its children?**

**Decision: yes — access inherits downward.** A user who can see a project can see its
descendants.

Rationale: the tree endpoint's entire purpose is to return descendants, and nesting exists to
organize work that belongs together. The alternative — checking each descendant independently —
would let a user hold a parent whose children are invisible, rendering a tree with holes in it,
and no requirement asks for that.

Consequence, and it must be tested: a user granted a child project does **not** thereby see its
parent or its siblings. Inheritance runs one way only.

---

## Unchanged entity: Current project selection

Not persisted anywhere. Per-tab application state seeded from the address (spec Assumptions).
Listed here only to be explicit that it is **not** a database concern — no user-preference column,
no session row.

---

## Validation rules

| Rule | Source | Where enforced |
|---|---|---|
| Every project has an owner | FR-013b | `NOT NULL` + backfill |
| Creating a project makes you its owner | FR-013c | `createProject` sets `owner_id` from the session |
| A user is offered only projects they own or were given | FR-013a | `listForUser`, via the shared rule |
| Missing project → 404; inaccessible project → 403 | FR-013 | Guard, following the existing diagram convention |
| A malformed project id is treated as "no project" | Edge case | Client-side; never reaches the API |

**On that fourth rule — I first specified the opposite and was wrong.** The instinct is to return
404 for both, so a prober cannot learn which project ids are real. Checking
`access-control.middleware.ts` before writing the contract showed this codebase has already
settled the question the other way, deliberately and with a recorded reason:
`requireDiagramAccess` lets a nonexistent id fall through to the route's own 404 "so callers still
see the route's own 404 instead of a misleading 403 that implies the diagram exists but is
inaccessible."

Two reasons to follow that convention rather than override it:

- **Ids are `gen_random_uuid()`.** Enumerating random v4 UUIDs is not a practical attack, so
  collapsing both cases to 404 buys almost nothing.
- **FR-013 asks for a *clear explanation*.** "That project does not exist" shown to someone who
  was handed a perfectly valid link by a colleague is actively misleading — it sends them to
  investigate the wrong problem instead of asking for access.

Consistency with the established pattern wins on both counts. Diverging here would also mean
projects and diagrams behaved differently for no reason a reader could infer.

---

## What is explicitly *not* changing

- `diagrams` — no column added, and diagram-level access rules are untouched.
- `share_grants` — reused as-is.
- Any `diagram-core` model type. This feature never touches diagram content, so nothing in
  `packages/diagram-core/src/model/` changes and the round-trip contract is not engaged.
