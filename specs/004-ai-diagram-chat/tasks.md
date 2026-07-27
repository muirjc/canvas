---
description: "Task list for feature implementation"
---

# Tasks: AI-Assisted Diagram Chat

**Input**: Design documents from `/specs/004-ai-diagram-chat/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Included and REQUIRED, not optional. Constitution Principle IV ("Test-First for
Rendering & Export") is NON-NEGOTIABLE and applies to the new `diagram-core` operations
(`addNode`/`addEdge`) and the AI tool-calling behavior — contract tests MUST be written and MUST
fail before their implementation tasks. All AI-path tests (contract and E2E) run against the AI
SDK's mock test provider (research.md §8) — deterministic, no API key, no network call.

**Organization**: Tasks are grouped by user story (spec.md priorities P1–P4). This feature adds
onto the existing monorepo from 001–003 — no new workspace/package. A new `src/ai/` directory is
introduced in both `apps/api` and `apps/web` (plan.md's Project Structure).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no unmet dependencies)
- **[Story]**: Maps to US1–US4 from spec.md
- File paths follow the existing layout: `packages/diagram-core/`, `apps/api/`, `apps/web/`

---

## Phase 1: Setup

- [X] T001 Run the full existing test suite (`diagram-core`, `api`, `web` unit + E2E) to confirm a green baseline before making any change
- [X] T002 Add `ai`, `@ai-sdk/anthropic`, `@ai-sdk/openai`, and `zod` to apps/api/package.json and run `npm install`

---

## Phase 2: Foundational (Blocking Prerequisites)

**⚠️ CRITICAL**: Blocks User Stories 1 and 2 (both need the schema, the shared `diagram-core`
operations, the AI provider module, and the ai-settings gate). User Stories 3 and 4 depend only
on artifacts US1 produces, not directly on this phase.

- [X] T003 Write and apply migration `ai_personas`, `diagram_chats`, `chat_messages`, `ai_settings` (singleton row, `chatEnabled` defaulting to `false`) per data-model.md in apps/api/migrations/0004_ai_chat.sql (apply to both `canvas` and `canvas_test` databases)
- [X] T004 [P] Contract test: `addNode` (default label/shape, auto-position, all other model fields untouched) and `addEdge` (source/target/optional label, no existence validation) in packages/diagram-core/tests/contract/diagram-ops.test.ts (extend 002's existing file)
- [X] T005 Implement `addNode` and `addEdge` in packages/diagram-core/src/model/diagram-ops.ts, exported from packages/diagram-core/src/index.ts (depends on T004)
- [X] T006 Refactor the canvas's manual "Add Shape" button and connect-mode gesture to call the new shared `addNode`/`addEdge` instead of building node/edge objects inline, in apps/web/src/canvas/Canvas.tsx (depends on T005; confirms manual-UI behavior is unchanged — research.md §2)
- [X] T007 Implement the AI provider selection module — `getLanguageModel()` resolves `AI_PROVIDER=anthropic|openai` and each provider's API key from env — in apps/api/src/ai/provider.ts (depends on T002; test injection of `MockLanguageModelV4` happens at the service-function level, research.md §8, not inside this module)
- [X] T008 [P] Contract test: `ai_settings` defaults to `chatEnabled: false`; only an admin can change it; the change is visible to a fresh request immediately (no caching) in apps/api/tests/contract/ai-settings.test.ts
- [X] T009 Implement `ai-settings.service.ts` (singleton get/set) and `ai-settings.routes.ts` (`GET`/`PATCH /admin/ai-settings`, admin-only) in apps/api/src/ai/ (depends on T008, T003)

**Checkpoint**: Schema, shared model operations, AI provider module, and the settings gate all exist — User Stories 1 and 2 can now begin.

---

## Phase 3: User Story 1 - Create a Flowchart Diagram from a Natural-Language Description (Priority: P1) 🎯 MVP

**Goal**: Pick a persona, describe a diagram in natural language, get back a populated flowchart
diagram open in the canvas editor.

**Independent Test**: Select a persona, describe a simple process, confirm a flowchart diagram
with corresponding shapes/connectors opens in the canvas editor.

### Tests for User Story 1 ⚠️

- [X] T010 [P] [US1] Contract test: `GET /ai-personas` returns only `active` personas, grouped by category in apps/api/tests/contract/ai-persona.test.ts
- [X] T011 [P] [US1] Contract test (mock provider): each of the 6 tools (add/remove node, add/remove edge, update node/edge label) produces the correct model mutation; a tool call referencing a nonexistent id returns a `{ applied: false, reason }` outcome without mutating the model (FR-014, research.md §6); `POST /diagrams/:id/chat/messages` creates a `DiagramChat` with the given `personaId` on the first message only (FR-008a) and ignores/rejects `personaId` on later messages; requires `edit`-level diagram access (FR-016); returns 503 with a specific message when `ai_settings.chatEnabled` is `false` (FR-020) in apps/api/tests/contract/diagram-chat.test.ts

### Implementation for User Story 1

- [X] T012 [US1] Implement `persona.service.ts` (`listActivePersonas`, grouped by category) and `persona.routes.ts` (`GET /ai-personas`) in apps/api/src/ai/ (depends on T010, T003)
- [X] T013 [US1] Seed one default `AiPersona` per architect category (Business/Enterprise/Solution/Technical) in apps/api/src/seed/ai-personas.seed.ts, wired into apps/api/src/seed/run.ts (depends on T012)
- [X] T014 [US1] Implement the 6 AI tool definitions (Zod parameter schemas, `execute` wrapping the `diagram-core` operations with the existence-check from research.md §6) in apps/api/src/ai/diagram-tools.ts (depends on T005, T007)
- [X] T015 [US1] Implement `diagram-chat.service.ts`: get-or-create `DiagramChat`, persist `ChatMessage` rows (user + assistant, with `toolCalls` outcomes), run the AI SDK's `generateText` tool-calling loop using the persona's system prompt and prior message history in apps/api/src/ai/diagram-chat.service.ts (depends on T014, T009, T011)
- [X] T016 [US1] Implement `diagram-chat.routes.ts`: `POST`/`GET /diagrams/:id/chat/messages` (`requireDiagramAccess('edit')`, `ai_settings` gate) in apps/api/src/ai/diagram-chat.routes.ts (depends on T015)
- [X] T017 [US1] Register the persona, ai-settings, and diagram-chat route modules in apps/api/src/app.ts (depends on T012, T009, T016)
- [X] T018 [US1] Add persona-list and diagram-chat client methods to apps/web/src/app/api.ts (depends on T017)
- [X] T019 [US1] Implement `CreateViaChatDialog.tsx` — persona dropdown grouped by category, description input — in apps/web/src/ai/CreateViaChatDialog.tsx (depends on T018)
- [X] T020 [US1] Wire a "Create via AI Chat" entry point in apps/web/src/app/App.tsx: creates an empty flowchart diagram via the existing `createDiagram` flow, opens the diagram editor, and routes the dialog's first message into the new chat endpoint (depends on T019)
- [X] T021 [P] [US1] E2E test (mock provider): select a persona, describe a simple process, confirm a populated flowchart diagram opens with normal, fully-editable shapes/connectors in apps/web/tests/e2e/ai-create-diagram.spec.ts (depends on T020)

**Checkpoint**: User Story 1 fully functional and independently testable — the core "chat creates a diagram" capability works end to end.

---

## Phase 4: User Story 2 - Refine an Open Diagram Through Natural-Language Chat (Priority: P2)

**Goal**: A persistent chat panel in the diagram editor applies targeted edits without disturbing
anything else, and interleaves freely with manual canvas edits.

**Independent Test**: Open any flowchart diagram, manually move a shape, ask the chat to add a
new shape and connector, confirm the new elements appear and the manually-moved shape is
untouched.

### Tests for User Story 2 ⚠️

- [X] T022 [P] [US2] E2E test (mock provider): manually reposition/restyle a shape, then send an unrelated chat-driven add request — confirm the new shape/connector appear and the manual change is untouched; send a remove and a rename request — confirm only the named element is affected; send a request naming a nonexistent element — confirm the chat reports it and the diagram is unchanged; alternate manual and chat edits in both orders — confirm neither undoes the other, in apps/web/tests/e2e/ai-edit-diagram.spec.ts

### Implementation for User Story 2

- [X] T023 [US2] Implement `ChatPanel.tsx` — message list, input, loading state while a turn is in flight — in apps/web/src/ai/ChatPanel.tsx (depends on T018)
- [X] T024 [US2] Mount `ChatPanel` persistently in the diagram editor for every diagram (not just chat-created ones), sending the editor's current live DSL with each message and adopting the response's `updatedDslContent` via the existing `useDslSync`/`applyDsl` path, in apps/web/src/app/DiagramEditor.tsx (depends on T023; verified by T022)

**Checkpoint**: User Stories 1 and 2 both independently functional — chat now works for both creating and ongoing editing, on any diagram.

---

## Phase 5: User Story 3 - Admin Manages the Persona Library (Priority: P3)

**Goal**: An admin can create, edit, and archive personas beyond the seeded defaults.

**Independent Test**: Create a persona with a custom system prompt, confirm it appears in the
chat dropdown, archive it, confirm it no longer appears for new chats.

### Tests for User Story 3 ⚠️

- [X] T025 [P] [US3] Contract test: `POST`/`PATCH /admin/ai-personas`, `POST /admin/ai-personas/:id/archive` — category validation (400 on an invalid category), multiple personas per category, archiving is idempotent and doesn't affect an existing `DiagramChat`'s reference, non-admin denied (403) — in apps/api/tests/contract/ai-persona.test.ts (extends T010's file)

### Implementation for User Story 3

- [X] T026 [US3] Extend `persona.service.ts`/`persona.routes.ts` with `createPersona`, `updatePersona`, `archivePersona` behind `requireRole('admin')` in apps/api/src/ai/ (depends on T025, T012)
- [X] T027 [US3] Implement `PersonaAdminPage.tsx` — list personas grouped by category, create/edit form, archive action — in apps/web/src/ai/PersonaAdminPage.tsx (depends on T026, T018)
- [X] T028 [US3] Wire the `?admin=ai-personas` route and an admin nav link in apps/web/src/app/App.tsx (depends on T027)
- [X] T029 [P] [US3] E2E test: admin creates, edits, and archives a persona and sees each change reflected in the chat dropdown; a non-admin cannot reach the persona admin screen, in apps/web/tests/e2e/ai-persona-admin.spec.ts (depends on T028)

**Checkpoint**: User Stories 1–3 all independently functional.

---

## Phase 6: User Story 4 - Resume a Diagram's Prior Chat Conversation (Priority: P4)

**Goal**: Reopening a diagram shows its full prior chat conversation.

**Independent Test**: Create a diagram via chat, close it, reopen it, confirm the earlier
conversation is still visible.

### Implementation for User Story 4

- [X] T030 [US4] Load a diagram's prior chat history from `GET /diagrams/:id/chat/messages` when the editor opens, populating `ChatPanel` before any new message is sent, in apps/web/src/ai/ChatPanel.tsx (depends on T024; the `GET` endpoint itself was already built in T016)
- [X] T031 [P] [US4] E2E test: create a diagram via chat, close it, reopen it, confirm the full prior conversation is visible; open an imported/hand-created diagram, confirm its chat panel starts empty with no persona framing, in apps/web/tests/e2e/ai-chat-history.spec.ts (depends on T030)

**Checkpoint**: All four user stories independently functional — full spec scope delivered.

---

## Final Phase: Polish & Cross-Cutting Concerns

- [X] T032 Rebuild `packages/diagram-core` and run the full regression suite (`diagram-core`, `api`, `web` unit + all E2E, including the opt-in perf test) to confirm no regression in 001–003's existing functionality
- [ ] T033 Run this feature's quickstart.md manual validation end-to-end, including at least one turn against a real, non-mock configured AI provider (research.md §8) to confirm actual provider integration works, not just the mock path

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies.
- **Foundational (Phase 2)**: Depends on Setup — BLOCKS User Stories 1 and 2. User Stories 3 and
  4 don't depend on Foundational directly, only on artifacts US1 produces (see below).
- **User Story 2**: Depends on US1's backend (the chat endpoint, tool-calling loop) and on T018
  (the `api.ts` client methods) — it adds the *persistent, every-diagram* UI surface around
  already-working chat infrastructure, plus its own edit-preservation test.
- **User Story 3**: Depends on US1's `persona.service.ts`/`persona.routes.ts` (T012) to extend,
  and its own admin UI reuses T018's client methods.
- **User Story 4**: Depends on US2's `ChatPanel` (T024) to extend, and reuses the `GET` endpoint
  already built in US1 (T016) — no new backend work.
- **Polish (Final Phase)**: Depends on all four user stories.

### Recommended Order

P1 → P2 → P3 → P4, matching spec.md priorities and matching the real dependency chain this time
(unlike 003, US2/US3/US4 each build on something US1 produces — they are not mutually
independent). Foundational must complete before US1 can start; nothing can run before that.

### Parallel Opportunities

- T004 and T008 (Foundational tests) are parallel-safe with each other — different files, no
  dependency on each other.
- T010 and T011 (US1 tests) are parallel-safe with each other — different files.
- T021 (US1 E2E) can be written in parallel with T010/T011, though it only passes once T020 is
  done.
- T025 (US3 test) and T029 (US3 E2E) are each parallel-safe with tasks in other phases once their
  own phase's prerequisites (T012, T028 respectively) are met.
- T031 (US4 E2E) is parallel-safe with T029 (US3 E2E) — different files, independent stories.

---

## Parallel Example: Foundational

```bash
# Two independent contract tests, once Setup is done:
Task: "Contract test addNode/addEdge in packages/diagram-core/tests/contract/diagram-ops.test.ts"
Task: "Contract test ai_settings in apps/api/tests/contract/ai-settings.test.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1 (Setup) and Phase 2 (Foundational).
2. Complete Phase 3 (User Story 1).
3. **STOP and VALIDATE**: a user can select a persona, describe a diagram, and get a populated
   flowchart open in the canvas editor — independent of US2–US4.

### Incremental Delivery

Setup + Foundational → US1 (create via chat) → US2 (persistent editing via chat) → US3 (persona
admin) → US4 (resume conversation) → Polish. Unlike feature 003, this feature's stories genuinely
build on each other in this order (see Dependencies) — they are not independently parallelizable
across developers the way 003's were, beyond the two Foundational-phase test pairs noted above.

---

## Notes

- `[P]` tasks touch different files with no unmet dependencies.
- Every new `diagram-core` operation and every AI tool-calling behavior has its contract test
  written and failing before implementation, per Constitution IV.
- All AI-path tests (contract and E2E) run against the mock provider (research.md §8); T033 is
  the one point in this feature where a real provider is exercised, deliberately deferred to
  Polish so the bulk of development and CI never depends on live credentials.
- Commit after each task or logical group; stop at any checkpoint to validate a story in
  isolation before continuing.
