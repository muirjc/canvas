# Phase 0 Research: Reaching a Diagram Shared With You

Grounded in direct inspection of the schema, existing sharing/project code, and the E2E fixture
set. Each decision records what was chosen, why, and what was rejected.

---

## 1. The list needs no access-resolution logic of its own

**Decision**: One query, joining `share_grants` (`subject_type = 'diagram'`, `grantee_user_id = $1`)
to `diagrams` and `projects`, filtered by `diagrams.deleted_at IS NULL`. No call to
`resolveDiagramAccess`, no project-access check, no de-duplication logic.

**Rationale**: The four trickiest-looking requirements fall out of that one query for free:

- **FR-011** (revoked grants and soft-deleted diagrams must not appear): a revoked grant is a
  `DELETE`d row — gone from the join by construction — and the `deleted_at IS NULL` predicate
  drops soft-deleted diagrams the same way every other read path already does.
- **FR-006** (include a diagram even when the user also has project access to it): satisfied by
  *not checking project access at all*. The list is "does a diagram-level grant exist", full
  stop — adding a project-access check would be extra code whose only effect is producing the
  wrong answer.
- **FR-004** (open at exactly the grant's access level): the row's `access_level` **is** the grant
  row's stored value — the same column `resolveDiagramAccess` reads first, before it ever falls
  back to a project-level grant. Nothing to compute.
- Ordering matches `listProjectsForUser`'s existing precedent (`ORDER BY name, id` — stable across
  reloads); no new convention introduced.

**Alternatives rejected**: building the list by calling `resolveDiagramAccess` per candidate
diagram (redundant — we already have the grant row that function would rediscover, and it would
reintroduce a project-access check FR-006 explicitly says not to make); a de-duplication pass
against the user's accessible-project set (unnecessary per FR-006, and it would silently re-couple
this feature to `project.access.ts`, which FR-010 says must not change).

---

## 2. Sharer identity: the existing precedent is unusable, contra the spec's assumption

**Decision**: Resolve `granted_by_user_id` to `users.name` (and `email`, for tests/tooling) via a
join in the same query. Do not reuse `ShareDialog.tsx`'s existing display.

**Rationale**: The spec's Assumptions section guessed the sharer would be shown "whichever
identifier the product already displays for a user elsewhere (e.g., in the existing share
dialog)". Reading `ShareDialog.tsx` shows that guess does not hold: it renders
`grant.granteeUserId` directly (`<span className="row__title">{grant.granteeUserId}</span>`) — a
raw UUID, not a name. That satisfies FR-007's letter (technically "identifies" the person) while
failing its purpose (a user cannot judge who shared something from a UUID). Following that
precedent here would ship a defect matching an existing one rather than a working feature.

The correction (join to `users.name`) is reflected back into the spec's Assumptions section as a
research finding, per the same practice feature 007 used when Phase 0 findings changed what an
assumption should say.

**Alternatives rejected**: matching `ShareDialog.tsx` exactly (ships an unreadable UUID);
introducing a new generic "resolve user by id" endpoint (unnecessary — the join happens
server-side in the one query that needs it, so no new API surface is required).

---

## 3. Naming the project: a plain join, no ancestor chain

**Decision**: `JOIN projects p ON p.id = d.project_id`, selecting only `p.name`. No recursive
ancestor lookup.

**Rationale**: `project.access.ts`'s `ancestorChain` exists because *access* inherits downward
through nesting and so must walk the chain. Naming does not: the clarified answer to "does the
row name extend to ancestors" is no (spec Clarifications), so the query needs exactly the
diagram's immediate `project_id` — a single join, not a recursive CTE. Simpler than the access
code it sits beside, deliberately.

**Alternatives rejected**: reusing `ancestorChain` and taking the first entry (pulls in
recursive-CTE machinery to answer a question that never needed recursion).

---

## 4. A missing index would make this query the odd one out

**Decision**: Add `CREATE INDEX share_grants_grantee_idx ON share_grants (grantee_user_id,
subject_type)` in a new migration (`0007`).

**Rationale**: The existing `share_grants_subject_idx` is `(subject_type, subject_id)` — built for
"who can access *this* diagram/project" (`resolveDiagramAccess`, `resolveProjectAccess`), where
the subject is known and specific. This feature asks the opposite question — "every diagram
granted to *this* user" — filtered by `grantee_user_id` with no `subject_id` to narrow on, which
the existing index cannot serve. Every other "list mine" query in this codebase has its own
supporting index (`projects_owner_id_idx` for feature 007's `listProjectsForUser`,
`diagrams_project_id_idx` for the project tree); this one would be the exception without it.

**Alternatives rejected**: shipping without the index (works today because seeded/test data is
tiny, but leaves a query that degrades linearly with total grant count instead of with one user's
grant count — precisely the kind of thing that is invisible in development and slow in
production).

---

## 5. The seeded E2E fixtures cannot represent User Story 1's own precondition

**Decision**: Add one new seeded user (no role beyond `architect`-equivalent permissions, no
project ownership, no project-level grant) to `apps/api/src/seed/run.ts`, so E2E tests can share a
specific diagram with a user who provably has zero project access.

**Rationale**: This is the same class of finding as feature 007 research.md §7 (the "newly
possible empty case") — a precondition the feature's own tests need, that the current fixtures
happen to hide. Checked directly:

- The seeded **admin** bypasses every access check (`role = 'admin'` short-circuits both
  `resolveProjectAccess` and `resolveDiagramAccess`) — cannot stand in for "no project access".
- The seeded **architect** is *deliberately* given a project-level grant on the Smoke Test project
  by `run.ts` itself (comment: "the architect needs an explicit grant now that project visibility
  follows ownership"). That grant is permanent seed state, not something a test can transiently
  unshare without mutating shared fixtures other specs also depend on.

So neither existing seeded user can ever satisfy User Story 1's stated precondition ("no project
access at all"). Without a third user, any E2E test claiming to cover US1 would actually be
exercising FR-006's duplication path (a user who has project access *and* a diagram grant) while
believing it tests the harder case — green for the wrong reason, the exact failure mode 007's
research flagged about a different test.

**Alternatives rejected**: transiently revoking the architect's project grant mid-test and
restoring it (couples this feature's tests to another spec's fixture and is exactly the kind of
mutation that produces cross-file flakiness `playwright.config.ts`'s `workers: 1` comment already
warns about); adding a user-creation API endpoint (real scope creep — no other requirement calls
for one, and direct-SQL seeding is how every other fixture user in this codebase is created).

---

## 6. Where the list sits on the home screen

**Decision**: Rendered in `App.tsx` independent of the existing `hasNoProjects` ternary — after the
page title, before the project-having/no-project branch — so it is never visually or structurally
nested under the project browser or the create-project invitation.

**Rationale**: Spec Assumptions rule out nesting it under a specific project (a user with zero
projects still needs to see it). The only way to satisfy that in the current component structure
is to lift it above the branch that already assumes "has a project or doesn't", rather than
threading it into both sides of that branch separately.

**Consequence worth stating plainly**: FR-003 requires the first-run invitation be suppressed —
not reworded — for a user who has shared diagrams. For a user with *zero* projects *and* at least
one shared diagram, this means the entire `create-first-project` section (invitation text *and*
its create-project button/form) is absent; the shared list is the whole of their home screen. That
is what the accepted clarification says, not a planning simplification — flagged here so it is not
"fixed" by quietly restoring the create-project button during implementation.

**Alternatives rejected**: nesting the list inside the `hasNoProjects` ternary on both branches
(duplicates the render call and the empty-check in two places instead of one).
