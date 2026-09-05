# Contract: `diagram-core` model operations (new, extends 002's/004's `diagram-core-ops-contract.md`)

Pure functions over `DiagramModel`, no I/O — used identically by any future manual-canvas UI for
these fields and by the server-side AI tool-calling layer (data-model.md).

## `updateNodeRole(model: DiagramModel, nodeId: string, role: string): DiagramModel`

- **Invariant**: Sets the named node's `role` field to the given value, leaving every other field
  (including `shape`, `label`, `members`, `attributes`) untouched.
- **Invariant**: No-op (returns the model unchanged) if `nodeId` does not reference an existing
  node — matches `updateNodeStyle`'s existing no-op-on-missing-id convention.
- **Invariant**: Accepts any string — this function does not validate `role` against a
  family-specific enum; the AI-tool wrapper's Zod schema is what constrains valid values per
  family (research.md §3), the same separation of concerns `addNode`'s shape validation already
  uses (schema-level constraint at the tool boundary, not inside the pure operation).

## `updateEntityAttributes(model: DiagramModel, nodeId: string, attributes: EntityAttribute[]): DiagramModel`

- **Invariant**: Replaces the named node's `attributes` array wholesale with the given list.
  Passing `[]` clears all attributes (distinct from omitting the call, which leaves existing
  attributes untouched) — matches this codebase's established `null`/omit-vs-explicit-empty
  distinction (canvas-xig's `StylePatch` precedent).
- **Invariant**: No-op if `nodeId` does not reference an existing node.

## `updateClassMembers(model: DiagramModel, nodeId: string, members: ClassMember[]): DiagramModel`

- **Invariant**: Replaces the named node's `members` array wholesale, same empty-vs-omit semantics
  as `updateEntityAttributes`.
- **Invariant**: No-op if `nodeId` does not reference an existing node.

## `updateEdgeRelationKind(model: DiagramModel, edgeId: string, patch: { umlRelationKind?: DiagramEdge['umlRelationKind']; sourceCardinality?: string; targetCardinality?: string }): DiagramModel`

- **Invariant**: Merge-patch — only fields present in `patch` change; an omitted field keeps its
  existing value (mirrors `updateEdgeStyle`'s existing merge semantics exactly).
- **Invariant**: No-op if `edgeId` does not reference an existing edge.

## `updateEdgeArrowStyle(model: DiagramModel, edgeId: string, patch: { arrow?: DiagramEdge['arrow']; lineStyle?: DiagramEdge['lineStyle'] }): DiagramModel`

- **Invariant**: Merge-patch, same convention as above.
- **Invariant**: No-op if `edgeId` does not reference an existing edge.

## `addPointMarkerContainer(model: DiagramModel, input: { role: 'activate' | 'deactivate'; attachedNodeId: string; sequenceOrder?: number }): DiagramModel`

- **Invariant**: Appends exactly one new `DiagramContainer` with a freshly-generated id, the given
  `role`, and `attachedNodeIds: [input.attachedNodeId]` — matches the shape `sequence.ts`'s own
  parser already produces for `activate <id>` / `deactivate <id>` statements (`jmuir-dtu.4`), so an
  AI-authored activation round-trips through serialize/reparse identically to a hand-written one.
- **Invariant**: Does not validate that `attachedNodeId` references an existing participant node —
  matches `addEdge`'s existing "doesn't validate endpoints" precedent; the AI-tool wrapper performs
  the existence check.

## Existing operations (002/004, unchanged)

`addNode`, `removeNode`, `addEdge`, `removeEdge`, `updateNodeLabel`, `updateEdgeLabel`,
`updateNodeStyle`, `updateEdgeStyle`, `addContainer`, `assignNodeToContainer` keep their existing
contracts unchanged. This feature adds new AI-tool wrappers reusing `addContainer` +
`assignNodeToContainer` together (`groupIntoContainer`, see `api-ai-chat-contract.md`) without
changing either operation itself.
