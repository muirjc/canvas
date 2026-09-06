# Implementation Plan: Sequence Diagram Lifeline Rendering

**Branch**: `011-sequence-lifeline-rendering` | **Date**: 2026-09-05 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/011-sequence-lifeline-rendering/spec.md`

## Summary

Sequence diagrams parse and model every construct correctly (jmuir-dtu.4/.4.1) but render through
the exact same flat, one-row-of-boxes code path a flowchart uses — `parseSequence`'s own
`nextPosition()` places every participant, message target, note, and block at `y=40`, `x += 180`,
and neither renderer has any sequence-aware branching at all. This feature replaces that with real
lifeline/timeline geometry: participant columns ordered by declaration, messages/activations/blocks
ordered strictly by `sequenceOrder` down the timeline. Per the Clarifications decision already
resolved with the user, layout is **computed-only** — position is always derived from DSL order at
render time (matching this codebase's existing `tableNodeLayout`/`iconNodeLayout` convention),
never dragged or stored. Phase 0 found the central risk isn't the layout math itself but where it
lives: `Canvas.tsx` and `svg-renderer.ts` are two independent implementations with no shared
geometry function for containers today (research.md §3) — the same class of gap feature 009's
research flagged for shape rendering, but here at whole-diagram scale. This feature's structure is
built around avoiding that: one shared, exported `computeSequenceLayout()` in `diagram-core`, called
by both.

## Technical Context

**Language/Version**: TypeScript 5.x, Node.js 22 LTS
**Primary Dependencies**: No new dependency. Shared `diagram-core` package (`src/dsl/sequence.ts`,
a new `src/render/sequence-layout.ts`, `src/render/svg-renderer.ts`); `apps/web`
(`src/canvas/Canvas.tsx`, `src/canvas/shapes.tsx`). `apps/api` is untouched.
**Storage**: N/A — no schema/persistence change. `canvas.positions`/`canvas.containers`
front-matter round-trip for sequence diagrams specifically is intentionally dropped (research.md
§1); every other diagram family's front-matter round-trip is unaffected.
**Testing**: Vitest (`diagram-core` contract tests are the primary surface — the new layout
function, `sequence-notes-and-blocks.test.ts` extensions, `render-svg.test.ts` extensions);
Playwright E2E (`apps/web` — the only way `Canvas.tsx`'s render path and the new drag-disable
behavior are verified; `apps/web` has no unit test suite, matching feature 009's own precedent).
**Target Platform**: Modern evergreen browsers; Linux server for SVG/PNG export rendering.
**Project Type**: Web application — `packages/diagram-core` and `apps/web` only.
**Performance Goals**: No regression. `computeSequenceLayout()` is a single O(nodes + edges +
containers) pass, same complexity class as the existing `computeBounds`.
**Constraints**: Existing contract/E2E suite green with no weakened assertion. Canvas/export
parity (SC-004) is the load-bearing constraint given `Canvas.tsx` and `svg-renderer.ts` are
independent implementations that already disagree once for container geometry (research.md §3) —
this feature MUST NOT add a second, whole-diagram-scale instance of that disagreement. Sequence
diagrams have exactly one `diagramTypeId` (`'sequence'`, `dslFamily: 'sequence'` — confirmed
against `apps/api/src/seed/diagram-types.seed.ts`), so `svg-renderer.ts` can key off
`model.diagramTypeId === 'sequence'` directly and `Canvas.tsx` off its existing `dslFamily` prop,
without the `diagramTypeId`-vs-`dslFamily` ambiguity feature 009 had to resolve for flowchart-family
diagrams.
**Scale/Scope**: One new shared layout module; targeted changes to the sequence parser (write
computed positions, stop round-tripping them), both renderers' sequence-specific draw path, and
`Canvas.tsx`'s drag handlers (disabled for `dslFamily === 'sequence'`). No new package, no new
service, no new DSL syntax (spec Assumptions).

## Constitution Check

*GATE: evaluated before Phase 0, re-evaluated after Phase 1.*

| Principle | Assessment |
|---|---|
| **I. Diagram-as-Data** | **Pass, with one deliberate, disclosed exception.** Shapes, connectors, labels, and grouping (the principle's own enumerated round-trip guarantees) are entirely unaffected — no DSL construct's parse/serialize behavior changes. The one field that stops round-tripping for this family is `position`, which was never itself a DSL construct being preserved (declaration/message *order* is, and that already round-trips via ordinary line order) — see research.md §1 for why continuing to store now-meaningless position values would be a worse trap than dropping them. |
| **II. Standards Enforced** | **Pass, not engaged.** No shape/color/font vocabulary changes; nothing here is validator-relevant. |
| **III. Persona-Appropriate Abstraction** | **Pass, not engaged.** Sequence remains its own single diagram type (Solution/Technical personas); no new diagram type, no palette/abstraction-level change. |
| **IV. Test-First for Rendering & Export (NON-NEGOTIABLE)** | **Directly engaged — this feature IS a rendering-layer change.** `computeSequenceLayout()`'s contract tests (geometry for every construct: lifelines, messages, activation bars, block bounds, notes, box groupings) MUST be written and seen failing before the layout function and both renderers' draw paths are implemented. |
| **V. Extensible Symbol Libraries** | **Pass, not engaged.** |
| **VI. Simplicity & Incremental Delivery** | **Pass** — see Simplicity assessment below. |

**WCAG 2.1 AA**: no new color introduced — activation bars/lifelines/block boxes reuse this
codebase's existing stroke conventions (`#333333` lines, `#888888` dashed container borders); no
new contrast risk.

