# Implementation Plan: Mermaid Parser Correctness Fixes

**Branch**: `003-parser-correctness-fixes` | **Date**: 2026-07-26 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/003-parser-correctness-fixes/spec.md`

## Summary

Four correctness/coverage fixes to `packages/diagram-core`'s existing parsers, found in a syntax
audit against the full Mermaid language reference: the architecture (cloud infrastructure) parser
gains the ability to parse `-->`/`<--` connections (a real defect — it currently only accepts
plain `--`) with round-trip-preserved arrow direction; the ER parser gains entity attribute-block
support (`{ type name PK/FK/UK }`); the sequence parser gains notes (`Note left/right/over`) and
nestable control-flow blocks (`loop`/`alt`/`opt`/`par`/`critical`/`break`); and all five non-
flowchart parsers gain the `%%` comment-skipping already proven in the flowchart parser (002).
Every new construct is modeled by reusing the existing generic `DiagramContainer` entity (already
used for flowchart subgraphs and C4 boundaries) rather than inventing new model/rendering
concepts, which means the canvas's existing generic container rendering already displays them
correctly with zero `apps/web` source changes required.

## Technical Context

**Language/Version**: TypeScript 5.x, unchanged from 001/002 — all functional changes land in the
existing `packages/diagram-core` workspace; no new workspace or package.
**Primary Dependencies**: None added.
**Storage**: N/A — no persistence-layer or schema changes; diagrams still persist as DSL text
with a derived in-memory model, unchanged shape at the database level.
**Testing**: Vitest (`packages/diagram-core` contract tests, same TDD-first pattern as 001/002)
plus one Playwright E2E case in `apps/web` confirming the existing generic canvas rendering
already displays the new note/control-flow-block containers correctly.
**Target Platform**: Unchanged (Linux server + modern evergreen browsers).
**Project Type**: Web application (unchanged structure).
**Performance Goals**: No new performance targets; parsing a few additional line shapes adds
negligible overhead to the existing synchronous line-by-line parsers.
**Constraints**: Every new construct (control-flow blocks, notes, ER attributes, architecture
edge arrowheads) MUST round-trip losslessly (Constitution I; spec Assumptions) — none may be
modeled as import-only/export-lossy.
**Scale/Scope**: Same single-organization deployment scale as 001/002. The six supported diagram
families are unchanged in count; this feature deepens coverage within them, it does not add a
seventh.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|---|---|---|
| I. Diagram-as-Data (Source of Truth) | PASS | Every new construct (arrowheads, attributes, notes, control-flow blocks) is required by FR-003/FR-006/FR-012 to round-trip losslessly through the same parse/serialize functions already governing every other diagram family; verified via contract round-trip tests before implementation (Constitution IV). |
| II. Standards Are Enforced, Not Advisory | N/A | `packages/diagram-core/src/standards/validator.ts` inspects node shapes/colors/fonts only — it does not reference `DiagramContainer` at all, so the new container `role`/`attachedNodeIds` fields and the new `DiagramNode.attributes`/`DiagramEdge.arrow` fields have no interaction with standards validation. |
| III. Persona-Appropriate Abstraction | N/A | No new diagram types, personas, or abstraction levels are introduced; existing sequence/ER/architecture diagram-type scoping is unchanged. |
| IV. Test-First for Rendering & Export (NON-NEGOTIABLE) | PASS (process gate) | Contract tests for all four fixes are written and confirmed failing before implementation, per `/speckit.tasks`. |
| V. Extensible Symbol Libraries | N/A | Not touched by this feature. |
| VI. Simplicity & Incremental Delivery | PASS | Every new model concept reuses `DiagramContainer`/`DiagramEdge`/`DiagramNode` (all fields additive/optional) rather than introducing new top-level entities or a new rendering subsystem (research.md §1–§5); each of the 4 user stories remains independently testable/deliverable. |

No violations requiring justification; Complexity Tracking is empty.

**Post-Phase 1 re-check**: data-model.md's field additions (all optional, all confined to
`packages/diagram-core`'s in-memory model) and the parser/serializer contracts in
`contracts/diagram-core-parser-contract.md` introduce no new principle risk — confirmed PASS.

## Project Structure

### Documentation (this feature)

```text
specs/003-parser-correctness-fixes/
├── plan.md               # This file
├── research.md           # Phase 0 output
├── data-model.md         # Phase 1 output
├── quickstart.md         # Phase 1 output
├── contracts/            # Phase 1 output
└── tasks.md              # Phase 2 output (/speckit.tasks — not created by /speckit.plan)
```

### Source Code (repository root — existing structure from 001/002, extended)

```text
packages/diagram-core/
├── src/model/diagram-model.ts        # extend: DiagramNode.attributes?; DiagramEdge.arrow?/sequenceOrder?; DiagramContainer.role?/attachedNodeIds?/sequenceOrder?
├── src/dsl/architecture.ts           # extend: -->/<-- edge parsing + arrow field, %% comments
├── src/dsl/erd.ts                    # extend: attribute-block parsing/serialization, unclosed-block error, %% comments
├── src/dsl/sequence.ts               # extend: Note parsing, loop/alt/opt/par/critical/break parsing+nesting+ordering, unclosed-block error, %% comments
├── src/dsl/uml.ts                    # extend: %% comments only
├── src/dsl/c4.ts                     # extend: %% comments only
└── tests/contract/
    ├── architecture-arrowhead-edges.test.ts  # NEW
    ├── erd-attributes.test.ts                # NEW
    ├── sequence-notes-and-blocks.test.ts     # NEW
    └── comments-everywhere.test.ts           # NEW (sequence/uml/erd/c4/architecture)

apps/web/
└── tests/e2e/
    └── import.spec.ts   # extend: one case confirming a sequence note + loop render as visible
                          # canvas containers (no apps/web source change — existing generic
                          # container rendering already covers it, per contracts/ §"Canvas
                          # rendering")
```

**Structure Decision**: Every functional change is confined to `packages/diagram-core`. No
changes to `apps/api` (the import/diagram routes are already diagram-type-agnostic — see
research.md and the existing `diagram.service.ts`) and no changes to `apps/web` source (the
existing generic `DiagramContainer` rendering, used today for flowchart subgraphs and C4
boundaries, automatically covers the new note/control-flow-block containers). This is the
simplest structure that satisfies the spec (Constitution VI): a parser/model correctness feature
should not need to touch the API or frontend layers at all, and — because every new construct
reuses an existing, already-generic model entity — it doesn't.

## Complexity Tracking

*No entries — Constitution Check passed with no violations.*
