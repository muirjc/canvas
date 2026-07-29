# Tasks: Reaching a Diagram Shared With You

**Input**: Design documents from `/specs/008-shared-diagram-access/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Test tasks are included and are **not optional here**, matching this project's own
established convention (see feature 007's `tasks.md`): `contracts/shared-diagrams-api.md` and
`quickstart.md` both document failure modes (the fixture gap, a disguised project-name link) that
only a specific negative test catches — a happy-path-only test suite would stay green through
either.

**Organization**: By user story, in priority order.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on incomplete work)
- **[Story]**: US1–US3, on user-story tasks only

## Path Conventions

Three npm workspaces: `apps/web` (React + Vite), `apps/api` (Fastify), `packages/diagram-core`
(untouched by this feature). Migrations live in `apps/api/migrations/`.

---

## Sequencing note — read before starting

**User Story 1 and User Story 2 are both P1 and both edit the same conditional block in
`App.tsx`.** US1 adds the shared-diagrams section above the existing `hasNoProjects` branch; US2
changes that branch's condition so the false invitation stops appearing once US1's data exists.
They are listed as separate phases below (each independently testable), but expect to implement
them back-to-back in practice, the same way feature 007 noted for its own US1/US2 pair.

**User Story 3 needs no new backend work.** The Foundational query already returns
`sharedByName`/`sharedByEmail` as part of its one join (data-model.md) — US3 is purely a frontend
task adding a span to a row `SharedDiagramsList.tsx` already renders for US1.

---

## Phase 1: Setup

**Purpose**: Establish a trustworthy baseline, and fix the one fixture gap this feature's own
tests need before any of them can be written correctly.

- [X] T001 Run all suites and record counts. Expected baseline: **154** diagram-core, **112
      passed + 1 skipped** api, **96 passed + 1 skipped** E2E (per `quickstart.md`). Confirm none
      fail before any code changes — a pre-existing failure here must be resolved first so a
      later red run can be trusted to mean this feature broke something.
      **Confirmed exactly**: 154/154 diagram-core, 112 passed + 1 skipped api, 96 passed + 1
      skipped E2E (2.4m).
- [X] T002 [P] Add one new seeded user with zero project ownership and zero project-level grant to
      `apps/api/src/seed/run.ts` (research.md §5) — neither existing seeded user (`admin` bypasses
      every access check; `architect` already holds a permanent project-level grant) can represent
      this feature's own primary precondition: a user with *no* project access at all.
      Added `Guest`/`guest@example.com` (role `viewer`), no ownership, no grant. Verified `npm run
      seed` still runs cleanly and prints the new login.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The one read endpoint every user story depends on. No story-specific UI or
suppression logic lives here — only the capability to ask "what has been shared with me".

- [X] T003 [P] Create `apps/api/migrations/0007_share_grants_grantee_idx.sql` adding
      `CREATE INDEX share_grants_grantee_idx ON share_grants (grantee_user_id, subject_type)` —
      index only, no column, no backfill (data-model.md). Apply it to a dev/test database and
      confirm via `\d share_grants` that the index now exists.
- [X] T004 Add `listSharedDiagramsForUser(userId)` to `apps/api/src/sharing/sharing.service.ts`,
      implementing the single join in `data-model.md` exactly: `share_grants` (`subject_type =
      'diagram'`, `grantee_user_id = $1`) → `diagrams` (`deleted_at IS NULL`) → `projects`
      (immediate `project_id` only, no ancestor lookup) → `users` (`granted_by_user_id`, joined
      without an `active = true` filter — FR-007 requires the identity regardless). Order by
      `d.name, d.id`. Do **not** call `resolveDiagramAccess` or anything in `project.access.ts` —
      research.md §1 found the join alone already satisfies FR-002/FR-006/FR-011 with no extra
      filtering.
- [X] T005 [P] Write failing API contract tests in `apps/api/tests/contract/shared-diagrams.test.ts`
      (`GET /shared-diagrams` does not exist yet, so these must fail): a user with a direct grant
      and zero project access sees exactly that diagram; a user with **both** project access and a
      direct grant on a diagram in a different project sees it once, not deduped and not omitted
      (FR-006); revoking the grant removes the diagram from a subsequent call (FR-011);
      soft-deleting the diagram removes it (FR-011); `accessLevel` in the response matches what was
      granted; the response has no field naming an ancestor project — only the immediate one; a
      user with nothing shared gets `{ "diagrams": [] }` and `200`, not `404`.
- [X] T006 Register `GET /shared-diagrams` in `apps/api/src/sharing/sharing.routes.ts` (top-level,
      `requireAuth` only — not inside `registerSubjectRoutes`, since this route takes no `:id`),
      calling `listSharedDiagramsForUser(request.session.user!.id)` and returning
      `{ diagrams: [...] }`.
- [X] T007 Re-run T005 and confirm all cases now pass. **Confirmed**: 7/7 new, 119 passed + 1
      skipped overall (112 + 7 new).
- [X] T008 [P] Add `SharedDiagramDto` and `api.listSharedDiagrams()` to `apps/web/src/app/api.ts`,
      matching the shape in `contracts/shared-diagrams-api.md`.

**Checkpoint**: The endpoint exists, is tested, and the web client can call it. User stories may
begin.

---

## Phase 3: User Story 1 - Find and open a diagram shared with you (Priority: P1) 🎯 MVP

**Goal**: A user with a diagram-level grant and no project access can locate and open that diagram
from the home screen, with no link or instruction from anyone else.

**Independent Test**: Sign in as the zero-access user from T002 after admin has shared exactly one
diagram with them directly. Locate and open it from the home screen with no other navigation path
available.

- [X] T009 [P] [US1] Write failing E2E tests in `apps/web/tests/e2e/shared-diagrams.spec.ts`: as
      admin, create a project, create a diagram in it, and share that diagram (not the project)
      with the T002 user at `view` level; signed in as that user, the diagram appears in a
      `shared-diagrams` section and opens at `view` access; a user with no shares and no projects
      still sees the ordinary `create-first-project` invitation, unchanged (US1 acceptance #3).
      Confirm these fail — no such section exists yet.
- [X] T010 [US1] Create `apps/web/src/projects/SharedDiagramsList.tsx`, a sibling to
      `ProjectBrowser.tsx`, rendering one row per entry: diagram name, the immediate project name
      as **plain read-only text** (no `<a>`, no `onClick`, no way to browse that project — the
      FR-013a carve-out), the resolved access level, and an open button. Testids per
      `contracts/ui-contract.md`: `shared-diagrams`, `shared-diagram-{id}`,
      `open-shared-diagram-{id}`, `shared-diagram-project-{id}`, `shared-diagram-access-{id}`.
- [X] T011 [US1] In `apps/web/src/app/App.tsx`: add `sharedDiagrams` state, fetch it via
      `api.listSharedDiagrams()` alongside the existing project-fetch effect, and render
      `SharedDiagramsList` **independent of** the `hasNoProjects` ternary (above/outside it, not
      nested inside either branch — research.md §6) when the array is non-empty. Wire its open
      action to the existing `openDiagram` function — no new access path (FR-004, FR-010).
- [X] T012 [US1] Re-run T009 and confirm the discovery/open scenarios pass. **Confirmed**: 2/2.
- [X] T013 [US1] Extend `shared-diagrams.spec.ts` with a regression guard: assert the
      `shared-diagram-project-{id}` element is not an anchor and that clicking it does not
      navigate — the specific "looks done but isn't" trap named in `quickstart.md` (a project name
      rendered as `<a>` out of habit would reopen the disclosure feature 007 closed).

**Checkpoint**: The reported defect is fixed — a diagram-only grantee can find and open their
diagram. This is a shippable increment.

---

## Phase 4: User Story 2 - The home screen never claims you have no work when you do (Priority: P1)

**Goal**: The false "you do not have any projects yet" invitation never appears to a user who has
a diagram shared with them.

**Independent Test**: Sign in as a user with no project access and one shared diagram; confirm the
first-run invitation is absent. Separately, confirm a user with neither projects nor shares still
sees it, unchanged.

- [X] T014 [P] [US2] Write failing E2E tests in `shared-diagrams.spec.ts`: the T002 user, once a
      diagram is shared with them, does NOT see `create-first-project`; a user with genuinely
      nothing (no project, no share) still does. These should fail right now — T011 renders the
      shared list, but the invitation still shows alongside it until this story's implementation
      lands. **Confirmed failing**: `create-first-project` still present with a shared diagram.
- [X] T015 [US2] In `apps/web/src/app/App.tsx`, change the condition gating the
      `create-first-project` section from `hasNoProjects` to `hasNoProjects && sharedDiagrams.length
      === 0` (FR-003). When `hasNoProjects` is true but shared diagrams exist, render nothing in
      that ternary slot — `SharedDiagramsList` above it is the entire content, per the accepted
      clarification in `spec.md` (not a gap to patch by showing both). Implemented as a three-way
      branch (`hasNoProjects && sharedDiagrams.length > 0 ? null : hasNoProjects ? invite :
      homeActions`) — a plain `&&` on the ternary's condition would have wrongly fallen through to
      `home__actions`, which needs a `projectId` that doesn't exist in this case.
- [X] T016 [US2] Re-run T014 and confirm both directions pass. **Confirmed**: 3/3.

**Checkpoint**: Both P1 stories work together — the home screen is now both honest and navigable
for a diagram-only grantee.

---

## Phase 5: User Story 3 - Know who shared it with you (Priority: P3)

**Goal**: Each row in the shared list identifies who granted access.

**Independent Test**: Sign in as a user with a diagram shared by a specific colleague; confirm
that colleague's name appears alongside the diagram.

- [X] T017 [P] [US3] Write a failing E2E assertion in `shared-diagrams.spec.ts`: the row for a
      diagram shared by admin shows admin's name via `shared-diagram-shared-by-{id}`.
      **Confirmed failing**: element not found (span not yet rendered).
- [X] T018 [US3] Add the sharer-identity span (`data-testid="shared-diagram-shared-by-{id}"`) to
      `SharedDiagramsList.tsx`, reading `sharedByName` — already returned by the Foundational query
      (T004), so no backend change is needed here.
- [X] T019 [US3] Re-run T017 and confirm it passes. **Confirmed**: 4/4 in the spec file.

**Checkpoint**: All three user stories are independently functional; the feature is
feature-complete against the spec.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [X] T020 [P] Add a case to `apps/web/tests/e2e/accessibility.spec.ts` auditing a signed-in state
      whose home screen includes the shared-diagrams section (FR-008) — none of the currently
      audited pages/states include it. **Confirmed**: 8/8 accessibility.spec.ts, zero violations.
- [X] T021 [P] Verify keyboard-only operation of the shared list end to end: tab to a row's open
      button, activate with Enter/Space, no mouse required (FR-008). **Confirmed**: added as its
      own test in `shared-diagrams.spec.ts`, 5/5 passing.
- [X] T022 Run all suites: diagram-core must remain at **154** (untouched by this feature); api at
      **112 + new** `shared-diagrams.test.ts` cases; E2E at **96 + new** `shared-diagrams.spec.ts`
      + `accessibility.spec.ts` cases.
      **Confirmed**: 154/154 diagram-core; 119 passed + 1 skipped api (112+7 new); 102 passed + 1
      skipped E2E (96+6 new: 5 in `shared-diagrams.spec.ts`, 1 in `accessibility.spec.ts`).
      First full-suite run caught a real cross-file ordering bug: the new accessibility test shared
      a diagram with `guest` and, running alphabetically before `shared-diagrams.spec.ts`, left it
      non-empty for that file's "nothing shared" test. Fixed by having the accessibility test
      revoke its own grant in a `finally` block — exactly the kind of fixture-hygiene issue
      research.md §5 flagged, just from an unexpected direction (a test *I* added, not a
      pre-existing one).
- [X] T023 Inspect `git diff` across every pre-existing spec file this feature touched (there
      should be none — this feature is purely additive) and confirm no existing assertion was
      weakened anywhere (SC-004). **Confirmed**: `git status` shows only one pre-existing test
      file touched (`accessibility.spec.ts`), and its diff is +42/-0 — purely additive, no existing
      assertion changed.
- [X] T024 Update bead `canvas-ijq` with the outcome, and close it once the above is confirmed.
      **Done**: closed with a summary of the implementation and final suite counts.

---

## Dependencies

```
Phase 1 (Setup)
   ↓
