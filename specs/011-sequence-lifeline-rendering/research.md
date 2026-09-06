# Phase 0 Research: Sequence Diagram Lifeline Rendering

Grounded in direct inspection of `sequence.ts`, `svg-renderer.ts`, and `Canvas.tsx`. Each decision
records what was chosen, why, and what was rejected.

---

## 1. Position stops round-tripping for sequence diagrams — a deliberate, disclosed exception

**Decision**: `parseSequence` still populates every `DiagramNode.position`/`DiagramContainer.
position` (the type requires it — it's not optional), but from `computeSequenceLayout()`'s own
computed output rather than the current flat `nextPosition()` counter. `serializeSequence` stops
emitting the `canvas.positions`/`canvas.containers` front-matter block for sequence models
entirely — there is nothing to preserve, since it will be immediately recomputed (and therefore
ignored) on the next parse regardless of what's written.

**Rationale**: Constitution Principle I's round-trip guarantee is enumerated explicitly —
"no silent loss of shapes, connectors, labels, or grouping." Position is not in that list, and for
this family it was never a real DSL construct to begin with: what a hand-authored sequence diagram
actually specifies is participant declaration *order* and message *order*, both of which already
round-trip perfectly via ordinary line order (unaffected by this feature). Continuing to write a
`canvas.positions` block whose values are silently ignored on every subsequent parse would be
worse than omitting it — a plausible-looking stored value that lies about what will actually
render is a more dangerous trap than no stored value at all. This mirrors how
`DiagramContainer.direction`/`DiagramModel.architectureAlignments` are already documented as
"preserved for round-trip only, doesn't drive layout" — except in reverse: those fields ARE real
DSL text that must survive re-save; sequence's `position` was never DSL text at all, just an
internal auto-placement counter's output.

**Alternatives rejected**: keeping `canvas.positions` round-trip for sequence "for consistency with
other families" — inconsistent on the surface but actively misleading in practice, since every
other family's stored position is real (user-draggable, honored on next render); sequence's would
be the only stored-but-ignored value in the entire front-matter contract.

---

## 2. One shared layout function, not two independent implementations

**Decision**: A new `computeSequenceLayout(model): SequenceLayout` in
`packages/diagram-core/src/render/sequence-layout.ts`, exported and called by BOTH
`svg-renderer.ts`'s `renderNode`/`renderContainer`/`renderEdge` (keyed on
`model.diagramTypeId === 'sequence'`) and `Canvas.tsx`'s render loop (keyed on its existing
`dslFamily === 'sequence'` prop).

