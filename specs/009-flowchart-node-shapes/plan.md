# Implementation Plan: Additional Mermaid Flowchart Node Shapes

**Branch**: `009-flowchart-node-shapes` | **Date**: 2026-07-29 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/009-flowchart-node-shapes/spec.md`

## Summary

Feature 002 shipped a bounded subset of Mermaid flowchart grammar (five node shapes), explicitly
naming "additional node shapes" as a deferred follow-up. This feature adds the seven Mermaid
defines that are still missing — stadium, subroutine, double-circle, hexagon, parallelogram,
trapezoid, and asymmetric — recognized on import, rendered correctly (canvas and export), and
authorable from the toolbar. Phase 0 found the real work is narrower and trickier than "add nine
shapes": narrower because Standards enforcement needs no code change at all (already generic over
`NodeShape`); trickier because three more parser-regex collision pairs exist beyond the one the
spec already named, and because the toolbar's diagram-family scoping (a new capability — the
palette has never been diagram-type-aware before) must key off `dslFamily`, not `diagramTypeId`,
or it silently excludes five of the six flowchart-family diagram types.

## Technical Context

**Language/Version**: TypeScript 5.x, Node.js 22 LTS
**Primary Dependencies**: React 18 + Vite (`apps/web`), shared `diagram-core` package; no new
dependency
**Storage**: N/A — no persistence change. `NodeShape` is an in-memory/DSL-level type, not a
database column.
**Testing**: Vitest (`diagram-core` contract tests — the primary surface for this feature),
Playwright (E2E — the only way `apps/web`'s toolbar/standards-editor changes are verified; `apps/web`
has no unit test suite)
**Target Platform**: Modern evergreen browsers; Linux server for SVG/PNG export rendering
**Project Type**: Web application — this feature touches the shared `diagram-core` package and
`apps/web` only; `apps/api` is untouched (no schema, no endpoint, no persistence change)
**Performance Goals**: No regression. Nine additional `switch`/regex cases add negligible cost to
parse/serialize/render, all already O(nodes).
**Constraints**: 144 `data-testid` identifiers are a contract (additions fine, removals/renames
not); existing suite green (154 diagram-core, 112 api unaffected, 96 passed / 1 skipped E2E) with
no assertion weakened; `packages/diagram-core/src/render/` changes ARE in scope for this feature
(unlike feature 008, which was forbidden from touching it) — new shapes are only real once they
render.
**Scale/Scope**: Nine new `NodeShape` values, five parser collision-pair regressions, two
renderers, one toolbar, one admin standards list. No new package, no new service.

## Constitution Check

*GATE: evaluated before Phase 0, re-evaluated after Phase 1.*

| Principle | Assessment |
|---|---|
| **I. Diagram-as-Data** | **Pass, central to this feature.** Every new shape must round-trip losslessly (FR-010) and render identically between canvas and export (FR-009) — the second half of this is not automatic, since `svg-renderer.ts` and `shapes.tsx` are two independent implementations that research (§3) found already disagree for `cylinder`. This feature must not add a third disagreement. |
| **II. Standards Enforced** | **Pass — and confirmed to need zero validator/schema changes.** `allowedShapeIds`/`mandatoryShapeIds` are already `NodeShape[]`, checked generically. Only the admin UI's own hardcoded `KNOWN_SHAPES` list needs the nine new values (research.md §5) — otherwise these shapes would be usable but ungovernable, quietly undermining this principle. |
| **III. Persona-Appropriate Abstraction** | **Pass, and the reason the toolbar-scoping decision matters.** These seven shapes carry no meaning outside flowchart; exposing them on every diagram type's canvas (rejected option B in the spec's clarification) would leak flowchart-specific vocabulary into ER/C4/UML/sequence editing, which this principle exists to prevent. |
| **IV. Test-First for Rendering & Export (NON-NEGOTIABLE)** | **Directly engaged, not incidental.** This feature touches parsing, rendering, and export fidelity — exactly the surface this principle names. The five collision-pair tests (contracts/dsl-grammar-contract.md) and the round-trip cases MUST be written and seen failing before the parser/serializer changes land. |
| **V. Extensible Symbol Libraries** | **Pass, not engaged.** `NodeShape` is core vocabulary, not an icon/shape library entry — unaffected by this principle's plug-in contract. |
| **VI. Simplicity & Incremental Delivery** | **Pass** — see Simplicity assessment below. |

**WCAG 2.1 AA**: seven new toolbar buttons follow the existing accessible-name pattern exactly
(spec Assumptions) — no new accessibility work, but existing `accessibility.spec.ts` coverage of
the editor toolbar should be exercised against a flowchart with the new buttons present to confirm
this holds in practice, not just by following the pattern.

### Simplicity assessment

- **One new value set** (`NodeShape` +9), no new field, no new entity, no new table.
- **One new prop** (`Canvas`'s `dslFamily`), threaded from data `DiagramEditor.tsx` already holds —
  not a new fetch, not a new loading state.
- **Zero validator/schema changes** — Standards enforcement already generalized correctly the
  first time (feature 001), and this feature is direct evidence that generalization paid off.
- **Explicitly not fixing** the pre-existing `cylinder`/`person`/`icon` canvas-vs-export rendering
  gap research uncovered (research.md §3) — real, but not grouping A's job. Recording this as a
  candidate for its own bead rather than folding it in, per Constitution VI.
- **Explicitly not deriving `KNOWN_SHAPES` from `NodeShape` automatically** — a real, if small,
  refactor opportunity research surfaced (§5), deliberately left as a follow-up rather than
  expanding this feature's surface.

No Complexity Tracking entries are required — nothing here is unjustified complexity. The two
"found but not fixed" items above are recorded here and in research.md precisely so they aren't
lost, without being pulled into this feature's scope.

**Post-Phase 1 re-evaluation**: unchanged. Phase 1 added no new dependency, no new workspace, no
new persisted data. The one design decision worth restating: nine `NodeShape` values, not seven
with a separate orientation field (research.md §1) — chosen because it introduces no new
cross-cutting concept the model doesn't already have.

## Project Structure

### Documentation (this feature)

```text
specs/009-flowchart-node-shapes/
├── plan.md              # This file
├── research.md          # Phase 0 — 6 decisions, incl. the diagramTypeId-vs-dslFamily finding
├── data-model.md        # Phase 1 — NodeShape's 9 new values, parser ordering table
├── quickstart.md        # Phase 1
├── contracts/           # Phase 1 — grammar contract + UI contract (no API; this feature has none)
│   ├── dsl-grammar-contract.md
│   └── ui-contract.md
└── tasks.md             # Phase 2 (/speckit.tasks — NOT created here)
```

### Source Code (repository root)

```text
packages/diagram-core/src/
├── model/diagram-model.ts           # NodeShape: +9 values
├── dsl/
│   ├── flowchart-parser.ts          # NODE_PATTERNS: +9 (strict ordering, data-model.md), SHAPE_SUFFIX: +9
│   └── flowchart-serializer.ts      # SHAPE_DELIMITERS: +9
└── render/svg-renderer.ts           # renderNodeShape: +9 case branches (export renderer)

