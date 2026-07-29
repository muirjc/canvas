---
description: "Task list for feature implementation"
---

# Tasks: Canvas Authoring & Admin Console

**Input**: Design documents from `/specs/006-authoring-admin-console/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Included and REQUIRED. Constitution Principle IV ("Test-First for Rendering & Export")
is NON-NEGOTIABLE and **applies to this feature** — containers are drawn by both the screen and
export renderers and round-trip through the DSL. Contract tests for the seven new `diagram-core`
operations and for container round-trip MUST be written and MUST fail before their implementation.
The axe-core WCAG gate and the 300-element canvas drag gate are build failures, not review
comments.

**Organization**: Tasks are grouped by user story (spec.md priorities P1–P5). Work spans all three
workspaces, but each story is confined to a small set of files.

**Reference documents**: `contracts/diagram-core-container-ops.md` specifies the seven operations
precisely; `contracts/api-standards-versions.md` specifies the standards and version surfaces.
Tasks below reference them rather than restating guarantees.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no unmet dependencies)
- **[Story]**: Maps to US1–US5 from spec.md
- File paths are relative to the repository root

---

## Phase 1: Setup

- [X] T001 Establish a green baseline before any change: run `npm run test --workspace=@canvas/diagram-core`, `npm run test --workspace=@canvas/api`, and `npx playwright test` in apps/web; record the passing counts to compare against at T029

---

## Phase 2: Foundational (Blocking Prerequisites)

**None required.** Unlike feature 005 — where a shared token layer blocked every story — the five
stories here have no common prerequisite: US1 touches only the admin shell, US2 the diagram model
and canvas, US4 the standards surface, US5 the version surface. Each can begin immediately after
Setup.

Two file-level couplings exist and are handled by ordering rather than by a foundational phase:
US2 and US3 both modify `apps/web/src/canvas/Canvas.tsx`, and US4 and US5 both modify
`apps/web/src/app/api.ts`. See Dependencies below.

---

## Phase 3: User Story 1 - Move around the admin console and read it (Priority: P1) 🎯 MVP

**Goal**: Every admin screen is centred and padded, offers navigation to every other admin
destination, and offers a route back to the diagrams.

**Independent Test**: Visit all five admin screens. Content is centred with margins; every other
destination and a route back to the diagrams is one click away; the current destination is
distinguishable; the axe audit still reports zero violations.

### Tests for User Story 1 ⚠️

- [X] T002 [P] [US1] E2E test in apps/web/tests/e2e/admin-console.spec.ts asserting for each of the five admin screens: content is horizontally centred with non-zero margins on both sides (FR-001), navigation to every other admin destination is present without scrolling (FR-002), a route back to the diagram list works without editing the URL (FR-003), the current destination is visually distinguishable (FR-004), and a non-admin user is still denied (FR-006)

### Implementation for User Story 1

- [X] T003 [US1] Create apps/web/src/ui/AdminShell.tsx — a centred page container plus a horizontal navigation bar beneath the global header carrying the five admin destinations and a "Back to diagrams" action, marking the active destination, per research §10 and docs/ui-design-spec.md's layout tokens; navigation is a landmark with ordinary links so it is keyboard-operable by default (FR-034)
- [X] T004 [US1] Wrap the admin routing branch in apps/web/src/app/App.tsx with `AdminShell` so all five screens are fixed at the routing site without editing apps/web/src/admin/* (depends on T003)
- [X] T005 [US1] Add any layout rules `AdminShell` needs to apps/web/src/styles/layout.css, reusing existing spacing and surface tokens rather than introducing new values (depends on T003)
- [X] T006 [US1] Run `npx playwright test tests/e2e/accessibility.spec.ts` in apps/web and confirm all 7 audited screens still report zero violations with the new navigation present (depends on T004)

**Checkpoint**: The admin console is readable and navigable. Shippable on its own, and it touches
no diagram code — zero risk to the canvas.

---

## Phase 4: User Story 2 - Organize a diagram with containers (Priority: P2)

**Goal**: Containers become first-class: created empty, named, moved with their contents, resized,
and populated by dragging shapes in and out. Deleting one releases its shapes.

**Independent Test**: Create an empty container, name it, drag two shapes in, move it and confirm
contents travel, resize it, drag one shape out, delete it and confirm every shape survives.

### Tests for User Story 2 ⚠️

- [X] T007 [P] [US2] Contract tests for all seven container operations in packages/diagram-core/tests/contract/diagram-ops.test.ts per contracts/diagram-core-container-ops.md — including that `addContainer` **always** produces a size, `moveContainer` preserves every member's relative position and cascades to child containers, `resizeContainer` moves nothing and changes no membership, `removeContainer` never removes nodes and re-parents child containers, and every operation is a no-op for an unknown id
- [X] T008 [P] [US2] Contract test in packages/diagram-core/tests/contract/container-round-trip.test.ts asserting `parse(serialize(model))` preserves container id, label, position, size, node membership, and nested structure — **including a container holding no nodes**, which is the case that fails if a container is ever written without a size (data-model.md invariant 1)
- [X] T009 [P] [US2] E2E test in apps/web/tests/e2e/containers.spec.ts covering the User Story 2 acceptance scenarios: create empty, rename and confirm it survives save/reopen, drag shapes in, move and confirm relative positions hold, resize and confirm nothing inside moves, shrink below contents and confirm nothing is ejected, drag a shape out, and delete and confirm every shape remains at its position

### Implementation for User Story 2

- [X] T010 [US2] Implement the seven container operations — `addContainer`, `updateContainerLabel`, `moveContainer`, `resizeContainer`, `assignNodeToContainer`, `removeNodeFromContainer`, `removeContainer` — in packages/diagram-core/src/model/diagram-ops.ts, following the module's existing pure/immutable/lenient conventions (depends on T007, T008)
- [X] T011 [US2] Extend the export-fidelity coverage in packages/diagram-core/tests/contract/render-svg.test.ts to assert containers, their names, and membership appear in exported SVG (FR-015, SC-009), **without modifying** packages/diagram-core/src/render/svg-renderer.ts (depends on T010)
- [X] T012 [US2] In apps/web/src/canvas/Canvas.tsx, add a "create container" action that calls `addContainer` with no shape selected, and relabel the existing group action to present it as creating a container — preserving the `group-selected` testid and its behaviour (FR-007, FR-016, research §12) (depends on T010)
- [X] T013 [US2] In apps/web/src/canvas/Canvas.tsx, make containers draggable via `moveContainer` and resizable via `resizeContainer`, rendering resize handles **only for the selected container** so the steady-state element count is unchanged (research §6); no shadow, filter, blur, or transition on containers or nodes (depends on T012)
- [X] T014 [US2] In apps/web/src/canvas/Canvas.tsx, resolve membership on drop by testing the dropped node's centre against container bounds and calling `assignNodeToContainer` or `removeNodeFromContainer`; membership must not change on resize (FR-011, FR-012, research §3) (depends on T013)
- [X] T015 [US2] In apps/web/src/canvas/Canvas.tsx, allow renaming a container inline using the same editing mechanism shapes already use, calling `updateContainerLabel` (FR-008) (depends on T014)
- [X] T016 [US2] In apps/web/src/canvas/Canvas.tsx, delete a container via `removeContainer` behind the existing confirmation, with copy stating the contained shapes will be **kept** (FR-013, FR-013a) (depends on T015)
- [X] T017 [US2] Add container selection and resize-handle rendering to apps/web/src/canvas/shapes.tsx — screen-only, never reaching the export path (research §7) (depends on T013)

**Checkpoint**: Containers are fully manipulable, round-trip cleanly, and appear correctly in
exports.

---

## Phase 5: User Story 3 - Discover how to edit a label (Priority: P3)

**Goal**: A visible affordance shows that a shape's or connector's label can be edited.

**Independent Test**: Someone unfamiliar with the product renames a shape using only what is
visible on screen, without being told the gesture.

### Tests for User Story 3 ⚠️

- [X] T018 [P] [US3] E2E test in apps/web/tests/e2e/label-affordance.spec.ts asserting the affordance appears on hover **and** on keyboard selection/focus for both a shape and a connector, that activating it opens the same inline editor (FR-019), and that the existing double-click gesture still works unchanged (FR-020)

### Implementation for User Story 3

- [X] T019 [US3] In apps/web/src/canvas/Canvas.tsx, add a visible edit affordance for shape and connector labels, revealed on hover and on selection/focus, activating the existing inline editor; use the `foreignObject` mechanism the inline editors already use, and give the control an accessible name so it does not fail the axe gate (FR-017, FR-018, research §11) (depends on T016 — same file as User Story 2)

**Checkpoint**: Label editing is discoverable without prior knowledge.

---

## Phase 6: User Story 4 - Tell standards apart and see their lifecycle (Priority: P4)

**Goal**: Standards carry a name and description, show their creation date, and record a
retirement date when they leave force.

**Independent Test**: Create a standard with a name and description, confirm both appear in the
list with its creation date, retire it, and confirm the retirement date is recorded and shown.

### Tests for User Story 4 ⚠️

- [X] T020 [P] [US4] Contract tests in apps/api/tests/contract/standards.test.ts per contracts/api-standards-versions.md: name and description are stored and returned, `createdAt` is always returned, `retiredAt` is returned only when retired, and — critically — `retired_at` is set by **both** retire paths, the explicit `retireStandard` **and** the supersession inside `publishStandard` (data-model.md lifecycle trap)

### Implementation for User Story 4

- [X] T021 [US4] Write and apply migration apps/api/migrations/0005_standard_metadata.sql adding `name`, `description`, and `retired_at` to `standards`, backfilling existing rows with a name derived from diagram type and version so no stored standard is nameless (FR-026, SC-006); apply to both the `canvas` and `canvas_test` databases (depends on T020)
- [X] T022 [US4] In apps/api/src/standards/standard.service.ts, carry `name`/`description`/`retiredAt` through the record mapper, and set `retired_at = now()` in **both** places that write `status='retired'` — `retireStandard` and the supersession update inside `publishStandard`'s transaction — without overwriting an existing retirement date (depends on T021)
- [X] T023 [US4] Accept and return the new fields in apps/api/src/standards/standard.routes.ts and add them to the client methods in apps/web/src/app/api.ts (depends on T022)
- [X] T024 [US4] In apps/web/src/admin/StandardsEditor.tsx, add name and description inputs to standard creation and show name, creation date, and retirement date (only when retired) in the standards list (FR-021 to FR-025, FR-027) (depends on T023)
- [X] T025 [P] [US4] E2E test in apps/web/tests/e2e/standards-metadata.spec.ts: create a named standard with a description, confirm both appear with the creation date, retire it and confirm the retirement date shows, and confirm a standard retired by **publishing a newer one** also shows a retirement date (depends on T024)

**Checkpoint**: Standards are identifiable and their lifecycle is visible.

---

## Phase 7: User Story 5 - Find a specific version in a long history (Priority: P5)

**Goal**: Version history shows the five most recent by default, with search to reach older ones.

**Independent Test**: On a diagram with more than five versions, confirm five are listed, search
for an older one, and restore it.

### Tests for User Story 5 ⚠️

- [X] T026 [P] [US5] Contract tests in apps/api/tests/contract/versions.test.ts per contracts/api-standards-versions.md: the default response is capped at 5 regardless of how many versions exist, a diagram with five or fewer returns all with no "more exist" signal, a search term matching an older version returns it, an unmatched search returns an empty result rather than an error, and access control is unchanged

### Implementation for User Story 5

- [X] T027 [US5] In apps/api/src/diagrams/version.service.ts add an optional limit (defaulting to 5) and an optional search term matching version number and creation date to the listing query, and return whether more versions exist beyond those returned; expose both as optional query parameters in apps/api/src/diagrams/version.routes.ts (FR-028 to FR-030, research §9) (depends on T026)
- [X] T028 [US5] Add the query parameters to the version client method in apps/web/src/app/api.ts and update apps/web/src/projects/VersionHistory.tsx to show the capped list, indicate that older versions exist, offer search, keep restore working for a searched version, and show an explicit "no matches" state (FR-029 to FR-032) (depends on T027, and on T023 — same file, apps/web/src/app/api.ts)
- [X] T029 [P] [US5] E2E test in apps/web/tests/e2e/version-search.spec.ts: save a diagram more than five times, confirm only five are listed and that older ones are evidently available, search for an older version and restore it, and confirm an unmatched search says so (depends on T028)

**Checkpoint**: All five user stories complete.

---

## Phase 8: Polish & Cross-Cutting Concerns

- [X] T030 [P] Confirm `git diff --stat main -- packages/diagram-core/src/render/` is empty, proving container appearance and the export renderer were not modified (research §7, SC-009)
- [X] T031 [P] Verify an empty container survives a save/reopen cycle at its original position by hand, as a second check on the size invariant that the T008 contract test covers (data-model.md invariant 1)
- [X] T032 Run the full regression suite and confirm counts match the T001 baseline: `npm run test --workspace=@canvas/diagram-core`, `npm run test --workspace=@canvas/api`, and in apps/web `npx playwright test` followed by `RUN_PERF_TESTS=1 npx playwright test tests/e2e/canvas-performance.spec.ts` — the performance run must be exercised on a diagram that **contains containers**, not nodes alone (SC-010)
- [X] T033 Walk specs/006-authoring-admin-console/quickstart.md end to end at a 1440×900 window, including the supersession-retirement check and the empty-container round-trip trap

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (Phase 1)**: no dependencies.
- **Foundational (Phase 2)**: none exists — see the note in that phase. All five stories may begin
  after Setup.
- **User Stories 1, 2, 4, 5**: mutually independent. US1 touches the admin shell, US2 the diagram
  model and canvas, US4 the standards surface, US5 the version surface.
- **User Story 3**: depends on User Story 2 only because both modify
  `apps/web/src/canvas/Canvas.tsx`. There is no logical dependency — if US2 were dropped, US3
  would stand alone unchanged.
- **User Story 5**: T028 shares `apps/web/src/app/api.ts` with US4's T023, so those two must be
  ordered relative to each other even though the stories are otherwise unrelated.
- **Polish (Phase 8)**: depends on everything.

### Recommended order

Setup → US1 → US2 → US3 → US4 → US5 → Polish, matching spec.md priorities. US1 leads because it is
a defect fix that stands alone and carries no risk to diagram code.

### Parallel opportunities

- **US2 tests**: T007, T008, and T009 are all parallel-safe — three different files, none
  depending on the others.
- **Across stories**: US1, US2, US4, and US5 could proceed concurrently by different people. Only
  the two file-level couplings above constrain that.
- **US4**: T020 (contract test) and T025 (E2E) are parallel-safe with each other's phase-mates.
- **Polish**: T030 and T031 are parallel-safe; T032 and T033 are sequential and last.
- **Not parallel**: T012 through T017 all modify `apps/web/src/canvas/Canvas.tsx` (and
  `shapes.tsx` for T017) and must run in order.

---

## Parallel Example: User Story 2 tests

```bash
# Three independent test files, all written before any implementation (Constitution IV):
Task: "Container operation contract tests in packages/diagram-core/tests/contract/diagram-ops.test.ts"
Task: "Container round-trip contract test in packages/diagram-core/tests/contract/container-round-trip.test.ts"
Task: "Container E2E scenarios in apps/web/tests/e2e/containers.spec.ts"
```

---

## Implementation Strategy

### MVP scope

**Setup + User Story 1** (T001–T006) is a complete, shippable increment. It fixes a live defect —
admin screens rendering flush against the window edge with no way back to the diagrams — touches
no diagram code at all, and therefore carries **zero risk to the canvas or to exports**.

### Where the risk actually is

Almost all of this feature's risk sits in **User Story 2**, and specifically in two places:

1. **The size invariant.** A container written without a `size` is silently dropped from the DSL
   front-matter and loses its position on the next parse. T008 is the test that catches it; T031
   is the manual second check. If an empty container ever fails to reappear after reload, this is
   why.
2. **The two renderers.** Containers are drawn by both the canvas and the export renderer. T030
   asserts the export renderer was never touched — if that diff is non-empty, a task went out of
   scope and exports may no longer match the canvas.

### Gates to watch

- **axe (T006, T032)**: most likely failure is the new label affordance lacking an accessible
  name, or being reachable by hover only.
- **Performance (T032)**: most likely failure is resize handles rendered for every container
  rather than only the selected one, or an effect applied to containers during drag.
- **Standards retirement (T020)**: most likely failure is setting `retired_at` in
  `retireStandard` but not in `publishStandard`'s supersession path — the more common path in
  practice.
