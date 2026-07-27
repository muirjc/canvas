# Implementation Plan: AI-Assisted Diagram Chat

**Branch**: `004-ai-diagram-chat` | **Date**: 2026-07-26 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/004-ai-diagram-chat/spec.md`

## Summary

A persona-driven, natural-language chat interface for creating and editing flowchart diagrams,
built on the Vercel AI SDK. Admins author "AI personas" (name, architect-category tag, system
prompt); users pick one to start a chat that generates an initial diagram, then keep refining it
through a persistent in-editor chat panel. Every chat-driven edit is applied via targeted
`diagram-core` operations (two new: `addNode`/`addEdge`, alongside 002's existing four) rather
than whole-diagram regeneration, executed server-side through the AI SDK's tool-calling loop.
Chat edits land in the same client-side unsaved-model state as manual canvas edits, so both kinds
of edits interleave freely and reach the existing save/standards-validation path identically —
no new persistence or validation logic. AI provider selection is environment-configured (like the
existing OIDC setup); whether AI chat is available at all is a separate, database-backed,
admin-toggleable setting that takes effect without a redeploy.

## Technical Context

**Language/Version**: TypeScript 5.x, unchanged from 001–003 — this feature adds to the existing
`packages/diagram-core`, `apps/api`, and `apps/web` workspaces; no new workspace or package.
**Primary Dependencies**: New — `ai`, `@ai-sdk/anthropic`, `@ai-sdk/openai` (Vercel AI SDK core +
provider adapters, `apps/api` only), `zod` (tool-parameter schemas, `apps/api` only). No new
frontend dependency — the chat panel is a plain React component using the existing `api.ts`
client pattern (research.md §7: non-streaming, so `@ai-sdk/react`'s `useChat` isn't needed).
**Storage**: PostgreSQL (existing `canvas`/`canvas_test` databases) — one additive migration:
`ai_personas`, `diagram_chats`, `chat_messages`, `ai_settings` (singleton). No changes to existing
tables.
**Testing**: Vitest (`diagram-core` for `addNode`/`addEdge`; `api` for persona CRUD, the
ai-settings toggle, and the chat endpoint's tool-calling behavior against a real Postgres) and
Playwright (`web`, for the four user-story flows end to end). Both layers run against the AI
SDK's `MockLanguageModelV4` test provider (research.md §8) — deterministic, no network call, no
API key — with a separate, opt-in-only smoke test against a real configured provider
(`RUN_LIVE_AI_TESTS=1`, mirroring the existing `RUN_PERF_TESTS` pattern) excluded from default CI.
**Target Platform**: Unchanged (Linux server + modern evergreen browsers).
**Project Type**: Web application (unchanged structure — see Project Structure below).
**Performance Goals**: No hard latency target — a chat turn's duration is dominated by the
external AI provider call, outside this feature's control; the UI shows a loading state for the
duration (research.md §7).
**Constraints**: Chat-driven edits MUST NOT be persisted until the user's existing manual "Save"
action (research.md §3) — this is a hard constraint, not a preference, since it's what makes
FR-011 and FR-012 hold without new code. A disabled AI-chat setting or unreachable provider MUST
produce a clear, distinguishable error (FR-014, FR-020) rather than a generic failure.
**Scale/Scope**: Same single-organization deployment scale as prior features. One new diagram
family is *not* introduced — flowchart-only (FR-019).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|---|---|---|
| I. Diagram-as-Data (Source of Truth) | PASS | Chat-driven edits are ordinary `DiagramModel` mutations via the same `diagram-core` functions (existing + two new) the canvas already uses, serialized through the same parse/serialize round-trip. No second diagram representation is introduced; the AI never emits DSL directly (research.md §1). |
| II. Standards Are Enforced, Not Advisory | PASS | Chat edits reach the *existing* save path (`saveDiagram` → `computeValidation`) unmodified — no bypass, because no new validation trigger is introduced (research.md §3). |
| III. Persona-Appropriate Abstraction | N/A | This feature adds no diagram types and does not touch the existing diagram-type-to-architect-persona scoping. Its new `AiPersona` entity is a distinct, additive concept (research.md §4) — naming it separately (rather than reusing `Persona`) is precisely what keeps this principle's existing mechanism untouched. |
| IV. Test-First for Rendering & Export (NON-NEGOTIABLE) | PASS (process gate) | `addNode`/`addEdge` get contract tests before implementation; the chat endpoint's tool-calling behavior (applied vs. not-found outcomes) gets contract tests before implementation, per `/speckit.tasks`. |
| V. Extensible Symbol Libraries | N/A | Not touched by this feature. |
| VI. Simplicity & Incremental Delivery | PASS | Reuses existing patterns throughout: the admin CRUD pattern (`admin.routes.ts`), the `requireDiagramAccess`/`requireRole` middleware, the client-side unsaved-state-then-save flow, and the OIDC-style env-var config precedent. Streaming responses, rate limiting, multi-provider-per-request switching, and non-flowchart diagram types are all explicitly deferred (spec Assumptions), not built speculatively. |

No violations requiring justification; Complexity Tracking is empty.

**Post-Phase 1 re-check**: data-model.md's four new tables and the two new `diagram-core`
operations introduce no new principle risk — the `AiPersona`/`personas`-column naming collision
(research.md §4) was the one real risk surfaced during design, and it's resolved by scoping the
new entity to its own name rather than touching Principle III's existing mechanism. Confirmed
PASS.

## Project Structure

### Documentation (this feature)

```text
specs/004-ai-diagram-chat/
├── plan.md               # This file
├── research.md            # Phase 0 output
├── data-model.md          # Phase 1 output
├── quickstart.md          # Phase 1 output
├── contracts/             # Phase 1 output
└── tasks.md               # Phase 2 output (/speckit.tasks — not created by /speckit.plan)
```

### Source Code (repository root — existing structure from 001–003, extended)

```text
packages/diagram-core/
├── src/model/diagram-ops.ts          # extend: NEW addNode, addEdge (alongside 002's four)
└── tests/contract/
    └── diagram-ops.test.ts           # extend: addNode/addEdge cases (002's existing file)

