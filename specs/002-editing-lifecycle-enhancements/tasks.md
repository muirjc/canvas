---
description: "Task list for feature implementation"
---

# Tasks: Editing & Lifecycle Enhancements

**Input**: Design documents from `/specs/002-editing-lifecycle-enhancements/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Included and REQUIRED, not optional. Constitution Principle IV ("Test-First for
Rendering & Export") is NON-NEGOTIABLE and applies here to the flowchart-parser extensions
(US5) and the new `diagram-core` model operations (Foundational) — their contract tests MUST be
written and MUST fail before their implementation tasks.

**Organization**: Tasks are grouped by user story (spec.md priorities P1–P5). This feature adds
onto the existing monorepo from `001-diagramming-platform` — no new workspace/package.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no unmet dependencies)
- **[Story]**: Maps to US1–US5 from spec.md
- File paths follow the existing layout: `apps/web/`, `apps/api/`, `packages/diagram-core/`

---

## Phase 1: Setup

- [X] T001 Run the full existing test suite (`diagram-core`, `api`, `web` unit + E2E) to confirm a green baseline before making any change

---

## Phase 2: Foundational (Blocking Prerequisites)

**⚠️ CRITICAL**: Blocks User Story 1 and User Story 2 (both depend on this module). User
Stories 3, 4, and 5 do not depend on it and could start in parallel if staffed separately.

- [X] T002 [P] Contract test: `removeNode` (cascades to connected edges + emptied group), `removeEdge`, `updateNodeLabel`, `updateEdgeLabel` (including empty-string clear) in packages/diagram-core/tests/contract/diagram-ops.test.ts
- [X] T003 Implement `removeNode`, `removeEdge`, `updateNodeLabel`, `updateEdgeLabel` pure model operations in packages/diagram-core/src/model/diagram-ops.ts (depends on T002; export from packages/diagram-core/src/index.ts)

**Checkpoint**: `diagram-core` model operations ready — User Stories 1 and 2 can now begin.

---

## Phase 3: User Story 1 - Edit Labels on Shapes and Connectors (Priority: P1) 🎯 MVP

**Goal**: Renaming a shape and adding/editing/clearing a connector label both work directly on
the canvas, reflected immediately in the DSL.

**Independent Test**: Open any diagram, rename a shape, add a label to an unlabeled connector,
edit it, then clear it — confirm canvas and DSL match at every step.

### Tests for User Story 1 ⚠️

- [X] T004 [P] [US1] E2E test: rename a shape; add, edit, and clear a connector label; cancel an in-progress edit in apps/web/tests/e2e/edit-labels.spec.ts

### Implementation for User Story 1

- [X] T005 [US1] Add connector label editing (double-click a connector to edit its label inline, same interaction pattern as the existing shape-label edit) and route both shape- and connector-label edits through `diagram-core`'s `updateNodeLabel`/`updateEdgeLabel` in apps/web/src/canvas/Canvas.tsx (depends on T003)

**Checkpoint**: User Story 1 fully functional and independently testable.

---

## Phase 4: User Story 2 - Delete Shapes from the Canvas (Priority: P2)

**Goal**: Selected shapes can be deleted (with confirmation), taking their connectors with them
and auto-removing any group left empty.

**Independent Test**: Create a small diagram with a connected pair and a group; delete one
shape; confirm its connector, the shape, and (when applicable) the emptied group are all gone
from canvas and DSL, and that canceling the confirmation changes nothing.

### Tests for User Story 2 ⚠️

- [X] T006 [P] [US2] E2E test: delete an unconnected shape, delete a connected shape (connector disappears), multi-select delete, delete a group's last member (group disappears), cancel a pending confirmation in apps/web/tests/e2e/delete-shapes.spec.ts

### Implementation for User Story 2

- [X] T007 [P] [US2] Implement a small reusable confirmation UI (custom, not `window.confirm` — research.md §3) in apps/web/src/canvas/ConfirmDialog.tsx
- [X] T008 [US2] Implement shape selection deletion (Delete/Backspace key and an explicit button, multi-select aware) gated by `ConfirmDialog`, calling `diagram-core`'s `removeNode` in apps/web/src/canvas/Canvas.tsx (depends on T003, T007)

**Checkpoint**: User Stories 1 and 2 both independently functional.

---

## Phase 5: User Story 3 - Sign Out of the Application (Priority: P3)

**Goal**: A visible, always-reachable sign-out control ends the session from anywhere in the app.

**Independent Test**: Sign in, sign out from any screen, confirm you land on the sign-in screen
and that reloading a previously-open page requires signing in again.

### Tests for User Story 3 ⚠️

- [X] T009 [P] [US3] E2E test: sign-out control visible on main/editor/admin screens, ends session, subsequent page load requires sign-in in apps/web/tests/e2e/sign-out.spec.ts

### Implementation for User Story 3

- [X] T010 [P] [US3] Implement a persistent `AppShell` header component with a Sign Out control (calls the existing `api.logout()`) in apps/web/src/app/AppShell.tsx
- [X] T011 [US3] Wrap every authenticated view (main screen, diagram editor, admin pages) with `AppShell` in apps/web/src/app/App.tsx (depends on T010)

**Checkpoint**: User Stories 1–3 all independently functional.

---

## Phase 6: User Story 4 - Delete a Diagram (Priority: P4)

**Goal**: An owner or admin can soft-delete a diagram (with confirmation); it disappears
immediately for everyone, and an admin can restore it (metadata-only preview beforehand) within
a 30-day window, with both delete and restore attributable.

**Independent Test**: Delete a diagram as its owner; confirm it's gone from the project browser
for the owner and a collaborator it was shared with; confirm an admin sees only its metadata in
the deleted-diagrams list, then restores it and it's fully back for both.

### Tests for User Story 4 ⚠️

- [X] T012 [P] [US4] API contract test: `DELETE /diagrams/:id` (owner/admin-only, idempotent), `GET /admin/deleted-diagrams` (metadata-only fields, no dslContent), `POST /diagrams/:id/restore` (success within window, expired-window error, records restoredAt/restoredByUserId) in apps/api/tests/contract/diagram-delete-restore.test.ts
- [X] T013 [P] [US4] E2E test: owner deletes a diagram → gone from project browser for owner and a collaborator → admin sees metadata-only entry → restores it → fully accessible again in apps/web/tests/e2e/delete-restore-diagram.spec.ts

### Implementation for User Story 4

- [X] T014 [P] [US4] Migration adding `deleted_at`, `deleted_by_user_id`, `restored_at`, `restored_by_user_id` to `diagrams` in apps/api/migrations/0003_diagram_soft_delete.sql
- [X] T015 [P] [US4] Implement `requireDiagramOwnerOrAdmin` authorization check (ownership/admin, distinct from the existing view/comment/edit ladder — research.md §2) in apps/api/src/auth/access-control.middleware.ts
- [X] T016 [US4] Extend `getDiagram`/`searchDiagrams` (apps/api/src/diagrams/diagram.service.ts) and `getProjectTree` (apps/api/src/projects/project.service.ts) to exclude soft-deleted diagrams; add `deleteDiagram`, `restoreDiagram` (retention-window check), and `listDeletedDiagrams` (metadata-only projection) to apps/api/src/diagrams/diagram.service.ts (depends on T014)
- [X] T017 [US4] Implement `DELETE /diagrams/:id`, `POST /diagrams/:id/restore`, `GET /admin/deleted-diagrams` routes in apps/api/src/diagrams/diagram.routes.ts (depends on T015, T016)
- [X] T018 [US4] Add `deleteDiagram`, `listDeletedDiagrams`, `restoreDiagram` calls to the web API client in apps/web/src/app/api.ts (depends on T017)
- [X] T019 [US4] Add a per-diagram Delete action (gated by `ConfirmDialog`) to the project browser in apps/web/src/projects/ProjectBrowser.tsx (depends on T018, T007)
- [X] T020 [P] [US4] Implement the admin `DeletedDiagramsPage` (metadata-only list + Restore button) wired at `?admin=deleted` in apps/web/src/admin/DeletedDiagramsPage.tsx and apps/web/src/app/App.tsx (depends on T018)

**Checkpoint**: User Stories 1–4 all independently functional.

---

## Phase 7: User Story 5 - Broader Mermaid Flowchart DSL Compatibility (Priority: P5)

**Goal**: Importing a `graph`-header diagram with `style` directives and `%%` comments succeeds,
including the exact previously-failing example from the spec.

**Independent Test**: Import a diagram using `graph TD`, one or more `style` lines, and a `%%`
comment; confirm it imports successfully with styled nodes showing their specified colors.

### Tests for User Story 5 ⚠️

- [X] T021 [P] [US5] Contract test: `graph` header alias (TD/LR/TB/RL/BT) parses identically to `flowchart`, direction is preserved through round-trip, `%%` comment lines are ignored in packages/diagram-core/tests/contract/flowchart-graph-alias.test.ts
- [X] T022 [P] [US5] Contract test: `style <nodeId> fill:#hex,stroke:#hex` applies to the referenced node without failing the parse; a `style` line for a nonexistent node id is a no-op in packages/diagram-core/tests/contract/flowchart-style-directive.test.ts
- [X] T023 [US5] Extend the flowchart parser: accept `graph` as a header alias, skip `%%`-prefixed comment lines, two-pass `style`-directive application (fill→fillColor, stroke→strokeColor), and store the original direction (TD/LR/etc.) in front-matter for round-trip in packages/diagram-core/src/dsl/flowchart-parser.ts (depends on T021, T022)
- [X] T024 [US5] Update the flowchart serializer to emit the diagram's stored direction (fixing today's hardcoded `flowchart TD`) — still always emitting the canonical `flowchart` keyword regardless of whether the source used `graph` (research.md §5) — in packages/diagram-core/src/dsl/flowchart-serializer.ts (depends on T023)
- [X] T025 [P] [US5] Extend the import API contract test with `graph`/`style`/comment content in apps/api/tests/contract/import.test.ts (depends on T023, T024)
- [X] T026 [US5] Extend the import E2E test with the spec's exact previously-failing example (🚀 emoji labels, `graph TD`, pipe-labeled edges, three `style` lines) in apps/web/tests/e2e/import.spec.ts (depends on T023, T024)

