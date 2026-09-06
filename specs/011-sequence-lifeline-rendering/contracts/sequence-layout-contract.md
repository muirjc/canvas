# Consumption Contract: `computeSequenceLayout()`

No API, no schema — the contract here is the shared layout function itself: what every caller may
rely on, and what must never regress once both renderers depend on it (SC-004).

## Signature

```text
computeSequenceLayout(model: DiagramModel): SequenceLayout
```

Pure function: no mutation of `model` or anything reachable from it. Same model in → byte-identical
numbers out, every call (no hidden state, no counter — unlike the `nextPosition()` module-level
counter it replaces, which required a manual `autoPositionCounter = 0` reset between parses).

## Callers

| Caller | File | Must NOT do |
|---|---|---|
| Export renderer | `packages/diagram-core/src/render/svg-renderer.ts` | Read `node.position`/`container.position` for sequence-family rendering — those are set from a prior `computeSequenceLayout()` call at parse time and would drift as soon as this function's constants change. |
| Interactive canvas | `apps/web/src/canvas/Canvas.tsx` | Reimplement any part of this calculation independently — every x/y/width/height the canvas draws for a sequence diagram comes from this function's own return value, not a hand-copied constant. |
| Sequence parser | `packages/diagram-core/src/dsl/sequence.ts` | Call this only to populate `position`/`size` once at parse time (satisfying the model's required fields) — never re-derive layout meaning from those values afterward; `serializeSequence` does not read them back out for round-trip (research.md §1). |

## Contract requirements

- **Determinism**: given the same `DiagramModel`, every call returns identical geometry — required
  for canvas/export parity (a diagram's export must match what was last shown on screen) and for
  `parseSequence`'s own one-time call at parse time to be safe to make exactly once.
- **Completeness**: every node in `model.nodes` gets a `lifelines` entry; every edge gets a
  `messages` entry; every container gets exactly one of `activations`/`blocks`/`notes`/`boxes`
  according to its `role` (data-model.md's per-construct rules) — no container silently
  unaccounted for.
- **No NaN/undefined geometry**: a malformed-but-not-a-parse-error input (an `activate` with no
  matching `deactivate`, an empty block) MUST still produce well-formed finite numbers per
  data-model.md's defensive-default rules — never `undefined`/`NaN` propagated into an SVG
  attribute or React style prop.
- **Stable ordering**: lifeline column order and message/block/note row order are single-sourced
  from `model.nodes` order and `sequenceOrder` respectively — never independently re-sorted by a
  caller (that would risk canvas and export disagreeing on tie-breaking).

## Explicitly unchanged / out of scope

- No other DSL family's rendering — this function is imported ONLY where
  `model.diagramTypeId === 'sequence'` (export) or `dslFamily === 'sequence'` (canvas); every other
  family's existing node/container/edge rendering path is untouched.
- Visual styling of notes/boxes/blocks beyond correct position and size (canvas-7vs.8) — this
  contract governs geometry, not color/border-style choices.
- Drawing an attachment connector line from a note/activation marker to its participant
  (canvas-7vs.9) — this contract supplies the participant's lifeline x-position such a connector
  would need, but drawing it is out of scope here.
