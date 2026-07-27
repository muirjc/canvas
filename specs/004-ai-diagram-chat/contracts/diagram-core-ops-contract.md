# Contract: `diagram-core` model operations (new, extends 002's `diagram-core-ops-contract.md`)

Pure functions over `DiagramModel`, no I/O — used identically by the canvas's manual UI and by
the server-side AI tool-calling layer (research.md §1).

## `addNode(model: DiagramModel, input: { shape: NodeShape; label?: string }): DiagramModel`

- **Invariant**: Appends exactly one new node with a freshly-generated id, the given `shape`, and
  `label` (defaulting to `"New Node"` if omitted), positioned via the same auto-layout grid rule
  the canvas's manual "Add Shape" button already uses. Every other part of the model is
  untouched.
- **Invariant**: Never fails — any valid `NodeShape` produces a node; there is no invalid input
  this function itself rejects (the AI-tool wrapper around it, not this function, is responsible
  for deciding whether a requested shape/label makes sense).

## `addEdge(model: DiagramModel, input: { sourceId: string; targetId: string; label?: string }): DiagramModel`

- **Invariant**: Appends exactly one new edge with a freshly-generated id, `sourceId`, `targetId`,
  and optional `label`. Every other part of the model is untouched.
- **Invariant**: Does **not** validate that `sourceId`/`targetId` reference existing nodes — this
  mirrors the existing manual connect-mode gesture, which is also not required to point at
  already-declared nodes (consistent with every parser's existing "implicit node from edge
  endpoint" behavior, Constitution I). The AI-tool wrapper (see
  `api-ai-chat-contract.md`) is what performs the existence check FR-014 requires, since only it
  needs to distinguish "nothing to do" from "tell the user this didn't work" (research.md §6).

## Existing operations (002, unchanged)

`removeNode`, `removeEdge`, `updateNodeLabel`, `updateEdgeLabel` keep their existing contracts
(idempotent no-op on a missing id, non-empty-label precondition on `updateNodeLabel`) — see
`specs/002-editing-lifecycle-enhancements/contracts/diagram-core-ops-contract.md`. This feature
does not change their behavior; it only adds AI-tool wrappers around all six operations
(existing four plus the two new ones above).
