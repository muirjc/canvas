# Phase 1 Data Model: Sequence Diagram Lifeline Rendering

No new model entity or field. This documents `computeSequenceLayout()`'s output shape (research.md
§3) and the exact geometry rule for each construct — the thing both renderers must agree on
(SC-004).

## Inputs (all already exist on `DiagramModel`)

| Field | Used for |
|---|---|
| `model.nodes` (order) | Lifeline column x-order (first-declaration order) |
| `DiagramEdge.sequenceOrder` | Message vertical position |
| `DiagramContainer.sequenceOrder` | Block/note vertical position |
| `DiagramContainer.parentContainerId` | Block nesting → recursive bounds |
| `DiagramContainer.role` | Which geometry rule applies (activate/deactivate/loop/alt/.../note-*/box/rect) |
| `DiagramContainer.attachedNodeIds` | Which lifeline(s) a note/activation anchors to |
| `DiagramNode.containerId` | Which `box` grouping a participant belongs to |
| `DiagramEdge.sourceId`/`targetId` | Which lifelines a message spans; self-message detection |
| `model.sequenceAutonumber` | Whether/how to render a running message number |

## Output: `SequenceLayout`

See research.md §3 for the full type. Geometry constants (spacing, lifeline top margin, row
height, activation bar width, lane offset step) live alongside `computeSequenceLayout()` itself,
following this file's own established pattern of co-locating layout constants with the function
that uses them (e.g. `ICON_GLYPH_SIZE`/`ICON_PADDING` next to `iconNodeLayout`).

## Per-construct geometry rules

### Lifelines (participants/actors)

- **x**: column index (0-based, first-declaration order in `model.nodes`) × a fixed column
  spacing, plus a left margin.
- **Header box**: participant's existing node shape/size (rectangle or person, per role) sits at
  the lifeline's top, unchanged from today's node rendering — only its *position* is now
  column-derived instead of flat-row.
- **Lifeline itself**: a vertical line from the header box's bottom to the diagram's computed
  bottom (`diagramHeight` minus a bottom margin) — full height, always (spec Assumptions: no
  `create`/`destroy` partial-height truncation in this pass).

### Messages (including self-messages)

- **y**: `sequenceOrder` × a fixed row height, plus a top offset below the lifeline headers.
- **Ordinary message** (source ≠ target): horizontal line between the two participants' lifeline
  x-positions at that y — reuses the existing arrow/lineStyle rendering `renderEdge` already has,
  just at the newly-computed y instead of the two nodes' generic centers.
- **Self-message** (source === target, research.md §5): a three-segment loop out from the
  lifeline, down one row's worth, and back in, with the label to its right.
- **Autonumber**: when `model.sequenceAutonumber` is set, each message's rendered number derives
  from its position among ordered messages plus `start`/`step` — computed the same way whether
  reading the front-matter-free source or an already-parsed model; no new field.

### Activation bars (`role: 'activate'`/`'deactivate'`)

- An activate/deactivate PAIR is derived at layout time by walking messages/containers in
  `sequenceOrder` per participant: the Nth `activate` for a participant pairs with the Nth
  following `deactivate` for that same participant (a simple open-count stack per participant —
  no new model field, mirrors how `pushPointItem`'s own point-in-time containers already have no
  linked pairing stored, per `diagram-model.ts`'s own doc comment).
- **x**: that participant's lifeline x, offset outward by `laneOffset × barSpacing` for nested/
  stacked activations (research.md §4).
- **yStart/yEnd**: the activating/deactivating item's own row y (per the Messages rule above, since
  `activate`/`deactivate` containers carry `sequenceOrder` exactly like messages do).
- An `activate` with no matching later `deactivate` for that participant (malformed but not a parse
  error today) renders its bar extending to `diagramHeight`'s bottom margin — a defensive default,
  not a new validation error.

### Control-flow blocks (`role: 'loop'|'alt'|'opt'|'par'|'critical'|'break'|'rect'`, and their
`else`/`and`/`option` branch children)

- **Vertical span**: min `sequenceOrder` to max `sequenceOrder` among every message/nested-block
  whose `containerId`/`parentContainerId` (directly or transitively) is this block — plus a fixed
  header-row allowance for the corner label.
- **Horizontal span**: the union of every participant lifeline referenced (as source or target) by
  a message inside this block, directly or via a nested block — NOT the full diagram width, unless
  every declared participant happens to be referenced (research.md §4; spec FR-006/Acceptance
  Scenario 1).
- **Branch divider** (`else`/`and`/`option`): a horizontal line at that branch's own starting
  `sequenceOrder`'s y, spanning the parent block's horizontal bounds, labeled with the branch's own
  `label` if given (FR-007).
- **`rect`**: identical bounds rule; its existing `style.fillColor` rendering (canvas-7vs.2) is
  unchanged, just correctly positioned/sized now instead of floating (FR-008).
- An empty block (no messages/nested blocks — malformed but not a parse error) falls back to a
  minimum single-row height and the full diagram width, since there is nothing to derive a
  tighter bound from — a defensive default, not a new validation error.

### Notes (`role: 'note-left'|'note-right'|'note-over'`)

- **y**: this container's own `sequenceOrder` row.
- **x/width**: `note-left`/`note-right` sit immediately left/right of the single participant in
  `attachedNodeIds`; `note-over` spans from the leftmost to the rightmost participant named in
  `attachedNodeIds` (already supports multiple participants — `NOTE_PATTERN`'s comma-separated
  list).
- Existing `size` (from `noteSize(text)`, unchanged) still governs the box's own width/height
  content-fit; only its x/y position is now computed instead of flat-row.

### Box groupings (`role: 'box'`)

- **Horizontal span**: the lifeline x-range of every participant whose `containerId` is this box
  (already how membership is modeled).
- **Vertical span**: full diagram height, like the lifelines it groups (a box exists behind its
  members' entire lifelines, not one message-range slice).

## Explicitly unchanged

- `DiagramNode`/`DiagramEdge`/`DiagramContainer`'s own field shapes — no addition, no removal.
- Every other DSL family's parse/serialize/render behavior.
- `sequence.ts`'s parsing logic for every construct (participant/message/block/note/box/
  activate/autonumber) — only what happens to `position`/`size` after parsing changes.
