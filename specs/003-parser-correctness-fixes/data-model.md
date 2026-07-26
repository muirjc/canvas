# Data Model: Mermaid Parser Correctness Fixes

Extends `packages/diagram-core/src/model/diagram-model.ts` (001's shared `DiagramModel`). Only
the deltas are described here; all fields not listed are unchanged. Every new field is optional,
so every existing diagram family that never sets it is unaffected (FR-004/FR-008/FR-014's
no-regression requirements).

## DiagramNode (extended)

| Field | Type | Notes |
|---|---|---|
| attributes | `{ type: string; name: string; keys: string[] }[]?` | ER diagrams only (FR-005). `keys` holds whichever of `PK`/`FK`/`UK` were declared, in declared order. An attribute with an unrecognized constraint keyword still appears here with that keyword simply absent from `keys` (FR-007) — its type/name are still preserved. Undefined for every other diagram family and for ER entities with no attribute block (FR-008). |

## DiagramEdge (extended)

| Field | Type | Notes |
|---|---|---|
| arrow | `'none' \| 'source' \| 'target'` (optional) | Architecture diagrams only (FR-001–FR-003). `-->` → `'target'`, `<--` → `'source'`, `--` → `'none'`/undefined. Undefined for every other diagram family, preserving today's behavior exactly (FR-004). |
| sourceAnchor / targetAnchor | `'T' \| 'B' \| 'L' \| 'R'` (optional) | Architecture diagrams only (FR-002/FR-003). The `:T`/`:B`/`:L`/`:R` anchor hint present at each endpoint, if any — the concrete field pair backing the "Architecture Edge Endpoint" entity below. |
| sequenceOrder | number (optional) | Sequence diagrams only (FR-012). Monotonically increasing, assigned by the parser in source-text encounter order; used by the serializer to interleave messages with notes/block boundaries correctly (research.md §3). Undefined for every other diagram family. |
| containerId | ElementId (optional) | Sequence diagrams only. Id of the control-flow-block/branch `DiagramContainer` this message is nested inside, if any — mirrors `DiagramNode.containerId`'s existing meaning, extended to edges since a message (not just a node) can be nested inside a block. |

## DiagramContainer (extended)

| Field | Type | Notes |
|---|---|---|
| role | string (optional) | For sequence diagrams: one of `note-left`, `note-right`, `note-over`, `loop`, `alt`, `else`, `opt`, `par`, `and`, `critical`, `option`, `break` (FR-009/FR-010). The three `note-*` values fold the note's position keyword into the same discriminator slot, so no separate field is needed to remember which of `Note left of`/`Note right of`/`Note over` was originally used. Mirrors `DiagramNode.role`'s existing purpose. Undefined for flowchart subgraphs and C4 boundaries — their existing behavior is unaffected. |
| attachedNodeIds | string[] (optional) | Sequence notes only (`role` starts with `note-`). One id for `note-left`/`note-right`; one or more for `note-over` (FR-009, per clarification Q2). Undefined/unused for every other container. |
| sequenceOrder | number (optional) | Sequence diagrams only — see `DiagramEdge.sequenceOrder` above; applies identically to note and control-flow-block containers so both element types can be sorted into one interleaved sequence on export. |

**Nesting**: A control-flow block's branches (`alt`'s `else`, `par`'s `and`, `critical`'s
`option`) are child containers referencing the parent block via the existing
`parentContainerId` field — no new nesting mechanism (FR-011; research.md §1). A message or note
belonging to a specific block/branch references it via the existing `containerId` field, exactly
as a flowchart node references its enclosing subgraph today.

**Sizing**: Note containers are given an explicit, small `size` by the parser (not the renderer's
generic `300×200` fallback), so they render as small annotations rather than oversized empty
boxes (research.md §2). Control-flow-block containers use the existing fallback sizing
unchanged.

## Parse error shape (unchanged, new producers)

No change to `ParseError`'s existing `{ line, content, message }` shape. Two new producers of it:

- An unclosed sequence control-flow block (FR-013): `message` identifies the specific block and
  its opening line (research.md §7).
- An unclosed ER attribute block (FR-018): `message` identifies the specific entity and its
  opening line (research.md §7).

## Entity Relationship Summary (delta)

```
DiagramContainer (role: 'note') ── attachedNodeIds ──> DiagramNode (participant), 1..*
DiagramContainer (role: 'alt'|'par'|'critical') ── parentContainerId ──< DiagramContainer (role: 'else'|'and'|'option')
DiagramEdge / DiagramContainer ── containerId ──> DiagramContainer (enclosing block/branch)
```

No changes to the persisted `Diagram` database entity or any relationship outside
`DiagramModel` — this feature is confined to the in-memory model and its DSL parse/serialize
functions.