**Rationale**: Direct inspection of `Canvas.tsx`'s container-rendering block (`container.position.
x`/`container.size ?? {300,200}`, read straight off the model) confirms there is currently **no**
shared container-geometry function at all — `svg-renderer.ts`'s `renderContainer` hardcodes the
identical fallback independently. This is the same class of canvas/export disagreement risk
feature 009's research flagged for shape rendering (`cylinder` rendering differently on canvas vs.
export, research 009 §3) — except deploying it for *node* geometry already has a shared function
(`nodeSize`/`tableNodeLayout`/`iconNodeLayout`, all exported from `svg-renderer.ts` and imported by
`Canvas.tsx`/`shapes.tsx`). This feature is whole-diagram-layout-scale, so introducing it as two
independently hand-copied calculations would be a much larger version of a mistake this codebase
has already made and already knows to avoid (SC-004 exists specifically because of this history).

**Alternatives rejected**: computing layout inline in each renderer separately (repeats the
disagreement risk at a larger scale); putting the function in `apps/web` and having
`svg-renderer.ts` (in `diagram-core`, which `apps/web` depends on, not the reverse) import it
(wrong dependency direction — `diagram-core` cannot depend on `apps/web`).

---

## 3. What `computeSequenceLayout()` actually returns

**Decision**: A flat structure keyed by id, not a mutated copy of the model:

```text
{
  lifelines: Map<participantId, { x: number, top: number, bottom: number, width: number }>,
  messages: Map<edgeId, { y: number, isSelfMessage: boolean }>,
  activations: Map<containerId, { participantId: string, x: number, yStart: number, yEnd: number, laneOffset: number }>,
  blocks: Map<containerId, { x: number, y: number, width: number, height: number }>,   // loop/alt/opt/par/critical/break/rect + their else/and/option branch dividers
  notes: Map<containerId, { x: number, y: number, width: number, height: number }>,     // note-left/right/over
  boxes: Map<containerId, { x: number, y: number, width: number, height: number }>,     // box groupings
  diagramWidth: number,
  diagramHeight: number,
}
```

**Rationale**: Matches this file's own established pattern (`tableNodeLayout`/`iconNodeLayout`
return full render geometry derived from the model, not a mutated node) rather than writing
computed values back into `node.position` and having callers re-derive meaning from a generic
`Size`. Both renderers need slightly different final output (SVG attributes and colors on one
side, React elements and interaction handlers on the other) but must agree on every *number* — this
shape gives them exactly that, and nothing else.

**Alternatives rejected**: mutating `DiagramNode.position` in place inside the layout function and
having renderers read it back off the model (loses the distinction between "authoritative model
data" and "derived render geometry," and reintroduces exactly the stale-front-matter risk decision
1 above rules out).

---

## 4. Column order, activation lane offsets, and block bounds are all derived, not stored

**Decision**:
- Lifeline x-order = a participant's position in `model.nodes` (which `parseSequence` already
  builds in first-declaration order via `ensureParticipant`, including `box`-grouped and
  `create`d participants).
- Message/activation/block/note y-position = `sequenceOrder` (already on the model for both
  `DiagramEdge` and `DiagramContainer` for exactly this purpose).
- Nested/stacked activations on the same participant get `laneOffset` = current nesting depth for
  that participant at that point in the timeline (computed with a simple per-participant open-count
  while walking `sequenceOrder` — not a new model field).
- A block's bounds = the min/max `sequenceOrder` of everything with that `parentContainerId`
  (vertical) and the union of every participant referenced by a message/nested-block inside it
  (horizontal) — recursively, so a block nested inside a block still only spans its own actually-
  referenced participants, not its parent's full span.

**Rationale**: Every input this needs (`sequenceOrder`, `parentContainerId`, `containerId`,
`attachedNodeIds`) already exists on the model exactly as jmuir-dtu.4/.4.1 built it — no new field,
no parser change beyond what decision 1 already covers.

**Alternatives rejected**: adding a `DiagramContainer.laneOffset`/`bounds` field computed once at
parse time and stored (reintroduces the "stored but must never drift from what's actually
rendered" risk decision 1 exists to avoid — compute it fresh every render instead, it's cheap).

---

## 5. Self-messages get a distinct loop shape, not a zero-length line

**Decision**: When `edge.sourceId === edge.targetId`, `computeSequenceLayout()` marks
`isSelfMessage: true` for that message; both renderers draw a small three-sided loop (out from the
lifeline, down, back in) instead of `renderEdge`'s ordinary two-point line, matching real Mermaid's
own self-message convention.

**Rationale**: `MESSAGE_PATTERN` already accepts `A->>A: text` today (nothing in the regex forbids
matching ids), so this is a real, currently-reachable, currently-broken case (today: two identical
node positions collapse the arrow to nothing visible) — not a hypothetical. Explicitly named as an
edge case in spec.md.

**Alternatives rejected**: leaving self-messages unhandled/undefined (spec.md's edge cases section
explicitly calls this out, so it's in scope, not deferred).

---

## 6. Found but explicitly not fixed: the "Add Shape" toolbar's shapes don't survive a sequence diagram

**Decision**: No change to `getAddableShapes`/`Canvas.tsx`'s toolbar for sequence diagrams.

**Rationale**: `getAddableShapes('sequence')` today falls through to `UNIVERSAL_SHAPES` (four
generic shapes) — but `serializeSequence` (unchanged by this feature) re-emits every node as a
plain `participant`/`actor` line regardless of its `shape` field, silently discarding whatever
shape was actually chosen. This is a real, independently-confirmed gap, found during this feature's
research — but it's a toolbar/serializer mismatch that predates canvas-7vs.1 and isn't what it
asked for (per Constitution VI, not folded into this feature's scope). Recorded here and in
plan.md's Complexity Tracking so it isn't lost; candidate for its own follow-up bead.

**Alternatives rejected**: hiding the "Add Shape" toolbar entirely for sequence diagrams as part of
this feature (a real fix, but a scope expansion beyond canvas-7vs.1's own ask — participant
declarations, not toolbar-added generic shapes, are how a sequence diagram actually gains a new
lifeline).