**Checkpoint**: All five user stories independently functional — full spec scope delivered.

---

## Final Phase: Polish & Cross-Cutting Concerns

- [X] T027 [P] Extend the accessibility audit (axe-core) to cover `ConfirmDialog`, `AppShell`, and `DeletedDiagramsPage` in apps/web/tests/e2e/accessibility.spec.ts
- [X] T028 Run the full regression suite (`diagram-core`, `api`, `web` unit + all E2E, including opt-in perf tests) to confirm no regression in 001's existing functionality
- [X] T029 Run this feature's quickstart.md manual validation end-to-end

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies.
- **Foundational (Phase 2)**: Depends on Setup — BLOCKS User Stories 1 and 2 only (3, 4, 5 are
  independent of it).
- **User Stories 3, 4, 5**: Depend only on Setup; can start immediately in parallel with
  Foundational/US1/US2 if staffed separately.
- **User Story 4** additionally reuses US2's `ConfirmDialog` (T007) for its own delete
  confirmation — the one genuine cross-story dependency in this feature.
- **Polish (Final Phase)**: Depends on all five user stories.

### Recommended Order

P1 → P2 → P3 → P4 → P5, matching spec.md priorities. With multiple developers: US3 (sign-out)
and US5 (Mermaid compatibility) have no dependency on the Foundational phase or on each other and
can be built in parallel with US1/US2 from the start; only US4's `ConfirmDialog` reuse ties it to
US2 finishing T007 first.

