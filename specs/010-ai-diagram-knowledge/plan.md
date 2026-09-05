# Implementation Plan: AI Chat Diagram-Type and Persona-Scoped Knowledge Grounding

**Branch**: `010-ai-diagram-knowledge` | **Date**: 2026-08-09 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/010-ai-diagram-knowledge/spec.md`

## Summary

AI chat is fixed to actually work on every diagram type this platform supports (today it silently
hardcodes flowchart parsing regardless of what's open — a real, confirmed bug, not a hypothetical
gap) and grounded well enough to make genuinely correct, type-appropriate edits on each. Grounding
comes from two sources kept in sync with the real grammar by construction rather than by hand-copy
discipline: (1) each family's AI tool schemas, expanded with new narrowly-scoped `diagram-core`
operations covering that family's distinguishing structure (ER attributes, UML members/relationship
kinds, C4 roles, sequence activation, architecture grouping) — Zod enums pulled directly from
`diagram-core`'s own exported types; (2) one short, hand-authored domain-concept primer per family,
kept honest by a contract test that fails if a tool schema's enum values drift out of what the
primer mentions. Separately, personas gain zero or more admin-curated reference-material entries,
each optionally scoped to specific diagram type(s), composing with (never replacing) a persona's
existing system prompt. No live external retrieval; no new diagram type.

## Technical Context

**Language/Version**: TypeScript 5.x, unchanged — extends the same `packages/diagram-core`,
`apps/api`, `apps/web` workspaces 004 already established for AI chat; no new workspace/package.
**Primary Dependencies**: None new. Reuses 004's `ai`/`@ai-sdk/anthropic`/`@ai-sdk/openai`/`zod`
(`apps/api` only) and `ai/test`'s `MockLanguageModelV4` for tests.
**Storage**: PostgreSQL (existing `canvas`/`canvas_test`) — one additive migration:
`ai_persona_reference_material` (data-model.md). No changes to existing tables.
**Testing**: Vitest (`diagram-core` for the 6 new pure operations; `api` for the family-scoped
tool set, reference-material CRUD, and the primer/tool-schema drift-guard contract test) and
Playwright (`web`, for a non-flowchart chat flow and the reference-material admin screen). Same
`MockLanguageModelV4` injection seam 004 already established — no new test infrastructure. SC-002's
real-provider check is a manual pre-release run (research.md §5), matching 004's own T033
precedent exactly, not a new persisted live-provider test suite.
**Target Platform**: Unchanged (Linux server + modern evergreen browsers).
**Project Type**: Web application (unchanged structure).
**Performance Goals**: No new hard latency target — same as 004, a chat turn's duration is
dominated by the external AI provider call. The added system-prompt content (one family primer +
a small number of reference-material entries) is small (each primer is a few sentences; reference
material is admin-curated text, not a corpus) and not expected to materially change request size,
but no numeric budget is set since none exists elsewhere in this codebase's AI-chat work either.
**Constraints**: The AI MUST continue to never emit raw DSL text directly (Constitution I,
reaffirmed by 004) — every new capability in this feature is a new `diagram-core` operation wrapped
as a tool, never a change that lets the model write DSL text itself. A diagram-type-specific tool
MUST NOT be offered to the model on a family it doesn't apply to (FR-004's structural enforcement
mechanism, research.md §3) — this is a hard constraint on `createDiagramTools`'s new `family`
parameter, not an optional nicety.
**Scale/Scope**: Same single-organization deployment scale as prior features. No new diagram type
(FR-012); exactly the 6 already-registered `dslFamily` ids (research.md, data-model.md).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|---|---|---|
| I. Diagram-as-Data (Source of Truth) | PASS | Every new capability (entity attributes, class members, relationship kind, roles, activation, grouping) is a new `diagram-core` pure operation, reached only through the same parse → mutate → serialize round-trip every existing operation already uses. The AI still never emits DSL text (research.md §2). |
| II. Standards Are Enforced, Not Advisory | PASS | New tool-driven edits reach the *existing* save path (`saveDiagram` → `computeValidation`) exactly like every prior AI-chat edit and every manual edit — no new validation trigger, no bypass. |
| III. Persona-Appropriate Abstraction | N/A | This feature adds no diagram types and does not touch diagram-type-to-architect-persona scoping. `AiPersona`'s new reference-material entries are additive data on the existing, distinct `AiPersona` entity (004's own naming precedent already keeps it separate from the unrelated `Persona`/architect-category concept), not a change to abstraction-level scoping. |
| IV. Test-First for Rendering & Export (NON-NEGOTIABLE) | PASS (process gate) | The 6 new `diagram-core` operations get contract tests before implementation (`/speckit.tasks` sequencing); the primer/tool-schema drift-guard test (research.md §6) is itself a rendering-adjacent correctness contract, also test-first. |
| V. Extensible Symbol Libraries | N/A | Not touched — no icon/shape library change. |
| VI. Simplicity & Incremental Delivery | PASS | New operations mirror the existing `updateNodeStyle`/`updateEdgeStyle` narrow-operation precedent (canvas-kwa) rather than growing `addNode`/`addEdge` into universal schemas; reference material is a plain `TEXT[]`-scoped column, not a speculative many-to-many (research.md §4); live external retrieval — floated in the original bead — is explicitly out of scope (Clarifications), not built speculatively ahead of need. |

No violations requiring justification; Complexity Tracking is empty.

**Post-Phase 1 re-check**: `data-model.md`'s one new table and 6 new `diagram-core` operations
introduce no new principle risk. The one design question worth flagging explicitly: family-scoped
tool availability (research.md §3) is a *behavioral* gate, not just a schema-description nicety —
confirmed during design that `createDiagramTools` must actually omit irrelevant tools per family
(not merely describe them as inapplicable), since Constitution I requires every mutation go through
a real operation and an out-of-family tool call must be structurally impossible, not just
discouraged by prompt text. No violation; this is what Principle I already requires, made explicit
here as a hard constraint (see Technical Context) rather than left implicit. Confirmed PASS.

## Project Structure

### Documentation (this feature)

```text
specs/010-ai-diagram-knowledge/
├── plan.md               # This file
├── research.md            # Phase 0 output
├── data-model.md          # Phase 1 output
├── quickstart.md          # Phase 1 output
├── contracts/             # Phase 1 output
│   ├── diagram-core-ops-contract.md
│   └── api-ai-chat-contract.md
└── tasks.md               # Phase 2 output (/speckit.tasks — not created by /speckit.plan)
```

### Source Code (repository root — existing structure from 001–004, extended)

```text
packages/diagram-core/
├── src/model/diagram-ops.ts          # extend: 6 new operations (data-model.md)
└── tests/contract/
    └── diagram-ops.test.ts           # extend: new operation cases