apps/api/
├── migrations/0004_ai_chat.sql               # NEW: ai_personas, diagram_chats, chat_messages, ai_settings
├── src/ai/
│   ├── provider.ts                           # NEW: AI_PROVIDER env selection → AI SDK provider instance
│   ├── diagram-tools.ts                      # NEW: tool definitions wrapping diagram-ops (research.md §1, §6)
│   ├── persona.service.ts                    # NEW: AiPersona CRUD
│   ├── persona.routes.ts                     # NEW: /admin/ai-personas, /ai-personas
│   ├── ai-settings.service.ts                # NEW: singleton chatEnabled get/set
│   ├── ai-settings.routes.ts                 # NEW: /admin/ai-settings
│   ├── diagram-chat.service.ts               # NEW: DiagramChat/ChatMessage persistence + tool-calling orchestration
│   └── diagram-chat.routes.ts                # NEW: /diagrams/:id/chat/messages (GET, POST)
├── src/app.ts                                # extend: register the 3 new route modules above
├── package.json                              # extend: add ai, @ai-sdk/anthropic, @ai-sdk/openai, zod
└── tests/contract/
    ├── ai-persona.test.ts                    # NEW
    ├── ai-settings.test.ts                   # NEW
    └── diagram-chat.test.ts                  # NEW (provider call stubbed)

apps/web/
├── src/canvas/Canvas.tsx                     # extend: manual add-shape/connect-mode call the new shared addNode/addEdge
├── src/ai/
│   ├── ChatPanel.tsx                         # NEW: persistent chat UI embedded in DiagramEditor
│   ├── CreateViaChatDialog.tsx               # NEW: persona picker + first-message entry point
│   └── PersonaAdminPage.tsx                  # NEW: admin persona CRUD screen
├── src/app/App.tsx                           # extend: "Create via AI Chat" entry point, ?admin=ai-personas / ?admin=ai-settings routes
├── src/app/DiagramEditor.tsx                 # extend: mount ChatPanel, adopt updatedDslContent from a chat turn
├── src/app/api.ts                            # extend: persona/ai-settings/diagram-chat client calls
└── tests/e2e/
    ├── ai-create-diagram.spec.ts             # NEW (US1)
    ├── ai-edit-diagram.spec.ts               # NEW (US2)
    ├── ai-persona-admin.spec.ts              # NEW (US3)
    └── ai-chat-history.spec.ts               # NEW (US4)
```

**Structure Decision**: No new apps or packages — every change lands inside the three existing
workspaces from 001–003. A new `src/ai/` directory is introduced in both `apps/api` and
`apps/web` to keep this feature's substantial new surface area cohesive and easy to find, rather
than scattering it across the existing `diagrams`/`admin` directories — the one deliberate new
grouping this feature introduces, justified by its size relative to prior features (Constitution
VI: grouping, not a new abstraction layer).

## Complexity Tracking

*No entries — Constitution Check passed with no violations.*
