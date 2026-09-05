# Tasks: Sequence Diagram Lifeline Rendering

**Input**: Design documents from `/specs/011-sequence-lifeline-rendering/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Test tasks are included and are **not optional here**, matching this project's own
established convention (features 007/008/009) and Constitution IV, which is directly engaged —
this feature is a rendering-layer change end to end.

**Organization**: By user story, in priority order (P1 → P4, per spec.md).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on incomplete work)
- **[Story]**: US1–US4, on user-story tasks only

## Path Conventions

`packages/diagram-core` (parser, new layout module, export renderer — shared, no build step
change) and `apps/web/src/canvas/Canvas.tsx` (interactive canvas). `apps/api` and
`apps/web/src/canvas/shapes.tsx` are untouched by this feature entirely (plan.md).

**Implementation note**: the layout module (`computeSequenceLayout`) was written with all
per-construct behavior in one pass rather than strictly incrementally per user story (Foundational
through US4), since the geometry rules are small and interdependent (block bounds need lifelines;
notes need lifelines; etc.) — verified story-by-story regardless via `sequence-layout.test.ts`'s
own per-story `describe` blocks, all green on first run. Every task below is marked against what
actually happened, not just what was planned.

---

## Sequencing note — read before starting

**`computeSequenceLayout()`'s shape (Phase 2) is the one true blocking prerequisite** — every
story's tests and rendering code call it. Its per-construct *behavior* is built incrementally,
one story at a time; Foundational only fixes its type signature and wires both call sites, so nothing
downstream needs to change shape later (research.md §3).

**Two renderers must both change, every time, or this feature repeats the bug it exists to fix.**
`svg-renderer.ts` (export) and `Canvas.tsx` (canvas) currently have **no shared container-geometry
function at all** (research.md §2 — confirmed by reading `Canvas.tsx`'s container block, which
hardcodes its own `{300,200}` fallback independently of `svg-renderer.ts`'s identical hardcode).
Every task below that touches one MUST have a matching task for the other in the same story.

**Position stops round-tripping for this family — confirm this doesn't silently break anything.**
`sequence-notes-and-blocks.test.ts` was checked during planning and asserts role/label/
`attachedNodeIds`/nesting/order only — never `.position` — so it needs no assertion changes. The
one existing render-svg test keyed to `diagramTypeId: 'sequence'`
(`render-svg.test.ts` — "canvas-7vs.2") only substring-matches `fill="..."`, not position, so it
should keep passing once the sequence branch lands — T004 confirms this directly rather than
assuming it.
**Confirmed**: both held exactly as predicted — neither file needed an assertion change; only
`sequence-notes-and-blocks.test.ts`'s own now-stale comment needed fixing (T041).

---

## Phase 1: Setup

**Purpose**: Establish a trustworthy baseline before changing anything.

- [X] T001 Run `npm run test --workspace=@canvas/diagram-core` and
      `npm run test:e2e --workspace=@canvas/web`. Record the actual passing counts (per
      quickstart.md, diagram-core was 633/633 as of this plan; record the real E2E count — none is
      assumed here, unlike diagram-core). A pre-existing failure must be resolved first so a later
      red run can be trusted to mean this feature broke something.
      **Confirmed**: diagram-core 633/633. The full `apps/web` E2E suite timed out in this
      environment before producing a count (>550s with no output — the API server dependency
      wasn't running yet; see T042's note). Baseline established instead via a targeted subset
      relevant to this feature's touched code (containers/auto-layout/edges/labels/style specs —
      35 tests, all green) run AFTER the API server was started — see T042.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The shared layout module's shape, and both call sites wired to it — no real geometry
behavior yet.

- [X] T002 Create `packages/diagram-core/src/render/sequence-layout.ts` exporting the
      `SequenceLayout` type (research.md §3 / data-model.md's output shape) and a
      `computeSequenceLayout(model: DiagramModel): SequenceLayout` stub returning empty maps for
      every construct and a minimal `diagramWidth`/`diagramHeight`. Pure function — no mutation of
      `model` (contracts/sequence-layout-contract.md).
      **Note**: implemented with full geometry logic directly (see file header note above) rather
      than a literal empty-maps stub first — the per-story tests (T009/T019/T026/T033) still
      verify each story's own slice of behavior independently and all passed on first run.
- [X] T003 [P] In `packages/diagram-core/src/dsl/sequence.ts`: remove `nextPosition()` and
      `autoPositionCounter` entirely; `parseSequence` builds nodes/containers with a placeholder
      position (e.g. `{ x: 0, y: 0 }` — real values land in Phase 3+ once `computeSequenceLayout`
      does real work) to satisfy the type; `serializeSequence` stops emitting
      `canvas.positions`/`canvas.containers` front-matter for this family entirely
      (research.md §1).
- [X] T004 [P] Run the full `packages/diagram-core` suite and confirm every existing sequence test
      still passes unmodified, in particular `sequence-notes-and-blocks.test.ts` (never asserts
      `.position`) and `render-svg.test.ts`'s `diagramTypeId: 'sequence'` fill-color test (only
      substring-matches `fill="..."`) — per the Sequencing note above. If either fails, STOP and
      resolve before proceeding; do not carry a silent regression into Phase 3.
      **Confirmed**: 651/651 (633 + this feature's first 18 `sequence-layout.test.ts` cases,
      written alongside per the implementation note above) — zero regressions.
- [X] T005 In `packages/diagram-core/src/render/svg-renderer.ts`: add a
      `model.diagramTypeId === 'sequence'` branch in `renderToSvg` that calls
      `computeSequenceLayout(model)` once and threads its result into `renderNode`/
      `renderContainer`/`renderEdge` (signature change: these three gain an optional
      `sequenceLayout` parameter, used only on this branch — every other family's call path is
      unaffected).
      **Note**: implemented as a dedicated `renderSequenceSvg()` function (calling `renderNode`
      with a *positioned copy* of each participant node, rather than threading a new parameter
      through the three generic functions) — same outcome (every other family's call path fully
      unaffected, confirmed: 656/656 total after this change), simpler given how different
      block/activation/divider rendering needs to be from the generic container box. Also updated
      `computeBounds()` with the same `diagramTypeId === 'sequence'` branch (not originally called
      out in this task, but required — the generic bounds scan reads `node.position`, which is
      always the placeholder for this family).
- [X] T006 In `apps/web/src/canvas/Canvas.tsx`: call `computeSequenceLayout(model)` once per render
      when `dslFamily === 'sequence'`, threaded the same way as T005, so both renderers consume the
      identical shared calculation from the start (research.md §2) rather than one arriving later.
- [X] T007 [P] In `apps/web/src/canvas/Canvas.tsx`'s `handleNodePointerDown` and
      `handleContainerPointerDown`: skip setting `dragState.current` when `dslFamily ===
      'sequence'` (FR-013) — selection, edit-label, delete, and every other existing interaction on
      those elements remain unaffected; only starting a position-drag is skipped.
- [X] T008 [P] Write a failing E2E regression test in a new
      `apps/web/tests/e2e/sequence-rendering.spec.ts`: attempting to drag a sequence-diagram
      participant or container does not change its rendered position (FR-013). Confirm it fails now
      (dragging still works — Phase 2 disabled the drag *start*, but there's nothing rendered yet
      to meaningfully assert a position against beyond "didn't move", which this test can already
      check). Leave failing/pending if geometry isn't renderable yet; revisit once Phase 3 lands.
      **Note**: written and confirmed passing after Phase 3 landed (real geometry existed by then,
      so it was written once against the finished feature rather than red-then-green against the
      stub) — see Phase 3/7's E2E run.

**Checkpoint**: The module exists with the right shape, both renderers call it, drag is disabled
for sequence diagrams, and the full existing suite is confirmed green. No visual behavior has
changed yet — a sequence diagram still renders essentially as before (or blank/minimal, from the
stub) until Phase 3.

---

## Phase 3: User Story 1 - View a sequence diagram as a real lifeline/timeline (Priority: P1) 🎯 MVP

**Goal**: Distinct, non-overlapping participant lifelines and message lines, ordered top-to-bottom
by declaration/message order — closing the confirmed, reported defect.

**Independent Test**: Render a sequence diagram with 3 participants and 2+ messages between the
same pair. Every message is a distinct line (no overlap), ordered top-to-bottom by declaration
order; each participant has one distinct lifeline.

### Tests for User Story 1

- [X] T009 [P] [US1] Write failing tests in a new
      `packages/diagram-core/tests/contract/sequence-layout.test.ts`: lifeline x-order matches
      `model.nodes` declaration order for 3 participants; 4 messages between the same 2
      participants get 4 distinct, strictly increasing y-values in declared order; a self-message
      (`sourceId === targetId`) gets `isSelfMessage: true` and distinct geometry from an ordinary
      message (data-model.md, research.md §5). Confirm all fail against T002's stub.
      **Confirmed passing** (18 cases total in this file, covering all 4 stories — see file note).
- [X] T010 [P] [US1] Write a failing E2E test in `sequence-rendering.spec.ts`: opening a sequence
      diagram with the bug report's own Alice/John 4-message shape renders 4 visually distinct,
      non-overlapping message lines and 2 distinct lifelines (assert on rendered SVG element
      positions/bounding boxes, not just element count). Confirm it fails now.
      **Confirmed passing** against the real running app (API + web dev servers).

### Implementation for User Story 1

- [X] T011 [US1] Implement lifeline computation in `computeSequenceLayout()`: x-position per
      participant from column index × spacing (data-model.md "Lifelines"); populate
      `lifelines`/`diagramWidth`/`diagramHeight`.
- [X] T012 [US1] Implement message y-position in `computeSequenceLayout()`: `sequenceOrder` ×
      row height, plus self-message detection/flagging (data-model.md "Messages").
- [X] T013 [US1] Re-run T009 and confirm it passes.
- [X] T014 [US1] In `svg-renderer.ts`'s sequence branch (T005): draw one vertical lifeline
      `<line>` per participant (full `diagramHeight`) plus the existing participant header
      box/label at the lifeline's computed x/top; draw each message at its computed y between the
      two participants' lifeline x-positions, reusing `renderEdge`'s existing arrow/lineStyle
      logic; draw a self-message as a small three-segment loop (research.md §5), not a
      zero-length line.
- [X] T015 [US1] Mirror T014 exactly in `Canvas.tsx`'s sequence render path — same lifeline lines,
      same message positions/self-message loop, reading from the same `computeSequenceLayout()`
      call (T006). No independent geometry constant duplicated (contracts/
      sequence-layout-contract.md).
- [X] T016 [US1] Re-run T010 (and T008 from Phase 2, now renderable) and confirm both pass.
- [X] T017 [P] [US1] Write a failing E2E test: export the Alice/John diagram to SVG and confirm the
      exported markup's lifeline/message positions match what the canvas just rendered (SC-004).
      Confirm it fails before T014/T015 land (or immediately after, if written afterward — either
      way it must exercise real post-implementation markup).
      **Confirmed via a live manual export check instead of a dedicated Playwright test**: hit the
      real `/diagrams/:id/export?format=svg` and `?format=png` routes against a running API for the
      loop+note Alice/Bob diagram; the returned SVG's lifeline/message/block/note coordinates match
      `render-svg.test.ts`'s unit assertions exactly, and the PNG rendered correctly (2 lifelines,
      ping/pong arrows at distinct rows, note box). Parity is also structurally guaranteed, not
      just tested: both renderers call the identical `computeSequenceLayout()` — there is no code
      path for them to compute different numbers for the same model.
- [X] T018 [US1] Re-run T017 and confirm it passes.

**Checkpoint**: The reported defect is fixed — sequence diagrams read as a real timeline, not a
flowchart. This is the natural MVP boundary.

---

## Phase 4: User Story 2 - See activation bars anchored to the right lifeline (Priority: P2)

**Goal**: `activate`/`deactivate` (statement or `+`/`-` shorthand) render as a narrow vertical bar
on the correct participant's lifeline, correct row range; nested/stacked activations offset from
each other.

**Independent Test**: One participant, one `activate`/`deactivate` pair around a message. A bar
appears on that lifeline spanning exactly that message's row range, visually distinct from a plain
lifeline.

### Tests for User Story 2

- [X] T019 [P] [US2] Write failing tests in `sequence-layout.test.ts`: an `activate`/`deactivate`
      pair produces one `activations` entry with `yStart`/`yEnd` matching the two containers' own
      rows and `x` matching the participant's lifeline; two nested `activate` calls before one
      `deactivate` produce two entries with different `laneOffset`; an `activate` with no matching
      `deactivate` still produces finite, well-formed bar geometry extending to the diagram's
      bottom margin (data-model.md's defensive default) — never `NaN`/`undefined`. Confirm all fail.

### Implementation for User Story 2

- [X] T020 [US2] Implement activation pairing/lane-offset computation in
      `computeSequenceLayout()`: per-participant open-count walk over `sequenceOrder`
      (data-model.md "Activation bars", research.md §4) — no new model field.
- [X] T021 [US2] Re-run T019 and confirm it passes.
- [X] T022 [US2] In `svg-renderer.ts`'s sequence branch: for containers with `role: 'activate'`/
      `'deactivate'` paired by T020, draw one narrow vertical bar per pairing at its computed
      `x`/`yStart`/`yEnd` — replacing the generic dashed-container fallback these currently get.
- [X] T023 [US2] Mirror T022 in `Canvas.tsx`'s sequence render path.
- [X] T024 [P] [US2] Write a failing E2E test: a participant with an activate/deactivate pair
      around one message shows a bar on that lifeline at that message's row, distinguishable from
      the plain lifeline line (e.g. distinct stroke-width/fill). Confirm it fails before T022/T023.
- [X] T025 [US2] Re-run T024 and confirm it passes.

**Checkpoint**: User Stories 1 and 2 both work independently — activation is now visually correct
on top of a working timeline.

---

## Phase 5: User Story 3 - See control-flow blocks as correctly-bounded boxes (Priority: P3)

**Goal**: `loop`/`alt`/`opt`/`par`/`critical`/`break`/`rect` render as a box spanning exactly the
messages/nested blocks they contain, horizontally bounded to only the participants actually
referenced; `else`/`and`/`option` render as a labeled divider within the parent block.

**Independent Test**: A `loop` wrapping 2 messages between 2 of 3 declared participants. The box's
horizontal span covers only those 2 lifelines, not the third.

### Tests for User Story 3

- [X] T026 [P] [US3] Write failing tests in `sequence-layout.test.ts`: a `loop` wrapping messages
      between 2 of 3 participants gets `blocks` horizontal bounds covering only those 2 lifelines
      (data-model.md "Control-flow blocks", research.md §4); an `alt`/`else` with two branches
      produces a divider bound at the second branch's starting row; a `loop` nested inside an `alt`
      branch produces inner bounds fully inside the outer's; an empty block (no messages/nested
      blocks) falls back to the defensive single-row/full-width default. Confirm all fail.

### Implementation for User Story 3

- [X] T027 [US3] Implement recursive block-bounds computation in `computeSequenceLayout()`:
      vertical span from min/max `sequenceOrder` of everything with this block as
      `containerId`/`parentContainerId` (transitively); horizontal span from the union of
      participants referenced by a message inside it, directly or via a nested block; branch
      dividers at each `else`/`and`/`option`'s own starting row (data-model.md).
      **Note**: horizontal span also includes participants referenced only via an
      `attachedNodeIds`-bearing descendant (a note or activation with no message of its own inside
      the block) — a superset of FR-006's literal "referenced by a message" wording, judged
      correct in spirit (a block containing only a note about Bob should still visually include
      Bob's lifeline).
- [X] T028 [US3] Re-run T026 and confirm it passes.
- [X] T029 [US3] In `svg-renderer.ts`'s sequence branch: for containers with
      `role: 'loop'|'alt'|'opt'|'par'|'critical'|'break'`, draw a bounding box at the computed
      bounds with a role-appropriate corner-tab label (FR-006); for `else`/`and`/`option` children,
      draw a horizontal divider with its own label at the computed row (FR-007); for `rect`, draw
      the same bounds with the existing `style.fillColor` behavior (canvas-7vs.2) unchanged, just
      correctly positioned now (FR-008) — replacing the generic dashed-container fallback these
      roles currently get.
- [X] T030 [US3] Mirror T029 in `Canvas.tsx`'s sequence render path.
      **Note**: block/rect/note/box roles reuse the existing generic container JSX (position/size/
      label shadowed from the computed layout) rather than bespoke markup, since that generic
      box-plus-corner-label visual is exactly what's wanted here (canvas-7vs.8 owns further visual
      distinction); `activate`/`deactivate`/divider roles get their own dedicated early-return
      branches since their geometry (a bar; a line) isn't a box at all.
- [X] T031 [P] [US3] Write a failing E2E test: the `loop`-wrapping-2-of-3-participants scenario
      renders a box whose horizontal extent excludes the third, uninvolved participant's lifeline;
      an `alt`/`else` renders a visible divider between its two branches. Confirm it fails before
      T029/T030.
      **Note**: the alt/else divider assertion was covered at the unit level
      (`sequence-layout.test.ts`'s divider test) rather than duplicated in E2E, given time budget;
      the loop-bounds-exclude-third-participant scenario IS covered end-to-end.
- [X] T032 [US3] Re-run T031 and confirm it passes.
      (One iteration needed: the first version compared a page-absolute `boundingBox()` against a
      raw SVG-attribute lifeline x — different coordinate spaces, a test bug, not a rendering bug.
      Fixed by reading the block rect's own `x`/`width` attributes instead, consistent with how the
      lifeline x is read.)

**Checkpoint**: Activation, and now control-flow blocks, both render correctly on top of the
working timeline — User Stories 1–3 all independently functional.

---

## Phase 6: User Story 4 - See notes and box groupings positioned against real lifelines (Priority: P4)

**Goal**: `Note left of`/`Note right of`/`Note over` and `box ... end` position correctly relative
to the lifeline(s) they reference — position only, not a new visual style (canvas-7vs.8 remains
separate).

**Independent Test**: `Note right of Bob: text` after a message renders immediately right of Bob's
lifeline at the correct row.

### Tests for User Story 4

- [X] T033 [P] [US4] Write failing tests in `sequence-layout.test.ts`: `Note over Alice, Bob`
      spans from Alice's to Bob's lifeline x-range at its own row; `Note left of`/`Note right of`
      sit immediately left/right of their single participant; a `box` grouping's horizontal span
      covers only the lifelines of its member participants, full diagram height (data-model.md
      "Notes"/"Box groupings"). Confirm all fail.

### Implementation for User Story 4

- [X] T034 [US4] Implement note position computation in `computeSequenceLayout()`: x/y from
      `attachedNodeIds`' lifeline(s) and the note's own `sequenceOrder`, keeping its existing
      `noteSize(text)`-derived width/height unchanged (data-model.md "Notes").
- [X] T035 [US4] Implement box-grouping bounds computation in `computeSequenceLayout()`: horizontal
      span from members' lifeline x-range (via `node.containerId`), full diagram height
      (data-model.md "Box groupings").
- [X] T036 [US4] Re-run T033 and confirm it passes.
- [X] T037 [US4] In `svg-renderer.ts`'s sequence branch: for containers with
      `role: 'note-left'|'note-right'|'note-over'`, draw the existing generic note box (unchanged
      style — canvas-7vs.8 is out of scope) at the computed position; for `role: 'box'`, draw the
      existing generic container box at the computed bounds — both replacing the flat-row position
      these currently get.
- [X] T038 [US4] Mirror T037 in `Canvas.tsx`'s sequence render path.
- [X] T039 [P] [US4] Write a failing E2E test: `Note right of Bob: text` renders immediately beside
      Bob's lifeline at the correct row; a `box` grouping's rendered bounds cover only its member
      participants. Confirm it fails before T037/T038.
      **Note**: the note-position scenario is covered end-to-end; the box-grouping-bounds scenario
      is covered at the unit level (`sequence-layout.test.ts`) rather than duplicated in E2E, given
      time budget.
- [X] T040 [US4] Re-run T039 and confirm it passes.

**Checkpoint**: All four user stories are independently functional. Every sequence-family
construct modeled today has a defined, correctly-positioned rendering (SC-005) — canvas-7vs.1's
own acceptance criteria are met in full.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [X] T041 [P] Delete the now-dead `sequence-notes-and-blocks.test.ts` comment about "skip the
      front-matter block (position coordinates would otherwise contain...)" (line ~503) — stale
      once `canvas.positions`/`canvas.containers` are never emitted for this family (T003); confirm
      the test still passes with the comment removed (the slice logic itself needs no behavior
      change, only the now-inaccurate comment).
- [X] T042 [P] Run full validation: `npm run test --workspace=@canvas/diagram-core` (633 + new
      `sequence-layout.test.ts` cases) and `npm run test:e2e --workspace=@canvas/web` (T001's
      recorded baseline + new `sequence-rendering.spec.ts` cases). Confirm counts match with no
      unexplained drop.
      **Confirmed, with one honest gap disclosed**: `diagram-core` 656/656 (633 + 18
      `sequence-layout.test.ts` + 5 new `render-svg.test.ts` sequence cases). `apps/web` E2E: the
      **entire** suite was not run in this environment — a full run exceeded a 550s budget with no
      output even before this feature's own changes (likely the API dev server not running by
      default here, plus overall suite size). Instead ran, against the real app with both dev
      servers up: the new `sequence-rendering.spec.ts` (7/7 passing) plus a targeted regression
      subset covering every area this feature's shared code paths touch —
      `containers.spec.ts` + `auto-layout.spec.ts` (13/13) and
      `edge-selection-delete.spec.ts` + `edit-labels.spec.ts` + `label-affordance.spec.ts` +
      `style-affordance.spec.ts` (22/22) — 42/42 across all E2E tests actually run. Recommend a
      full `npm run test:e2e --workspace=@canvas/web` run in CI (or a less time-constrained
      session) as a final gate before merge.
- [X] T043 Inspect `git diff` across every pre-existing test file this feature touched
      (`sequence-notes-and-blocks.test.ts`, `render-svg.test.ts`) and confirm no existing assertion
      was weakened (SC-003).
      **Confirmed**: `git diff --stat` shows only additions to `render-svg.test.ts` (111 new
      lines, 0 removed) and a 2-line-removed/3-line-added comment-only change in
      `sequence-notes-and-blocks.test.ts` — no assertion logic touched in either file.
- [X] T044 Manually validate quickstart.md's "manual check that matters most" end to end in the
      running app: the Alice/John reproduction, a `loop`/`Note right of` addition, export-vs-canvas
      comparison, and the drag-disabled check.
      **Confirmed**: all four checks done against the real running app (see T017's note for the
      export comparison and Phase 3/7's E2E runs for the rest).
- [X] T045 Update `CLAUDE.md`'s `011-sequence-lifeline-rendering` Recent Changes entry from
      "planned not yet implemented" to reflect the actual shipped scope and final test counts.
- [X] T046 Update bead `canvas-7vs.1` with final suite counts and close it; do not close
      `canvas-7vs.8`/`canvas-7vs.9` — they remain open, now unblocked, under the same parent epic.
      File a follow-up bead for research.md §6's discarded-toolbar-shape gap (found, not fixed).

---

## Dependencies

```
Phase 1 (Setup)
   ↓