Phase 2 (Foundational) ─── blocks every story; the one endpoint all three stories read from
   ↓
Phase 3 (US1, P1) ─── MVP: the reported defect
   ↓
Phase 4 (US2, P1) ─── makes the fix honest, not just navigable — tightly coupled to US1 in App.tsx
   ↓
Phase 5 (US3, P3) ─── sharer identity, additive to the row US1 already built
   ↓
Phase 6 (Polish)
```

Within Phase 2: T003 and T004 touch different files and can proceed in parallel; T005 must be
written and confirmed failing **before** T006 exists, or the negative cases prove nothing; T007
follows T006.

US1 and US2 both edit the same conditional block in `App.tsx` (see Sequencing note) — implement
sequentially even though they are separate, independently-testable stories.

## Parallel opportunities

- T002 with T003 — seed file vs. migration file, no shared dependency
- T005 with T008 — API contract tests vs. web client DTO
- T009 with T014 — both extend the same new spec file conceptually but assert independent
  scenarios; write together, run together
- T020 with T021 — independent audits

## Implementation strategy

**MVP = Phase 1 + Phase 2 + Phase 3.** That delivers the reported defect fix: a diagram-only
grantee can find and open their diagram. Phase 4 is what makes the home screen stop lying about
it, and per the spec is equally P1 — do not consider the MVP complete for release without it, even
though it is architecturally a separate, later phase.

**Do not stop at "the diagram appears."** T013's link-regression guard exists because the natural
instinct — every other project reference in this codebase is a real link — is exactly wrong here.
A green T012 with no T013 would ship the one disclosure feature 007 explicitly closed, one hop
removed.
