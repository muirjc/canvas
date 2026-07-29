# Tasks: Project Context

**Input**: Design documents from `/specs/007-project-context/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Test tasks are included and are **not optional here**. The spec makes them success
criteria (SC-005, SC-007), and `contracts/projects-api.md` documents a guard failure mode that
only a negative test can catch.

**Organization**: By user story, in priority order.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on incomplete work)
- **[Story]**: US1–US4, on user-story tasks only

## Path Conventions

Three npm workspaces: `apps/web` (React + Vite), `apps/api` (Fastify), `packages/diagram-core`
(untouched by this feature). Migrations live in `apps/api/migrations/`.

---

## Sequencing note — read before starting

**User Story 1 cannot ship without Phase 2.** The usual pattern is "Setup → Foundational → US1 as
MVP", with Foundational kept as thin as possible. Here the clarified visibility decision pushes
real work earlier: landing on the root with no project means the app must *resolve* one, which
requires knowing which projects are available to this user, which requires ownership and the list
endpoint.

The alternative — ship US1 against a list-everything endpoint and filter later — would put a
project-name leak into the tree, however briefly. Phase 2 is therefore larger than typical, and
US1 is genuinely gated on it.

---

## Phase 1: Setup

**Purpose**: Establish a trustworthy baseline before changing anything.

- [X] T001 Run all suites and record counts. Measured baseline: **154** diagram-core, **95** api, **82 passed + 3 failed + 1 skipped** E2E. Note `@canvas/web` has **no unit tests at all** — `vitest run` there exits 1 with "No test files found"; its coverage is entirely Playwright.
- [X] T002 Confirm the 3 failures in `apps/web/tests/e2e/project-context.spec.ts` are the missing-project error and **not** an environment fault — check no stale API process holds port 3000, since that has already produced a false signal in this project

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Ownership, the access rule, and the list capability. Every user story depends on
this phase.

### Ownership

- [X] T003 Create `apps/api/migrations/0006_project_owner.sql` adding `owner_id UUID REFERENCES users(id)` to `projects`, backfilling per `data-model.md` (unanimous diagram owner, else earliest-created admin), then setting `NOT NULL` — column must be added nullable first
- [X] T004 Add `CREATE INDEX projects_owner_id_idx ON projects (owner_id)` to the same migration
- [X] T005 Make the migration fail loudly if no admin user exists rather than leaving NULL, in `apps/api/migrations/0006_project_owner.sql`
- [X] T006 Apply the migration to a database containing a **project with no diagrams** and verify `SELECT count(*) FROM projects WHERE owner_id IS NULL` returns 0 — the seeded project may be empty, and a diagram-owner-only backfill has nothing to infer from there

### The access rule (one implementation, two callers)

- [X] T007 Create `apps/api/src/projects/project.access.ts` exporting the single visibility rule — owner OR project-level `share_grants` entry — with downward inheritance through `parent_project_id` per `data-model.md`
- [X] T008 [P] Cover the access rule: owner sees own; grantee sees shared; third party sees neither; child access inherits from parent; **parent access does NOT inherit upward from a granted child**. Landed as contract tests in `apps/api/tests/contract/project-access.test.ts` rather than unit tests beside the module — `apps/api/vitest.config.ts` only includes `tests/**/*.test.ts`, so the originally planned `src/*.test.ts` path would never have been executed. All five behaviours are covered; they exercise the rule through the routes that use it.
- [X] T009 Write **failing** negative tests in `apps/api/tests/contract/project-access.test.ts` — one per guarded route, asserting 403 for a signed-in user with no access, and 404 for a genuinely nonexistent id; run them and confirm all five currently return 200
- [X] T010 Add `requireProjectAccess(required: AccessLevel)` to `apps/api/src/auth/access-control.middleware.ts`, modelled on `requireDiagramAccess`, reading the project id from an explicit per-route parameter name — **not** a hardcoded `params.id`
- [X] T011 Apply `requireProjectAccess('view')` to both `:id` routes in `apps/api/src/projects/project.routes.ts`
- [X] T012 Apply `requireProjectAccess('edit')` to `POST /projects/:projectId/diagrams` and `requireProjectAccess('view')` to `GET /projects/:projectId/diagrams` in `apps/api/src/diagrams/diagram.routes.ts` — note the parameter is `projectId`, not `id`
- [X] T013 Apply `requireProjectAccess('edit')` to `POST /projects/:projectId/diagrams/import` in `apps/api/src/diagrams/import.routes.ts`
- [X] T014 Re-run T009 and confirm all five routes now return 403/404 as specified — a guard reading the wrong parameter still returns 200 here while every happy-path test stays green

### Scoping and listing

- [X] T015 Scope `getProjectTree` in `apps/api/src/projects/project.service.ts` to the requested subtree, replacing the two unfiltered full-table reads; preserve the `ORDER BY created_at DESC, id DESC` tiebreak and its explanatory comment
- [X] T016 Update `createProject` in `apps/api/src/projects/project.service.ts` to accept the acting user and set `owner_id` (FR-013c); it currently takes no user at all
- [X] T017 Add `listForUser` to `apps/api/src/projects/project.service.ts`, delegating to `project.access.ts` and ordering by `name`
- [X] T018 Register `GET /projects` in `apps/api/src/projects/project.routes.ts` returning `{ projects: [...] }`, and `200` with an empty array — never 404 — when the user has access to none
- [X] T019 [P] Write API tests in `apps/api/tests/contract/project-list.test.ts` for `GET /projects`: owner sees own, grantee sees shared, third party's project absent by both id and name, no-access user gets `200 []`
- [X] T020 [P] Add a `listProjects()` method to the web API client in `apps/web/src/app/api.ts`

**Checkpoint**: Access is enforced server-side and the list capability exists. User stories may begin.

---

## Phase 3: User Story 1 — Create a diagram without knowing about the address bar (P1) 🎯 MVP

**Goal**: The reported defect is fixed — root address, sign in, create a diagram, no address-bar editing.

**Independent test**: Open the app at the bare root, sign in, create a diagram. It succeeds.

- [X] T021 [US1] Move the `projectId` guard **above** `setPickingType(false)` in `createDiagram()` in `apps/web/src/app/App.tsx` so a chosen diagram type survives a failed attempt (FR-003)
- [X] T022 [US1] Create `apps/web/src/app/project-context.ts` with the read/resolve helpers: parse the address, treat a malformed id as absent, and expose the current selection
- [X] T023 [US1] Replace `getProjectIdFromUrl()` usage in `apps/web/src/app/App.tsx` with current-project React state seeded from the address on load
- [X] T024 [US1] Resolve the initial project on load in `apps/web/src/app/App.tsx`: address id if accessible → else the single available project → else the empty state; never invent one (FR-015)
- [X] T025 [US1] Remove the three "Missing ?projectId= in the URL" error strings from `apps/web/src/app/App.tsx` (lines ~45, ~112, ~127) — FR-004 forbids instructing the user to edit the address bar
- [X] T026 [US1] Verify the import and AI dialogs still render when a project is resolved, in `apps/web/src/app/App.tsx` — both are currently gated on `importing && projectId` / `creatingViaChat && projectId`
- [X] T027 [US1] Run `apps/web/tests/e2e/project-context.spec.ts` and confirm the create-from-root scenario passes **without editing the test file**

**Checkpoint**: The reported bug is fixed. This is a shippable increment.

---

## Phase 4: User Story 2 — Keep working in the same project while moving around (P2)

**Goal**: Context survives every navigation, including the admin round trip.

**Independent test**: Open a project, visit each admin screen, return, create a diagram — same project throughout.

- [X] T028 [US2] Add a link-building helper to `apps/web/src/app/project-context.ts` that carries the current project into any in-app destination
- [X] T029 [US2] Use the helper in the destinations loop at `apps/web/src/ui/AdminShell.tsx:55` — one edit covers all five admin links
- [X] T030 [US2] Use the helper for the five literal `href="?admin=…"` attributes at `apps/web/src/app/App.tsx:146–158`
- [X] T031 [US2] Keep the address in step with the selection using a history-**replacing** update in `apps/web/src/app/App.tsx`, so a copied link works (FR-011) without one history entry per switch (FR-012)
- [X] T032 [US2] Verify `AdminShell`'s existing `admin-back-to-diagrams` link still works unchanged — it already preserves what it is given and must not be rewritten
- [X] T033 [US2] Run `apps/web/tests/e2e/project-context.spec.ts` and confirm the two admin round-trip scenarios pass, again without editing the test

**Checkpoint**: The fix holds across navigation rather than surviving one click.

---

## Phase 5: User Story 3 — Work with more than one project, seeing only your own (P3)

**Goal**: The user can see and change their project, and is offered only what they own or were given.

**Independent test**: Two users, three projects — each sees only theirs; switching changes the diagrams listed and where new ones land; a copied link opens the same project for a colleague with access.

- [X] T034 [P] [US3] Create `apps/web/src/app/ProjectPicker.tsx` with testids `project-picker`, `project-picker-option`, `project-name`; a plain list, no search or paging (FR-013e)
- [X] T035 [US3] Wire the picker into `apps/web/src/app/App.tsx`, showing the current project name (FR-008) and skipping the chooser entirely when only one project is available
- [X] T036 [US3] Expose an unsaved-changes signal from `apps/web/src/canvas/DiagramEditor.tsx` by comparing current serialized DSL against last-saved content — `saveStatus` is request state and never becomes "dirty"
- [X] T037 [US3] Add the switch confirmation with testid `project-switch-confirm` in `apps/web/src/app/App.tsx`, following the existing destructive-action pattern; cancelling must leave the work intact (FR-013d)
- [X] T038 [US3] Handle an address naming a missing or inaccessible project in `apps/web/src/app/App.tsx`: explain plainly and leave the user somewhere usable (FR-013)
- [X] T039 [P] [US3] Add E2E visibility tests in `apps/web/tests/e2e/project-visibility.spec.ts` — a second user's project appears nowhere in the picker, by id or by name (FR-013a, SC-006a)
- [X] T040 [P] [US3] Add E2E switching tests in `apps/web/tests/e2e/project-visibility.spec.ts`: switching changes the diagrams listed and the project new diagrams land in (FR-010)
- [X] T041 [P] [US3] Add an E2E test that a copied address opens the same project for another user with access (FR-011, SC-006)
- [X] T042 [US3] Add an E2E test that switching with unsaved changes warns, and that cancelling preserves the work (SC-006b)

**Checkpoint**: Multi-project use works and visibility is enforced end to end.

---

## Phase 6: User Story 4 — Start from an empty system (P4)

**Goal**: No projects means an invitation, not an error.

**Independent test**: With no projects present, sign in and reach a diagram without an error as the first response.

- [X] T043 [US4] Add the empty-state invitation with testid `create-first-project` in `apps/web/src/app/App.tsx` (FR-014)
- [X] T044 [US4] On creation, place the user in the new project and make them its owner via `POST /projects`, in `apps/web/src/app/App.tsx`
- [X] T045 [US4] Add an E2E test in `apps/web/tests/e2e/project-visibility.spec.ts` covering **both** routes to this state: a genuinely empty system, and a user with access to no projects on a populated system — the second is newly reachable and easy to miss

---

## Phase 7: Polish & Cross-Cutting Concerns

- [X] T046 [P] Verify keyboard operation of the picker end to end — open, traverse, choose, dismiss (FR-018)
- [X] T047 [P] Run the axe audit and confirm zero violations including the new picker (SC-007)
- [X] T048 Run all four suites; diagram-core must remain at 154 since this feature touches none of it
- [X] T049 Inspect `git diff apps/web/tests/e2e/project-context.spec.ts` and confirm **no assertion was weakened** — SC-005 exists because making the reproduction test pass by editing it is the most likely way this feature goes wrong; a green tick is not evidence
- [X] T050 Confirm an address explicitly naming a project still opens it (FR-016, SC-008)
- [X] T051 Update bead `canvas-xyl` with the outcome, recording that the access-control gap was found during planning and fixed here

---

## Dependencies

```
Phase 1 (Setup)
   ↓
Phase 2 (Foundational) ─── blocks every story; larger than usual, see sequencing note
   ↓
Phase 3 (US1, P1) ─── MVP: the reported defect
   ↓
Phase 4 (US2, P2) ─── makes the fix durable
   ↓
Phase 5 (US3, P3) ─── picker + visibility
   ↓
Phase 6 (US4, P4) ─── empty system
   ↓
Phase 7 (Polish)
```

Within Phase 2: T003→T004→T005→T006 (same migration file, strictly ordered). T007 gates T008 and
T010. **T009 must run and fail before T010–T013**, or the negative tests prove nothing. T015–T018
all edit `project.service.ts`/`project.routes.ts` and are sequential.

US1 and US2 both edit `App.tsx` heavily and are sequential in practice despite being separate
stories.

## Parallel opportunities

- T008 with T009 — different test files
- T019 with T020 — API test vs web client
- T034 with T039–T041 — component vs E2E specs
- T046 with T047 — independent audits

## Implementation strategy

**MVP = Phase 1 + Phase 2 + Phase 3.** That delivers the reported fix. Phase 2 is unavoidable
overhead for it, for the reason in the sequencing note.

**Do not stop at "0/3 → 3/3".** Those three tests cover US1 and US2 only; they reference 17
testids, all pre-existing, and none of the picker's. They can pass with no picker at all and with
visibility entirely unenforced. The part whose failure is a data leak rather than a bug is tested
in Phase 5.