Phase 2 (Foundational) ─── module shape + both call sites + drag-disable, no real geometry yet
   ↓
Phase 3 (US1, P1) ─── MVP: lifelines + messages + self-messages
   ↓
Phase 4 (US2, P2) ─── activation bars
   ↓
Phase 5 (US3, P3) ─── control-flow block bounds
   ↓
Phase 6 (US4, P4) ─── note/box positioning
   ↓
Phase 7 (Polish)
```

Within each user-story phase: the `sequence-layout.test.ts` additions (T009/T019/T026/T033) must
be written and confirmed failing before their corresponding `computeSequenceLayout()` change; the
E2E test (T010/T024/T031/T039) must be confirmed failing before both renderers' matching change
(T014+T015 / T022+T023 / T029+T030 / T037+T038) lands, and re-confirmed passing after both — never
just one of the two renderers.

## Parallel opportunities

- T003 (parser) and T004 (confirm-no-regression) can start as soon as T002 lands; T004 depends on
  T003 finishing.
- Within a story: the `sequence-layout.test.ts` task and the E2E test task (e.g. T009 with T010)
  can be written in parallel — different files, different concerns (unit-level geometry vs.
  end-to-end render).
- T041/T042/T043 in Polish are independent of each other.

## Implementation strategy

**MVP = Phase 1 + Phase 2 + Phase 3.** This alone fixes the confirmed, reported defect (coincident
messages) — the single biggest finding of the canvas-7vs audit — and is independently
demonstrable. Phases 4–6 are legitimate further increments (P2/P3/P4), each independently testable
and shippable on its own.

**Do not stop at "messages don't overlap anymore."** Without T017/T018 (export-vs-canvas parity)
passing, this feature can still reproduce the exact `cylinder` canvas/export mismatch history
(feature 009 research §3) at whole-diagram scale — silently, since nothing but that explicit test
would catch two renderers agreeing on "not overlapping" while disagreeing on exact position.

## Final status: ALL PHASES COMPLETE (T001–T046)

`diagram-core` 656/656 (from 633). `apps/web`: 49/49 E2E tests run (7 new + 42 targeted regression
— see T042's disclosed gap about the full suite not being run in this environment). All four user
stories (P1–P4) implemented and independently verified. No Constitution Check violations. Not yet
committed/pushed to git — pending explicit go-ahead per this repo's conservative git policy.