### Simplicity assessment

- **One new shared function** (`computeSequenceLayout`), not two independently-reimplemented ones —
  the whole point of this feature's structure (see Summary).
- **No new model field.** `DiagramNode.position`/`DiagramContainer.position`/`size` all already
  exist; this feature changes what populates and reads them for one family, not the shape they
  have.
- **No new DSL syntax** — every construct addressed here (participant/actor, all 10 arrow
  variants, activate/deactivate, loop/alt/opt/par/critical/break/rect, note-left/right/over, box,
  autonumber) already parses today (spec Assumptions).
- **Explicitly excludes** canvas-7vs.8's deeper "give notes/boxes/blocks a genuinely distinct
  visual style" and canvas-7vs.9's "draw an explicit connector line to an attached
  participant" — both remain their own beads; this feature supplies only the lifeline geometry
  they depend on (spec Assumptions, restated in Complexity Tracking below for visibility).
- **Explicitly excludes** `create`/`destroy` mid-timeline lifeline truncation (spec Assumptions) —
  lifelines always span full diagram height regardless.
- **Explicitly does not fix** the pre-existing "Add Shape" toolbar offering the four
  flowchart-style universal shapes on a sequence diagram's canvas even though none of them are
  meaningful there (research.md §6) — real, but predates this feature and is not what canvas-7vs.1
  asked for.

No Complexity Tracking entries are required — nothing here is unjustified complexity; the
exclusions above are scope discipline, not gaps this feature failed to notice.

**Post-Phase 1 re-evaluation**: unchanged. Phase 1 added no new dependency, no new workspace, no
new persisted data, no new model field — only the shared layout function's shape (data-model.md)
and its consumption contract (contracts/sequence-layout-contract.md).

## Project Structure

### Documentation (this feature)

```text
specs/011-sequence-lifeline-rendering/
├── plan.md              # This file
├── research.md          # Phase 0 — 6 decisions
├── data-model.md         # Phase 1 — computeSequenceLayout()'s shape, per-construct geometry rules
├── quickstart.md        # Phase 1
├── contracts/
│   └── sequence-layout-contract.md   # Phase 1 — the shared layout function's consumption contract
│                                       # (no API/schema; this is a rendering feature)
└── tasks.md             # Phase 2 (/speckit.tasks — NOT created here)
```

### Source Code (repository root)

```text
packages/diagram-core/src/
├── dsl/
│   └── sequence.ts                  # nextPosition()/autoPositionCounter removed; parseSequence
│                                     # calls computeSequenceLayout() once and writes its output
│                                     # into node/container position+size; serializeSequence stops
│                                     # emitting canvas.positions/canvas.containers for this family
├── render/
│   ├── sequence-layout.ts           # NEW — computeSequenceLayout(model): the one shared geometry
│                                     # calculation (data-model.md)
│   └── svg-renderer.ts              # renderNode/renderContainer/renderEdge grow a
│                                     # model.diagramTypeId === 'sequence' branch that reads
│                                     # computeSequenceLayout() output instead of node.position

packages/diagram-core/tests/contract/
├── sequence-layout.test.ts          # NEW — computeSequenceLayout() contract tests (geometry for
│                                     # every construct), written first per Constitution IV
├── sequence-notes-and-blocks.test.ts # extended: note/box/block position assertions updated to
│                                     # the new computed geometry
└── render-svg.test.ts               # extended: sequence-diagram render assertions

apps/web/src/canvas/
├── Canvas.tsx                       # sequence-specific render branch (mirrors svg-renderer.ts's,
│                                     # both calling computeSequenceLayout()); handleNodePointerDown/
│                                     # handleContainerPointerDown skip starting a drag when
│                                     # dslFamily === 'sequence' (FR-013)
└── shapes.tsx                       # untouched — no new NodeShape values, no shape rendering change

apps/web/tests/e2e/
└── sequence-rendering.spec.ts       # NEW — lifeline/message-order/activation-bar/block-bounds/
                                       # note-position visual assertions; drag-disabled-for-sequence
                                       # regression
```

**Structure Decision**: No new package, no new workspace, no schema/persistence change —
`apps/api` is untouched entirely. Every change lives in `packages/diagram-core` (a new layout
module plus targeted parser/renderer edits) or `apps/web`'s `Canvas.tsx` (consuming that same
module), matching how prior rendering-completeness work (canvas-7vs.2 through .7) scoped itself.

## Complexity Tracking

> No Constitution Check violations. Table intentionally empty.

Restated here for visibility (already in spec.md Assumptions and this plan's Simplicity
assessment): canvas-7vs.8 (role-specific visual styling) and canvas-7vs.9 (attachment connector
lines) both depend on `computeSequenceLayout()`'s geometry but are explicitly NOT delivered by this
feature. Also out of scope, found during Phase 0 but predating this feature and not part of
canvas-7vs.1: the "Add Shape" toolbar's four universal shapes remain offered on a sequence
diagram's canvas even though `serializeSequence` silently discards whatever shape a node actually
has and re-emits every node as a plain participant/actor line — filing this as a candidate
follow-up bead rather than folding it in (research.md §6).
