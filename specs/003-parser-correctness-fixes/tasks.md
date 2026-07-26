---
description: "Task list for feature implementation"
---

# Tasks: Mermaid Parser Correctness Fixes

**Input**: Design documents from `/specs/003-parser-correctness-fixes/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Included and REQUIRED, not optional. Constitution Principle IV ("Test-First for
Rendering & Export") is NON-NEGOTIABLE and applies to every parser change in this feature —
contract tests MUST be written and MUST fail before their implementation tasks.

**Organization**: Tasks are grouped by user story (spec.md priorities P1–P4). This feature adds
onto the existing monorepo from `001-diagramming-platform`/`002-editing-lifecycle-enhancements` —
no new workspace/package, and (per plan.md) no changes to `apps/api` at all.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no unmet dependencies)
- **[Story]**: Maps to US1–US4 from spec.md
- File paths follow the existing layout: `packages/diagram-core/`, `apps/web/`

---

## Phase 1: Setup

- [X] T001 Run the full existing test suite (`diagram-core`, `api`, `web` unit + E2E) to confirm a green baseline before making any change

---

## Phase 2: Foundational (Blocking Prerequisites)

**⚠️ CRITICAL**: Blocks User Stories 1, 2, and 3 (each needs its own new model field(s)). User
Story 4 (comments) needs no model changes and does not depend on this phase.

- [X] T002 Extend `DiagramModel` types per data-model.md: `DiagramNode.attributes?`, `DiagramEdge.arrow?`/`sequenceOrder?`, `DiagramContainer.role?`/`attachedNodeIds?`/`sequenceOrder?` (all optional, no behavior yet) in packages/diagram-core/src/model/diagram-model.ts

**Checkpoint**: New model fields exist — User Stories 1, 2, and 3 can now begin (independently of each other; each uses a disjoint subset of these fields and a different parser file).

---

## Phase 3: User Story 1 - Architecture Diagrams with Directional Connections (Priority: P1) 🎯 MVP

**Goal**: `-->` and `<--` connections in architecture (cloud infrastructure) diagrams import
successfully (currently a hard failure), with arrow direction and anchor hints preserved on
export.

**Independent Test**: Import an architecture diagram using `serviceA:R --> L:serviceB` and one
using `serviceA:R <-- L:serviceB`; both must import successfully, and re-exporting must preserve
which side carried the arrowhead.

### Tests for User Story 1 ⚠️

- [X] T003 [P] [US1] Contract test: `-->`/`<--`/`--` architecture edges (with/without `:T`/`:B`/`:L`/`:R` anchor hints on either side) parse and set `arrow` correctly; round-trip preserves arrow direction and hints; a diagram using only the pre-existing plain `--` form is unchanged in packages/diagram-core/tests/contract/architecture-arrowhead-edges.test.ts

### Implementation for User Story 1

- [X] T004 [US1] Extend the architecture edge grammar to accept `-->`/`<--`/`--` (each with optional anchor hints on either side), set `DiagramEdge.arrow` accordingly on parse, and emit the matching connector + hints on serialize (FR-001–FR-004; research.md §5) in packages/diagram-core/src/dsl/architecture.ts (depends on T002, T003)

**Checkpoint**: User Story 1 fully functional and independently testable — the architecture parser defect is fixed.

---

## Phase 4: User Story 2 - ER Diagrams with Attribute Blocks (Priority: P2)

**Goal**: ER entity attribute blocks (`ENTITY { type name PK/FK/UK }`) import successfully,
round-trip, and an unclosed attribute block produces a specific, structured error.

**Independent Test**: Import an ER diagram with an entity attribute block including `PK`/`FK`/`UK`
markers; confirm every attribute appears with its type/name/markers, and re-exporting preserves
them.

### Tests for User Story 2 ⚠️

- [X] T005 [P] [US2] Contract test: attribute-block parsing (type/name/PK/FK/UK, multiple markers, unrecognized keyword doesn't block import, trailing comment doesn't block import), round-trip preservation, unclosed-block structured error, and a diagram using only the pre-existing bare relationship form is unchanged in packages/diagram-core/tests/contract/erd-attributes.test.ts

### Implementation for User Story 2

- [X] T006 [US2] Extend the ER parser/serializer: parse an entity's attribute block into `DiagramNode.attributes`, preserve it on serialize, and track open/close of `{`/`}` to emit a structured error (identifying the entity and opening line) for an unclosed block (FR-005–FR-008, FR-018; research.md §4, §7) in packages/diagram-core/src/dsl/erd.ts (depends on T002, T005)

**Checkpoint**: User Stories 1 and 2 both independently functional.

---

## Phase 5: User Story 3 - Sequence Diagrams with Notes and Control-Flow Blocks (Priority: P3)

**Goal**: `Note left/right/over` and `loop`/`alt`/`opt`/`par`/`critical`/`break` blocks (nestable)
import successfully, render visibly on the canvas, and round-trip in their original order.

**Independent Test**: Import a sequence diagram with a `Note over` line and a `loop` containing
two messages; both must appear on the canvas, and re-exporting must reproduce the same note and
loop structure in the same order.

### Tests for User Story 3 ⚠️

- [X] T007 [P] [US3] Contract test: `Note left of`/`Note right of`/`Note over` (including 2+ participants) produce a `role: 'note'` container with correct `attachedNodeIds`; `loop`/`alt`/`else`/`opt`/`par`/`and`/`critical`/`option`/`break` produce correctly-nested containers with correct `role` and optional label; nesting to 2+ levels works; an unclosed block produces a structured error citing the block and its opening line; round-trip preserves exact interleaving order of messages/notes/blocks; a diagram using only the pre-existing bare `participant` + message form is unchanged in packages/diagram-core/tests/contract/sequence-notes-and-blocks.test.ts

### Implementation for User Story 3

- [X] T008 [US3] Extend the sequence parser: recognize `Note left of`/`Note right of`/`Note over` (arbitrary participant count for `over`, per clarification Q2), creating a `DiagramContainer` with `role: 'note'`, `attachedNodeIds`, and an explicit small `size` (not the generic 300×200 fallback) in packages/diagram-core/src/dsl/sequence.ts (depends on T002, T007)
- [X] T009 [US3] Extend the sequence parser: recognize `loop`/`alt`/`else`/`opt`/`par`/`and`/`critical`/`option`/`break` blocks with optional labels, nesting via `parentContainerId` to arbitrary depth (FR-011), assign each message/note/block a `sequenceOrder` in encounter order, and track open blocks to emit a structured unclosed-block error (FR-013) at end-of-input in packages/diagram-core/src/dsl/sequence.ts (depends on T008, same file)
- [X] T010 [US3] Extend the sequence serializer: emit notes and control-flow blocks (with correct nesting/branches/labels), sorting each scope's messages/notes/child-blocks by `sequenceOrder` before emitting, so the original interleaving is reproduced exactly (FR-012; research.md §3) in packages/diagram-core/src/dsl/sequence.ts (depends on T009, same file)
- [X] T011 [US3] E2E test: import a sequence diagram with a `Note over` (2 participants) and a `loop` wrapping two messages; confirm both appear as visible container elements on the canvas — no `apps/web` source change expected, confirming the existing generic container rendering already covers FR-017 (contracts/diagram-core-parser-contract.md "Canvas rendering") in apps/web/tests/e2e/import.spec.ts (depends on T010)

**Checkpoint**: User Stories 1–3 all independently functional.

---

## Phase 6: User Story 4 - Comments Ignored Consistently Across Every Diagram Type (Priority: P4)

**Goal**: `%%` comment lines are silently ignored in sequence, class/UML, ER, C4, and architecture
diagrams, matching the flowchart parser's existing (002) behavior.

**Independent Test**: Import a sequence, class, ER, C4, or architecture diagram containing a `%%`
comment line anywhere in the body; the import must succeed with the comment having no effect.

### Tests for User Story 4 ⚠️

- [X] T012 [P] [US4] Contract test: a `%%` comment line anywhere in the body is skipped (no effect on the parsed diagram) for each of the sequence, class/UML, ER, C4, and architecture parsers; a genuinely unrecognized line still produces its usual specific error in packages/diagram-core/tests/contract/comments-everywhere.test.ts

### Implementation for User Story 4

- [X] T013 [P] [US4] Add `%%` comment-line skip (matching flowchart's existing behavior) to packages/diagram-core/src/dsl/uml.ts (depends on T012; no other story touches this file)
- [X] T014 [P] [US4] Add `%%` comment-line skip to packages/diagram-core/src/dsl/c4.ts (depends on T012; no other story touches this file)
- [X] T015 [US4] Add `%%` comment-line skip to packages/diagram-core/src/dsl/erd.ts (depends on T012, and on T006 completing first — same file as User Story 2's implementation task)
- [X] T016 [US4] Add `%%` comment-line skip to packages/diagram-core/src/dsl/sequence.ts (depends on T012, and on T010 completing first — same file as User Story 3's implementation tasks)
- [X] T017 [US4] Add `%%` comment-line skip to packages/diagram-core/src/dsl/architecture.ts (depends on T012, and on T004 completing first — same file as User Story 1's implementation task)

**Checkpoint**: All four user stories independently functional — full spec scope delivered.

---

## Final Phase: Polish & Cross-Cutting Concerns

- [X] T018 Rebuild `packages/diagram-core` (`npm run build --workspace=@canvas/diagram-core`) and run the full regression suite (`diagram-core`, `api`, `web` unit + all E2E, including the opt-in perf test) to confirm no regression in 001/002's existing functionality
- [X] T019 Run this feature's quickstart.md manual validation end-to-end

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies.
- **Foundational (Phase 2)**: Depends on Setup — BLOCKS User Stories 1, 2, and 3 (User Story 4
  needs no model changes and is independent of it).
- **User Story 4**: Depends only on Setup for its own test/task; however its five per-file tasks
  each also depend on the *other* story that already touches the same file finishing first
  (T015 after T006, T016 after T010, T017 after T004) — a sequencing dependency, not a Foundational
  one. T013 (uml.ts) and T014 (c4.ts) have no such dependency.
- **Polish (Final Phase)**: Depends on all four user stories.

### Recommended Order

P1 → P2 → P3 → P4, matching spec.md priorities. Unlike feature 002, User Stories 1, 2, and 3 have
**no dependencies on each other** — each touches a different parser file and a disjoint set of
new model fields — so with multiple developers they could be built fully in parallel once
Foundational (T002) is done. User Story 4's tasks are the only ones with cross-story file
dependencies (see above), which is why it's sequenced last despite being independent in principle.

### Parallel Opportunities

- T003, T005, and T007 (the three story-specific contract tests) are parallel-safe with each
  other — three different files, all depending only on T002.
- Once Foundational (T002) is done, T004 (US1), T006 (US2), and T008 (US3, first of three
  sequential sequence.ts tasks) can all start in parallel — three different files.
- T013 and T014 (US4's uml.ts/c4.ts comment tasks) are parallel-safe with everything else in the
  feature — untouched by any other story.
- T009 and T010 (US3) are NOT parallel-safe with each other — same file, sequential edits.
- T015/T016/T017 (US4's erd.ts/sequence.ts/architecture.ts comment tasks) are parallel-safe with
  *each other* but each has its own same-file predecessor from another story (see Dependencies).

---

## Parallel Example: Foundational → User Stories 1–3

```bash
# After T002 (model field additions) lands:
Task: "Contract test in packages/diagram-core/tests/contract/architecture-arrowhead-edges.test.ts"
Task: "Contract test in packages/diagram-core/tests/contract/erd-attributes.test.ts"
Task: "Contract test in packages/diagram-core/tests/contract/sequence-notes-and-blocks.test.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1 (Setup) and Phase 2 (Foundational).
2. Complete Phase 3 (User Story 1).
3. **STOP and VALIDATE**: architecture diagrams with `-->`/`<--` connections import correctly,
   independent of US2–US4.

### Incremental Delivery

Setup + Foundational → US1 (architecture arrowheads) → US2 (ER attributes) → US3 (sequence
notes/blocks) → US4 (comments everywhere) → Polish. Each checkpoint is independently demoable.
Per the Parallel Opportunities above, US1/US2/US3 have no dependency on each other and could be
reordered or parallelized across developers without any rework — the P1→P4 order here follows
spec.md's severity-based prioritization, not a technical constraint.

---

## Notes

- `[P]` tasks touch different files with no unmet dependencies.
- Every parser task in this feature has its contract test written and failing before
  implementation, per Constitution IV.
- No `apps/api` changes are required anywhere in this feature (plan.md) — the import/diagram
  routes are already diagram-type-agnostic.
- No `apps/web` *source* changes are required — only the one E2E test (T011) confirming the
  existing generic canvas rendering already displays the new containers correctly.
- Commit after each task or logical group; stop at any checkpoint to validate a story in
  isolation before continuing.
