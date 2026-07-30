# Tasks: Additional Mermaid Flowchart Node Shapes

**Input**: Design documents from `/specs/009-flowchart-node-shapes/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Test tasks are included and are **not optional here**, matching this project's own
established convention (features 007/008). `contracts/dsl-grammar-contract.md` names five specific
regex-collision regressions that only a negative test catches, and Constitution IV is directly
engaged (this feature touches parsing, rendering, and export fidelity).

**Organization**: By user story, in priority order.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on incomplete work)
- **[Story]**: US1–US3, on user-story tasks only

## Path Conventions

`packages/diagram-core` (model/parser/serializer/render — shared, no build step change) and
`apps/web` (canvas/toolbar/admin standards UI). `apps/api` is untouched by this feature entirely.

---

## Sequencing note — read before starting

**`NodeShape` (Phase 2) is the only true blocking prerequisite.** Everything else — parser,
serializer, both renderers, the toolbar, the admin standards list — is a TypeScript compile-time
dependency on those nine new values existing, but each is otherwise independent work belonging to
its own story. Foundational is deliberately thin here; the reason 007/008 needed a larger one
(access control, an API endpoint) doesn't apply to this feature.

**Parser (`NODE_PATTERNS`) insertion order is a correctness requirement, not a style choice.**
Three of the nine new shapes will silently misparse as an existing shape if inserted in the wrong
position relative to it — see data-model.md's ordering table before touching T004.

**Two renderers must both change, or this feature repeats a bug it found rather than fixing one.**
`svg-renderer.ts` (export) and `apps/web/src/canvas/shapes.tsx` (on-canvas) are independent
implementations that research confirmed already disagree for `cylinder`. Every new `case` added to
one MUST have a matching `case` in the other — never a fallthrough to the rectangle default.

---

## Phase 1: Setup

**Purpose**: Establish a trustworthy baseline before changing anything.

- [X] T001 Run `npm run test --workspace=@canvas/diagram-core` and
      `npm run test:e2e --workspace=@canvas/web`. Expected baseline: **154** diagram-core passing;
      **96 passed + 1 skipped** E2E (per `quickstart.md`). Confirm both before any code change — a
      pre-existing failure here must be resolved first so a later red run can be trusted to mean
      this feature broke something.
      **Confirmed**: 154/154 diagram-core. E2E is actually **102 passed + 1 skipped** (not 96) —
      feature 008 merged into `main` between that quickstart.md being written and this task
      running, adding 6 tests. Both counts are green; using 102+1 as this feature's real baseline.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The one shared type change every other phase compiles against.

- [X] T002 Add nine new values to `NodeShape` in
      `packages/diagram-core/src/model/diagram-model.ts`: `stadium`, `subroutine`,
      `double-circle`, `hexagon`, `parallelogram`, `parallelogram-alt`, `trapezoid`,
      `trapezoid-alt`, `asymmetric` (data-model.md). No other field on `DiagramNode` changes —
      orientation is a distinct shape value, not a separate property (research.md §1).

**Checkpoint**: Every other phase can now reference these nine values without a type error. No
behavior has changed yet — nothing parses, renders, or offers them.

---

## Phase 3: User Story 1 - Import a diagram that uses any of the seven additional shapes (Priority: P1) 🎯 MVP

**Goal**: A hand-authored or externally-produced Mermaid flowchart using any of these shapes
imports successfully and preserves exactly which shape (and, for parallelogram/trapezoid, which
orientation) was used — including through a save/reload round-trip.

**Independent Test**: Import Mermaid text containing one node of each of the nine shape/orientation
combinations. Import succeeds; each node's recorded shape matches the source; serializing and
re-parsing reproduces the same model.

- [X] T003 [P] [US1] Write failing tests in a new
      `packages/diagram-core/tests/contract/flowchart-additional-shapes.test.ts`: one happy-path
      case per shape (`id([label])` → `stadium`, `id[[label]]` → `subroutine`,
      `id(((label)))` → `double-circle`, `id{{label}}` → `hexagon`, `id[/label/]` →
      `parallelogram`, `id[\label\]` → `parallelogram-alt`, `id[/label\]` → `trapezoid`,
      `id[\label/]` → `trapezoid-alt`, `id>label]` → `asymmetric`); one case recognizing a new
      shape declared inline at an edge endpoint (e.g. `A([Start]) --> B`); and the five
      collision-pair regressions from `contracts/dsl-grammar-contract.md` — each asserting the
      **wrong** shape was NOT produced (subroutine-vs-rectangle, stadium-vs-rounded-rectangle,
      double-circle-vs-circle, hexagon-vs-diamond, parallelogram/trapezoid-vs-rectangle). Confirm
      all fail now — none of these shapes are recognized yet.
- [X] T004 [US1] Add nine entries to `NODE_PATTERNS` in
      `packages/diagram-core/src/dsl/flowchart-parser.ts`, in the exact order data-model.md
      specifies (subroutine and double-circle and hexagon and stadium each before the existing
      pattern they would otherwise be misread as; parallelogram/trapezoid variants before
      rectangle; asymmetric anywhere).
- [X] T005 [US1] Add the same nine delimiter alternatives to `SHAPE_SUFFIX` in
      `flowchart-parser.ts`, so inline edge-endpoint declarations recognize these shapes
      identically to standalone declarations (FR-008).
- [X] T006 [US1] Re-run T003 and confirm every case now passes, including all five collision-pair
      regressions.
- [X] T007 [P] [US1] Write failing round-trip tests in
      `packages/diagram-core/tests/contract/round-trip.test.ts`: one model per new shape (both
      orientations for parallelogram/trapezoid) through `parse(serialize(model))`, following the
      file's existing `normalize`/`roundTrip` helpers. Confirm these fail (or throw — `serializeNode`
      will throw on an unmapped `SHAPE_DELIMITERS` entry) before the serializer change.
- [X] T008 [US1] Add nine entries to `SHAPE_DELIMITERS` in
      `packages/diagram-core/src/dsl/flowchart-serializer.ts`, matching the delimiter pairs in
      `contracts/dsl-grammar-contract.md` exactly.
- [X] T009 [US1] Re-run T007 and confirm all round-trip cases pass, including that
      `parallelogram`/`trapezoid` never normalize to their `-alt` counterpart or vice versa.

**Checkpoint**: These seven shapes now import, recognize inline declarations, and round-trip
losslessly at the data level. Nothing visual has changed yet — a diagram using them still displays
as a plain rectangle until Phase 4 lands. This is a real, if incomplete, increment: FR-001 through
FR-008, FR-010, and FR-011 all hold.

---

## Phase 4: User Story 2 - See the shape actually drawn, not a generic placeholder (Priority: P1)

**Goal**: Every one of these shapes renders as itself — visually distinct from every other shape —
on the canvas and in exported SVG/PNG, not as a rectangle standing in for it.

**Independent Test**: Open a diagram containing all nine shape/orientation values. Each renders as
its own distinct shape on screen; exporting to SVG/PNG shows the same distinct shapes; saving and
reopening leaves every shape (and orientation) unchanged.

- [X] T010 [P] [US2] Write failing tests (new file or extend
      `packages/diagram-core/tests/contract/render-svg.test.ts`) asserting `renderToSvg` produces
      distinct, shape-appropriate markup for each of the nine new `NodeShape` values (e.g. a
      `<polygon>` for hexagon, two `<ellipse>` elements for double-circle) — never the rectangle
      `default` case's plain `<rect>`. Confirm these fail now.
- [X] T011 [US2] Add nine `case` branches to `renderNodeShape` in
      `packages/diagram-core/src/render/svg-renderer.ts` (data-model.md's rendering-technique
      table: `<rect>` with `rx`/`ry` = half-height for stadium; `<rect>` + two inset `<line>`s for
      subroutine; two concentric `<ellipse>`s for double-circle; `<polygon>` for hexagon,
      parallelogram/-alt, trapezoid/-alt, and asymmetric).
- [X] T012 [US2] Re-run T010 and confirm all nine cases pass.
- [X] T013 [US2] Add matching `case` branches for all nine values to `renderNodeShape` in
      `apps/web/src/canvas/shapes.tsx` — the on-canvas renderer, a separate implementation from
      T011's. Do **not** let any of the nine fall through to the rectangle `default`, the exact gap
      research.md §3 found already exists for `cylinder`/`person`/`icon` (out of scope to fix here,
      but not to repeat).
- [X] T014 [P] [US2] Write failing E2E tests: import a diagram containing all nine
      shape/orientation values, open it, and assert each node's rendered SVG element differs
      appropriately from a plain rectangle (e.g. distinct tag name or point count per shape).
      Confirm these fail before T013.
- [X] T015 [US2] Re-run T014 and confirm it passes.
- [X] T016 [P] [US2] Write a failing E2E test exporting that same diagram to SVG (or PNG) and
      asserting the export contains the same nine distinct shapes — FR-009's export half, not just
      the canvas half. Confirm it fails before T011, or re-order after T011/T013 land if written
      afterward; either way it must be seen to exercise real markup, not merely check the DSL.
- [X] T017 [US2] Re-run T016 and confirm it passes.
- [X] T018 [US2] Write/confirm an E2E round-trip test: save the diagram from T014, reload it, and
      assert every shape and orientation is unchanged (spec's User Story 2, Acceptance Scenario 3)
      — the end-to-end, through-the-UI counterpart to T007's unit-level check.

**Checkpoint**: The reported problem is now fully addressed for import — these shapes are
recognized, preserved, and look like themselves everywhere they're shown. This is the natural MVP
boundary: Phases 1–4 alone deliver both P1 stories.

---

## Phase 5: User Story 3 - Draw one of the new shapes directly, not only via import (Priority: P2)

**Goal**: An architect can add a node in any of these seven shapes (not the two `-alt`
orientations) directly from the toolbar while editing a flowchart-family diagram — and the toolbar
shows none of them while editing any other diagram type.

**Independent Test**: From a blank flowchart, add one of the seven shapes using an on-canvas
control with no DSL typed by hand. From a non-flowchart diagram type, confirm none of the seven
appear.

- [X] T019 [P] [US3] Write failing E2E tests: a flowchart's "Add Shape" toolbar shows all 11
      buttons (4 existing + 7 new — stadium, subroutine, double-circle, hexagon, parallelogram,
      trapezoid, asymmetric; **not** 9 — parallelogram-alt/trapezoid-alt get no button); a
      non-flowchart diagram type (e.g. an ER diagram) shows only the 4 existing buttons; a diagram
      type that shares `dslFamily: 'flowchart'` but is **not** literally `diagramTypeId:
      'flowchart'` (e.g. `business-capability-map`, per `apps/api/src/seed/diagram-types.seed.ts`)
      **also** shows the 7 new buttons — this third case is the specific regression that would pass
      silently if the scoping check were wrongly keyed on `diagramTypeId` (research.md §4). Confirm
      all three fail now (no new buttons exist yet).
- [X] T020 [US3] Add a `dslFamily: string` prop to `Canvas` in `apps/web/src/canvas/Canvas.tsx`.
- [X] T021 [US3] In `apps/web/src/app/DiagramEditor.tsx`, pass `diagram.dslFamily` (already in
      scope there — used today for `getDslFamily`/`useDslSync`) into the new `Canvas` prop.
- [X] T022 [US3] In `apps/web/src/canvas/shapes.tsx`, replace the flat `ADDABLE_SHAPES` export with
      `getAddableShapes(dslFamily: string)`: the four existing universal shapes always, plus
      exactly seven flowchart-only shapes (stadium, subroutine, double-circle, hexagon,
      parallelogram, trapezoid, asymmetric — the default orientations only) when
      `dslFamily === 'flowchart'`.
- [X] T023 [US3] Update `Canvas.tsx`'s toolbar rendering to call `getAddableShapes(dslFamily)`
      instead of importing the static `ADDABLE_SHAPES`.
- [X] T024 [US3] Re-run T019 and confirm all three cases pass.
- [X] T025 [P] [US3] Write a failing E2E test: clicking each of the seven new toolbar buttons adds
      a node of exactly that shape (verify via the DSL panel or the rendered node, not just that a
      node count increased). Confirm it fails before this lands (buttons don't exist yet if run
      before T022/T023; skip straight to re-run if T019–T024 already landed first).
- [X] T026 [US3] Re-run T025 and confirm it passes. No change needed to `addNode` itself — it
      already accepts any `NodeShape` (research.md §4).

**Checkpoint**: All three user stories are independently functional. These shapes can be read,
seen correctly, and authored from scratch.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [X] T027 [P] Add all nine new values to `KNOWN_SHAPES` in
      `apps/web/src/admin/StandardsEditor.tsx`, including both orientation variants — an admin may
      govern either orientation even though only the default is toolbar-reachable (research.md §5).
      No change needed to `packages/diagram-core/src/standards/{schema,validator}.ts` — already
      generic over `NodeShape`.
- [X] T028 [P] Write/confirm an E2E test: the admin standards editor renders
      `allowed-shape-{shape}`/`mandatory-shape-{shape}` checkboxes for all nine new values, and a
      standard mandating one of them (e.g. `hexagon`) actually flags a diagram missing it — this
      exercises the "zero validator change needed" claim end to end rather than taking it on faith.
- [X] T029 [P] Add optional glyphs to `SHAPE_GLYPHS` in `apps/web/src/canvas/Canvas.tsx` for the
      seven new toolbar buttons. Cosmetic only — the existing `SHAPE_GLYPHS[shape] ?? label`
      fallback already handles a missing glyph gracefully, so this is polish, not a blocker.
- [X] T030 Run full validation: `npm run test --workspace=@canvas/diagram-core` (154 + new
      shape/round-trip/collision cases) and `npm run test:e2e --workspace=@canvas/web` (96 + 1
      skipped + new toolbar/render/standards coverage). Confirm counts match.
- [X] T031 Inspect `git diff` across every pre-existing test file this feature touched and confirm
      no existing assertion was weakened anywhere (SC-004).
- [X] T032 Update bead `jmuir-dzd` recording grouping A as implemented, with final suite counts —
      do not close it; groupings B–G (`docs/flowchart-completeness-brief.md`) remain open under the
      same bead.

---

## Dependencies

```
Phase 1 (Setup)
   ↓
