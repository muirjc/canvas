# Phase 0 Research: Project Context

Grounded in direct inspection of the routes, services, schema, and editor state. Each decision
records what was chosen, why, and what was rejected.

---

## 1. The visibility requirement cannot be met by filtering the list alone

**Decision**: Enforce project access on the server, on every route that takes a project id, and
build the picker's list from the same rule. Filtering only the list is not an option.

**Rationale**: This is the most important finding of Phase 0. Today **no route that takes a
project id checks anything beyond "is this user signed in"**:

| Route | Guard today |
|---|---|
| `GET /projects/:id` | `requireAuth` only |
| `GET /projects/:id/tree` | `requireAuth` only |
| `POST /projects/:id/diagrams` | `requireAuth` only |
| `GET /projects/:id/diagrams` (search) | `requireAuth` only |
| `POST /projects/:id/diagrams/import` | `requireAuth` only |

There is a `requireDiagramAccess(level)` middleware for diagrams, but **no project equivalent
exists**. Worse, `getProjectTree` issues `SELECT ... FROM projects` and
`SELECT ... FROM diagrams WHERE deleted_at IS NULL` with **no user or project predicate at all**,
loading every project and every diagram in the installation before assembling the requested
subtree.

So any signed-in user can already read any project — including its full diagram tree — simply by
knowing or guessing an id. If this feature filtered only the picker, FR-013a ("projects belonging
to others MUST NOT be listed or named") would be cosmetic: the names would be hidden from the
dropdown while remaining one request away.

**Consequence**: the honest scope of "project visibility becomes access-controlled" includes a
`requireProjectAccess` middleware applied to those five routes, and a scoped tree query. That is
larger than the spec's wording implies, and it is the difference between a security property and
the appearance of one.

**Alternatives rejected**: filter the list only (creates a false impression of privacy — arguably
worse than today's honest openness); defer enforcement to a later feature (leaves FR-013a
unmet while claiming it is met).

---

## 2. Ownership: one additive column, reusing sharing that already exists

**Decision**: Add `owner_id` to `projects` (referencing `users`), backfilled. Resolve "available
to me" as *owner OR an existing project-level share grant*.

**Rationale**: Project **sharing** is already modelled *and implemented* — it is only ownership
that is missing:

- `share_grants.subject_type` is `CHECK (subject_type IN ('diagram', 'project'))` — the schema has
  always allowed project grants.
- `sharing.service.ts` already resolves them (`SELECT access_level FROM share_grants WHERE
  subject_type = 'project' AND subject_id = $1 AND grantee_user_id = $2`).
- `sharing.routes.ts` already registers the project sharing endpoints
  (`registerSubjectRoutes(app, 'project')`).

`diagrams` already carries `owner_id`, so projects gaining one follows an established pattern
rather than inventing a concept.

**Backfill is mandatory, not cosmetic**: the moment visibility follows ownership, an ownerless
project is visible to nobody. Every existing project must be assigned an owner in the same
migration (FR-013b).

**Alternatives rejected**: a separate `project_members` table (duplicates what `share_grants`
already does for this exact subject type); inferring ownership from the oldest diagram's owner
(guesswork that breaks for empty projects).

---

## 3. Where the current project lives

**Decision**: React state in the app shell, seeded from the address on load, written back with a
history-replacing update so the address always names the project in view without pushing a new
entry per switch.

**Rationale**: FR-011 requires a copied address to open the same project, so the address must keep
reflecting the selection. FR-012 requires the back control to stay usable, which rules out pushing
history on every switch. Replacing rather than pushing satisfies both.

State must live above the screens that need it — the home screen, the editor, and the admin shell
all consume it — which in practice means the app shell that already owns `diagram` and dialog
state.

**Per-tab, not persisted** (spec Assumptions): tab-local state gives two tabs independent projects
for free. A stored per-user default would need a tie-break between "what the address says" and
"what was stored", which nothing yet requires.

**Alternatives rejected**: keeping it in the address alone (the status quo, and the defect); a
route library (a dependency for one parameter, on query-string routing that otherwise works).

---

## 4. The links that lose the context

**Decision**: Route every in-app destination through a single helper that preserves the current
project, rather than hand-editing each `href`.

**Rationale**: The parameter is lost because every `<a href="?…">` in the app is an absolute
query-string replacement. There are ten such links, but — verified — only **six edit sites**:

- `AdminShell.tsx:55` renders all five admin destinations from a single
  `` href={`?admin=${destination.param}`} `` inside a loop over a `destinations` array. One edit
  fixes all five.
- `App.tsx:146–158` has five *literal* `href="?admin=…"` attributes in the home nav. Five edits.

`AdminShell`'s "Back to diagrams" link (`AdminShell.tsx:42`) is *already* correct — it preserves
the `projectId` it is given — which is why the loss is invisible until you notice it happened one
hop earlier, on the way *in*.

Hand-editing ten `href`s fixes today's links and silently breaks on the eleventh. A helper makes
the correct thing the default.

**Alternatives rejected**: patching the ten links individually (fixes the instances, not the
class); dropping the parameter from admin URLs entirely (breaks deep links into admin screens).

---

## 5. Unsaved-change detection does not exist yet

**Decision**: Derive "has unsaved changes" by comparing the editor's current serialized DSL against
the last-saved content, and gate the project switch on it.

**Rationale**: `DiagramEditor` tracks `saveStatus` as `idle | saving | saved | error` — that is
*request* state, not *dirty* state. It never becomes "dirty" when the model changes, so there is
currently no way to answer "does this user have unsaved work". FR-013d needs that answer.

The editor already derives DSL from the model on every change via `useDslSync`, so comparing it to
the content last persisted is a cheap and truthful signal — it is exactly what the user would lose.

**Alternatives rejected**: a boolean flag set by every mutation site (many call sites, easy to miss
one, and wrong after a save); `beforeunload` (covers tab close, not an in-app switch).

---

## 6. Listing projects: a new endpoint, deliberately narrow

**Decision**: One new read endpoint returning the projects available to the caller — owned or
shared — with no search and no paging.

**Rationale**: No endpoint lists projects today; there is only create, get-by-id, and tree. The
clarified scale is *tens*, so search and paging are explicitly out of scope and would be
speculative generalization.

The endpoint must apply the same access rule as the middleware in §1, from one shared helper —
two implementations of "can this user see this project" would drift, and the drift would be a
security bug rather than a display bug.

---

## 7. First run, and the newly-possible empty case

**Decision**: When the user has no projects available, show the create-a-project invitation rather
than an error, and place them in the project they create.

**Rationale**: FR-014/FR-015 require inviting rather than inventing. Note this state is *newly
reachable*: before this feature, "no projects" meant an empty installation; now it also means "a
user who owns nothing and has been given nothing", which can happen on a populated system. Both
resolve to the same screen, so no extra branch is needed — but the second case is easy to forget
when testing, and is why the spec lists it as an edge case.

---

## 8. Keeping the reproduction test honest

**Decision**: Treat `apps/web/tests/e2e/project-context.spec.ts` as fixed input. It must pass by
the defect being fixed, with no assertion weakened (SC-005).

**Rationale**: It was written before any fix, verified failing 0/3 for the right reasons. Its value
is precisely that it was not written to fit the implementation. The most likely way this feature
goes wrong is someone "fixing" it by relaxing an assertion, so the constraint is stated here as
well as in the spec.

It also encodes the blind spot that let the defect through: every other spec navigates to
`/?projectId=…` and so could never have caught it. New E2E work should reach the home screen the
way a user does.