apps/api/
├── migrations/0010_ai_persona_reference_material.sql   # NEW
├── src/ai/
│   ├── diagram-tools.ts                       # extend: createDiagramTools(context, family) — family-scoped tool set
│   ├── diagram-type-primers.ts                # NEW: per-family domain-concept primer map (research.md §2, §6)
│   ├── diagram-chat.service.ts                # extend: dslFamily param replaces hardcoded getDslFamily('flowchart'); system-prompt composition order
│   ├── diagram-chat.routes.ts                 # extend: fetch diagram record, pass dslFamily through
│   ├── persona-reference-material.service.ts  # NEW: CRUD for ai_persona_reference_material
│   └── persona-reference-material.routes.ts   # NEW: /admin/ai-personas/:id/reference-material routes
├── src/app.ts                                 # extend: register the new route module
└── tests/contract/
    ├── diagram-tools.test.ts                  # NEW (or extend diagram-chat.test.ts): family-scoped tool availability + new tool behavior
    ├── diagram-type-primers.test.ts            # NEW: drift-guard contract test (research.md §6)
    └── persona-reference-material.test.ts      # NEW

apps/web/
├── src/ai/
│   └── PersonaAdminPage.tsx                   # extend: reference-material entries CRUD UI (add/edit/remove, diagram-type scoping picker), reusing existing card/field patterns (canvas-23t.1 precedent)
├── src/app/api.ts                             # extend: reference-material client calls
└── tests/e2e/
    ├── ai-chat-non-flowchart.spec.ts          # NEW (US1/US2)
    └── ai-persona-reference-material.spec.ts  # NEW (US4)
```

**Structure Decision**: No new apps, packages, or top-level directories. Everything lands inside
the same `packages/diagram-core`, `apps/api/src/ai/`, and `apps/web/src/ai/` locations 004 already
established for this feature area — this feature extends that existing surface rather than
introducing a new one, consistent with Constitution VI (no new grouping/abstraction beyond what's
needed).

## Complexity Tracking

*No entries — Constitution Check passed with no violations.*
