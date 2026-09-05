---
description: "Task list for feature implementation"
---

# Tasks: AI Chat Diagram-Type and Persona-Scoped Knowledge Grounding

**Input**: Design documents from `/specs/010-ai-diagram-knowledge/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Included and REQUIRED, not optional. Constitution Principle IV ("Test-First for
Rendering & Export") is NON-NEGOTIABLE and applies to the 6 new `diagram-core` operations and the
AI tool-calling behavior — contract tests MUST be written and MUST fail before their
implementation tasks. All AI-path tests (contract and E2E) run against the AI SDK's mock test
provider (research.md §5) — deterministic, no API key, no network call.

**Organization**: Tasks are grouped by user story (spec.md priorities P1/P1/P2/P2). This feature
extends the existing `packages/diagram-core`, `apps/api/src/ai/`, `apps/web/src/ai/` surface 004
already established — no new workspace/package/directory.

**Note**: Renumbered 2026-08-10 following `/speckit.analyze` (G1/G2/G3 remediation) — a new T020
was inserted into User Story 2 (Principle II regression coverage), shifting every task from the
former T020 onward up by one. T009 and T024 also gained an additional assertion each (G2, G1).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no unmet dependencies)
- **[Story]**: Maps to US1–US4 from spec.md
- File paths follow the existing layout.

---

## Phase 1: Setup

- [X] T001 Run the full existing test suite (`diagram-core`, `api`, `web` unit + E2E) to confirm a green baseline before making any change. No new dependencies to install (plan.md Technical Context — this feature adds no new package).

---

## Phase 2: Foundational (Blocking Prerequisites)

**⚠️ CRITICAL**: Blocks all four user stories — every one of them requires AI chat to correctly
resolve and use a diagram's real `dslFamily` and to construct its system prompt with a
family-aware primer to be independently testable at all.

- [X] T002 [P] Contract test: `sendChatMessage` uses the `dslFamily` passed to it (not a hardcoded literal) to parse/serialize the diagram in apps/api/tests/contract/diagram-chat.test.ts (extend)
- [X] T003 Fix the hardcoded flowchart family: `diagram-chat.routes.ts`'s POST handler calls the existing `getDiagram(id)` and passes its `dslFamily` through; `SendChatMessageInput` gains a required `dslFamily` field; `sendChatMessage` calls `getDslFamily(input.dslFamily)` instead of `getDslFamily('flowchart')!` in apps/api/src/ai/diagram-chat.routes.ts and apps/api/src/ai/diagram-chat.service.ts (depends on T002)
- [X] T004 [P] Contract test: `createDiagramTools(context, family)` returns the existing 8 tools, behaviorally unchanged, for every one of the 6 families (regression) in apps/api/tests/contract/diagram-tools.test.ts (NEW)
- [X] T005 Add a required `family` parameter to `createDiagramTools` in apps/api/src/ai/diagram-tools.ts — signature change only at this point, no new tools yet (depends on T004)
- [X] T006 Update `diagram-chat.service.ts` to call `createDiagramTools(context, input.dslFamily)` (depends on T003, T005)
- [X] T007 [P] Write the 6 per-family domain-concept primers (flowchart, c4, sequence, erd, uml, architecture — content per data-model.md's `DiagramTypePrimer` section) in apps/api/src/ai/diagram-type-primers.ts (NEW)
- [X] T008 Wire primer text into the system-prompt composition order — persona `systemPrompt` → family primer → `describeModel()`'s existing summary (US4 inserts reference material between primer and summary later) — in apps/api/src/ai/diagram-chat.service.ts (depends on T006, T007)

**Checkpoint**: AI chat correctly reads/writes every diagram type and grounds its system prompt
with a family-appropriate primer, using the existing (unexpanded) tool set. User Story 1's
independent test criterion is satisfiable from here.

---

## Phase 3: User Story 1 - AI chat works correctly on every diagram type (Priority: P1) 🎯 MVP

**Goal**: A chat request against any of the 6 supported diagram types is correctly read and
written — no diagram type errors out or is misread as a different type.

**Independent Test**: Open an existing ER diagram's chat panel, ask it to rename an entity,
confirm success with no error and no corruption of the rest of the diagram.

### Tests for User Story 1 ⚠️

- [X] T009 [P] [US1] Contract test: `POST /diagrams/:id/chat/messages` against a real diagram of each of the 5 non-flowchart families succeeds on a simple rename request, and the diagram's saved content remains valid, type-appropriate syntax for its own family; a user with only view-level access is denied identically (403) regardless of diagram family, confirming FR-011's access-control parity across diagram types; in apps/api/tests/contract/diagram-chat.test.ts (extend)
- [X] T010 [P] [US1] E2E test (mock provider): open an ER diagram's chat panel, rename an entity via chat, confirm success and that the rest of the diagram is untouched in apps/web/tests/e2e/ai-chat-non-flowchart.spec.ts (NEW)

### Implementation for User Story 1

No new implementation beyond Phase 2 — this story's independent test criterion is satisfied by
the Foundational-phase fix. This phase exists to prove that with dedicated coverage, per
Constitution IV (tests before/alongside the change they validate, not skipped because "nothing
new to build").

**Checkpoint**: User Story 1 fully functional and independently testable.

---

## Phase 4: User Story 2 - AI-driven edits use each diagram type's real structure (Priority: P1)

**Goal**: Requests that only make sense for a specific diagram type (an ER attribute, a UML
member/relationship, a C4 role, a sequence message/activation, an architecture group) actually
produce that correct structure, not a generic labeled box.

**Independent Test**: On an open UML class diagram, ask the chat to "add a class Order with a
private id field and a public place() method," confirm the resulting class shows a properly
structured member, not a plain rectangle.

### Tests for User Story 2 ⚠️

- [X] T011 [P] [US2] Contract test: `updateNodeRole` sets `role`, no-ops on a missing id, leaves every other field untouched in packages/diagram-core/tests/contract/diagram-ops.test.ts (extend)
- [X] T012 [P] [US2] Contract test: `updateEntityAttributes` replaces `attributes` wholesale (including clearing via `[]`), no-ops on a missing id, same file
- [X] T013 [P] [US2] Contract test: `updateClassMembers` replaces `members` wholesale, no-ops on a missing id, same file
- [X] T014 [P] [US2] Contract test: `updateEdgeRelationKind` merge-patches `umlRelationKind`/`sourceCardinality`/`targetCardinality`, no-ops on a missing id, same file
- [X] T015 [P] [US2] Contract test: `updateEdgeArrowStyle` merge-patches `arrow`/`lineStyle`, no-ops on a missing id, same file
- [X] T016 [P] [US2] Contract test: `addPointMarkerContainer` appends an `activate`/`deactivate` container matching `sequence.ts`'s own parsed shape (round-trips identically), same file

### Implementation for User Story 2 (operations)

- [X] T017 [US2] Implement `updateNodeRole`, `updateEntityAttributes`, `updateClassMembers`, `updateEdgeRelationKind`, `updateEdgeArrowStyle`, `addPointMarkerContainer` in packages/diagram-core/src/model/diagram-ops.ts, exported from packages/diagram-core/src/index.ts (depends on T011–T016)

### Tests for User Story 2 (tools) ⚠️

- [X] T018 [P] [US2] Contract test (mock provider): `setNodeRole` offered only on c4/sequence; `setEntityAttributes` only on erd; `setClassMembers`/`setRelationshipKind` only on uml; `setConnectorStyle` on sequence/flowchart; `groupIntoContainer` on architecture/c4/uml/sequence; `activateParticipant`/`deactivateParticipant` only on sequence — each tool's `execute` produces the correct mutation and a not-found outcome on a missing id, in apps/api/tests/contract/diagram-tools.test.ts (extend)

### Implementation for User Story 2 (tools)

- [X] T019 [US2] Implement `setNodeRole`, `setEntityAttributes`, `setClassMembers`, `setRelationshipKind`, `setConnectorStyle`, `groupIntoContainer` (wrapping existing `addContainer`+`assignNodeToContainer`), `activateParticipant`, `deactivateParticipant` tools with family-conditional availability in apps/api/src/ai/diagram-tools.ts (depends on T017, T018, T005)

### Constitution regression coverage for User Story 2

- [X] T020 [US2] Contract test: an AI-set entity attribute, class member, node role, or relationship-kind value that violates the diagram's active standard is flagged by the existing `computeValidation` path identically to the same value set manually (Constitution Principle II — no bypass for AI-tool-driven mutations) in apps/api/tests/contract/diagram-chat.test.ts (extend) (depends on T019)
- [X] T021 [US2] Widen `addNode`'s `shape` parameter from the hardcoded `FLOWCHART_SHAPES` enum to the family-appropriate `NodeShape` subset per family (confirmed against each family's own `dsl/*.ts` parser, not assumed) in apps/api/src/ai/diagram-tools.ts (depends on T019)

### E2E for User Story 2

- [X] T022 [P] [US2] E2E test (mock provider) covering the spec's 6 acceptance scenarios: ER attribute add, UML class+relationship add, C4 role add, sequence message+activation, architecture service grouping, and a flowchart-only-concept request being declined with an explanation on a diagram type it doesn't apply to, in apps/web/tests/e2e/ai-chat-non-flowchart.spec.ts (extend T010's file) (depends on T021)

**Checkpoint**: User Stories 1 AND 2 both work independently — the core value of this feature is
delivered.

---

## Phase 5: User Story 3 - AI suggestions stay valid as the diagram grammar evolves (Priority: P2)

**Goal**: A diagram type's grammar changing elsewhere in the codebase is automatically reflected
in AI chat's grounding, with no separate hand-maintained copy to forget.

**Independent Test**: After a diagram-type grammar gains new syntax elsewhere in the codebase (no
special action taken for this feature), confirm AI chat's grounding for that diagram type reflects
the addition without a separate manual content update.

### Tests for User Story 3 ⚠️

- [X] T023 [P] [US3] Contract test (drift guard, research.md §6): for each family, every enum value currently exposed by that family's tool set (read from each tool's own Zod schema at test time, not hand-copied into the test) is mentioned somewhere in that family's primer text in apps/api/tests/contract/diagram-type-primers.test.ts (NEW) (depends on T007, T019)

### Implementation for User Story 3

- [X] T024 [US3] If T023 fails against the primer wording drafted in T007, revise `diagram-type-primers.ts`'s prose until every currently-exposed enum value is covered (depends on T023)

**Checkpoint**: All three of Stories 1–3 work independently; the anti-drift guard from FR-005 is
enforced by a real, automated test, not a documentation promise.

---

## Phase 6: User Story 4 - A persona brings its own relevant reference material into the conversation (Priority: P2)

**Goal**: An admin attaches one or more reference-material entries to a persona, each optionally
scoped to specific diagram type(s); only entries relevant to the currently-open diagram type (or
unscoped entries) are drawn on.

**Independent Test**: As an admin, attach a reference-material entry scoped to cloud-architecture
diagrams to a Technical Architect persona; confirm it surfaces in a chat on a matching diagram
type and not on a non-matching one, using the same persona.

### Tests for User Story 4 ⚠️

- [X] T025 [P] [US4] Contract test: create/list/edit/delete `ai_persona_reference_material` entries; `content` must be non-empty (400 otherwise); `diagramFamilies` values must be valid registered family ids (400 otherwise); admin-only; editing or deleting an entry leaves every existing `chat_messages` row byte-identical (FR-009's "existing history unaffected" clause); in apps/api/tests/contract/persona-reference-material.test.ts (NEW)
- [X] T026 [P] [US4] Contract test (mock provider): `sendChatMessage`'s system prompt includes only reference-material entries scoped to the current `dslFamily` or unscoped, composed after the family primer and before `describeModel()`'s summary, never ahead of or replacing the persona's own `systemPrompt`; a persona with no matching entries behaves identically to before this feature in apps/api/tests/contract/diagram-chat.test.ts (extend)

### Implementation for User Story 4

- [X] T027 [US4] Write migration `ai_persona_reference_material` (id, persona_id FK, content, diagram_families TEXT[], created_at, updated_at) per data-model.md in apps/api/migrations/0010_ai_persona_reference_material.sql (apply to both `canvas` and `canvas_test` databases)
- [X] T028 [US4] Implement `persona-reference-material.service.ts` (CRUD + family-id validation, mirroring `InvalidPersonaCategoryError`'s existing pattern) in apps/api/src/ai/ (depends on T027, T025)
- [X] T029 [US4] Implement `persona-reference-material.routes.ts` (`GET`/`POST /admin/ai-personas/:id/reference-material`, `PATCH`/`DELETE /admin/ai-personas/:personaId/reference-material/:entryId`, admin-only) per contracts/api-ai-chat-contract.md in apps/api/src/ai/ (depends on T028)
- [X] T030 [US4] Register the new route module in apps/api/src/app.ts (depends on T029)
- [X] T031 [US4] Wire reference-material fetching and composition into `diagram-chat.service.ts`'s system-prompt assembly (depends on T026, T030, T008)
- [X] T032 [US4] Add reference-material client calls to apps/web/src/app/api.ts (depends on T030)
- [X] T033 [US4] Extend `PersonaAdminPage.tsx` with reference-material entry CRUD UI (add/edit/remove, diagram-family scoping checkboxes), reusing the existing card/field patterns (canvas-23t.1 precedent) in apps/web/src/ai/PersonaAdminPage.tsx (depends on T032)
- [X] T034 [P] [US4] E2E test: attach a family-scoped entry, confirm it surfaces on a matching-family diagram and not on a non-matching one using the same persona; confirm non-admin users cannot reach the reference-material controls, in apps/web/tests/e2e/ai-persona-reference-material.spec.ts (NEW) (depends on T033, T031)

**Checkpoint**: All four user stories are independently functional.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [X] T035 [P] Run the full quickstart.md manual validation across all 4 stories
- [~] T036 Manual live-provider validation (SC-002): with a real AI provider configured, exercise User Story 2 against at least one non-flowchart diagram type (e.g. ERD or C4) and confirm the generated structure is correct — following 004's own T033 precedent (research.md §5); document the result in the shipping PR/CLAUDE.md entry — BLOCKED: the dev environment's `ANTHROPIC_API_KEY` is rejected by Anthropic as invalid (confirmed via a real live request, `{"error":"API key is invalid."}`); not something fixable from within this session. Outstanding pending a working key — see CLAUDE.md's Recent Changes entry.
- [X] T037 [P] Update CLAUDE.md's Recent Changes with the final implementation summary, replacing the spec/plan-only entry already there
- [X] T038 Run full regression: `packages/diagram-core`, `apps/api`, `apps/web` test suites, `tsc --noEmit`, `eslint`, and a clean build across all three workspaces

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies.
- **Foundational (Phase 2)**: Depends on Setup — BLOCKS all 4 user stories.
- **User Story 1 (Phase 3)**: Depends on Foundational only. Delivers the MVP slice.
- **User Story 2 (Phase 4)**: Depends on Foundational. Independent of US1's own tasks (no shared
  files beyond what Foundational already touched) but is what most of this feature's value comes
  from — recommended to do immediately after US1, not deferred.
- **User Story 3 (Phase 5)**: Depends on Foundational (T007) and US2 (T019, since the drift guard
  reads the tool schemas US2 creates). Cannot start before US2's T019.
- **User Story 4 (Phase 6)**: Depends on Foundational (T008) only for its own independent test —
  does not depend on US2 or US3.
- **Polish (Phase 7)**: Depends on all four user stories being complete.

### Within Each User Story

- Tests MUST be written and FAIL before their implementation task (Constitution IV).
- `diagram-core` operations (US2) before the AI tools that wrap them.
- Tools before the E2E tests that exercise them through the full chat flow.
- Tools before the Constitution Principle II regression test (T020), since it exercises the new
  tools' effect on the existing standards-validation path.

### Parallel Opportunities

- T002 and T004 (Foundational tests) can run in parallel.
- T007 (primers) can run in parallel with T002–T006 (dslFamily fix) — different files.
- All of T011–T016 (US2 operation contract tests) can run in parallel — same file, but
  independent test cases with no shared mutable state (standard Vitest parallelism within a file).
- T009 and T010 (US1 tests) can run in parallel.
- T025 and T026 (US4 tests) can run in parallel.
- User Story 4 (Phase 6) can be staffed in parallel with User Stories 2/3 (Phases 4/5) once
  Foundational is complete — it touches an entirely disjoint set of files (`persona-reference-material.*`,
  `PersonaAdminPage.tsx`) from US2/US3's `diagram-ops.ts`/`diagram-tools.ts`/`diagram-type-primers.ts`.

---

## Parallel Example: User Story 2

```bash
# Launch all operation contract tests together:
Task: "Contract test for updateNodeRole in packages/diagram-core/tests/contract/diagram-ops.test.ts"
Task: "Contract test for updateEntityAttributes in packages/diagram-core/tests/contract/diagram-ops.test.ts"
Task: "Contract test for updateClassMembers in packages/diagram-core/tests/contract/diagram-ops.test.ts"
Task: "Contract test for updateEdgeRelationKind in packages/diagram-core/tests/contract/diagram-ops.test.ts"
Task: "Contract test for updateEdgeArrowStyle in packages/diagram-core/tests/contract/diagram-ops.test.ts"
Task: "Contract test for addPointMarkerContainer in packages/diagram-core/tests/contract/diagram-ops.test.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup.
2. Complete Phase 2: Foundational (delivers the actual fix — US1's own phase is verification).
3. Complete Phase 3: User Story 1.
4. **STOP and VALIDATE**: non-flowchart diagrams no longer error out in chat.
5. Deploy/demo if ready — this alone closes the confirmed live bug (research.md §1).

### Incremental Delivery

1. Setup + Foundational + US1 → MVP: AI chat works on every diagram type.
2. Add US2 → the actual requested value: type-correct structured edits, with standards
   enforcement confirmed to still apply (T020).
3. Add US3 → the anti-drift guarantee becomes enforced, not just designed.
4. Add US4 → persona-scoped reference material, independently deliverable at any point after
   Foundational (can be done in parallel with US2/US3 by a second developer).

### Parallel Team Strategy

1. Team completes Setup + Foundational together (blocks everything).
2. Once Foundational is done: Developer A takes US2 → US3 (sequential, US3 depends on US2's
   tools); Developer B takes US4 independently.

---

## Notes

- [P] tasks = different files (or independent test cases within one file), no unmet dependencies.
- [Story] label maps task to specific user story for traceability.
- Verify each test fails before implementing against it (Constitution IV).
- Commit after each task or logical group.
- Stop at any checkpoint to validate a story independently.