### Parallel Opportunities

- T002 (Foundational test) is parallel-safe with nothing else in its phase (it's the only task
  before its own implementation).
- Once Foundational is done, US1 and US2 can both proceed; within US2, T007 (`ConfirmDialog`) is
  parallel-safe with T006 (E2E test).
- US3's T009/T010 are parallel-safe with each other and with all of US1/US2/US4/US5.
- US4's T012/T013/T014/T015 are all parallel-safe with each other (four different files, no
  interdependencies); T019 and T020 are parallel-safe with each other once T018 is done.
- US5's T021/T022 are parallel-safe; T025 is parallel-safe with T023/T024 in the sense of file
  location but functionally depends on them being correct first (listed sequential above to be
  safe).

---

## Parallel Example: User Story 4 (the largest story)

```bash
# Tests + independent infra together:
Task: "API contract test in apps/api/tests/contract/diagram-delete-restore.test.ts"
Task: "E2E test in apps/web/tests/e2e/delete-restore-diagram.spec.ts"
Task: "Migration in apps/api/migrations/0003_diagram_soft_delete.sql"
Task: "requireDiagramOwnerOrAdmin in apps/api/src/auth/access-control.middleware.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1 (Setup) and Phase 2 (Foundational).
2. Complete Phase 3 (User Story 1).
3. **STOP and VALIDATE**: label editing works end to end, independent of US2–US5.

### Incremental Delivery

Setup + Foundational → US1 (labels) → US2 (delete shapes) → US3 (sign-out) → US4
(delete/restore diagram) → US5 (Mermaid compatibility) → Polish. Each checkpoint is
independently demoable, and — per the Parallel Opportunities above — US3 and US5 could just as
easily be pulled forward if a second developer is available, since neither depends on the
Foundational phase.

---

## Notes

- `[P]` tasks touch different files with no unmet dependencies.
- The flowchart parser/serializer tasks (US5) have their contract tests written and failing
  before implementation, per Constitution IV.
- Commit after each task or logical group; stop at any checkpoint to validate a story in
  isolation before continuing.