packages/diagram-core/tests/contract/
├── round-trip.test.ts               # +9 shape cases (both orientations)
└── (new or existing file)           # 5 collision-pair regression tests (dsl-grammar-contract.md)

apps/web/src/
├── canvas/
│   ├── shapes.tsx                   # renderNodeShape: +9 cases (on-canvas renderer); ADDABLE_SHAPES
│   │                                 # replaced by getAddableShapes(dslFamily)
│   └── Canvas.tsx                   # new `dslFamily` prop; SHAPE_GLYPHS: +7 (optional, has a
│   │                                 # text-label fallback already)
├── app/DiagramEditor.tsx            # passes diagram.dslFamily through to <Canvas>
└── admin/StandardsEditor.tsx        # KNOWN_SHAPES: +9

apps/web/tests/e2e/
└── (new or existing shape-related spec) # toolbar scoping (incl. the diagramTypeId-vs-dslFamily
                                          # regression), standards-editor checkboxes, add+render
```

**Structure Decision**: No new package, no new workspace, no new service — `apps/api` is untouched
entirely (confirmed: no schema, no endpoint, no persisted column). Every change lives in
`packages/diagram-core` (model/parser/serializer/render) or `apps/web` (canvas/toolbar/admin
standards UI), matching how feature 002/003 scoped prior flowchart-grammar work.

## Complexity Tracking

> No Constitution Check violations. Table intentionally empty.

Two judgment calls worth recording, both in the direction of *not* expanding scope:

1. The pre-existing `cylinder`/`person`/`icon` canvas-vs-export rendering mismatch (research.md
   §3) is real and was found during this feature's research, but fixing it belongs to whichever
   bead owns that gap, not to grouping A.
2. `StandardsEditor.tsx`'s `KNOWN_SHAPES` staying a manually-maintained list rather than being
   derived from `NodeShape` (research.md §5) is a small missed-DRY opportunity, deliberately left
   alone rather than refactored as a side effect of adding nine more entries to it.