Phase 2 (Foundational) ─── thin: one type change, blocks everything only at compile time
   ↓
Phase 3 (US1, P1) ─── MVP groundwork: import + round-trip, no visual change yet
   ↓
Phase 4 (US2, P1) ─── MVP completion: both renderers, both P1 stories now fully deliver
   ↓
Phase 5 (US3, P2) ─── toolbar authoring
   ↓
Phase 6 (Polish)
```

Within Phase 3: T003 must be written and confirmed failing before T004/T005; T006 follows. T007
must be written and confirmed failing before T008; T009 follows. T003↔T007 can be written in
parallel (different files, different concerns — parsing vs. round-trip).

Within Phase 4: T010 before T011; T014 before T013 (or confirmed failing first either way); T016's
ordering relative to T011/T013 is flexible but must genuinely exercise post-implementation markup,
not merely restate the DSL check from Phase 3.

Phase 5 depends on Phase 2 only for the type, but in practice depends on Phase 4 being done first
if you want a toolbar-added shape to look correct immediately rather than as a rectangle — implement
in order regardless of the formal dependency graph.

## Parallel opportunities

- T003 with T007 — parser tests vs. round-trip tests, different concerns
- T010 with T014 — diagram-core render assertions vs. E2E render assertions
- T019 with T025 — toolbar-scoping tests vs. click-adds-correct-shape test
- T027, T028, T029 — admin standards list, its E2E coverage, and toolbar glyphs are independent of
  each other

## Implementation strategy

**MVP = Phase 1 + Phase 2 + Phase 3 + Phase 4.** Both P1 stories ship together — a shape that
imports but doesn't render correctly, or renders but can't be imported, is not really done per
Constitution I. Phase 5 (toolbar authoring) is confirmed in scope by the spec's own clarification
but is P2 — a legitimate second increment.

**Do not stop at "the new shapes parse."** Without T003's five collision-pair regressions
specifically asserting the *wrong* shape was never produced, a `NODE_PATTERNS` ordering mistake
passes every happy-path test silently. And without both T011 and T013, a "done" feature can still
reproduce the exact canvas-vs-export mismatch this research found already living in `cylinder`.
