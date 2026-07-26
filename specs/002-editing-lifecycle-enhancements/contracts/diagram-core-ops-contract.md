# Contract: `diagram-core` model operations (new, extends 001's `diagram-core-contract.md`)

Used identically by the canvas (live editing) — pure functions over `DiagramModel`, no I/O.

## `removeNode(model: DiagramModel, nodeId: string): DiagramModel`

- **Invariant**: The returned model contains no node with `id === nodeId`, and no edge whose
  `sourceId` or `targetId` equals `nodeId` (FR-008). If `nodeId`'s `containerId` container has
  zero remaining member nodes afterward, that container is also removed from the result (FR-010).
- **Invariant**: Removing a node that doesn't exist in the model is a no-op (returns an
  equivalent model), not an error — deletion is idempotent from the caller's perspective.

## `removeEdge(model: DiagramModel, edgeId: string): DiagramModel`

- **Invariant**: Removes only the named edge; all nodes and containers are untouched.

## `updateNodeLabel(model: DiagramModel, nodeId: string, label: string): DiagramModel`
## `updateEdgeLabel(model: DiagramModel, edgeId: string, label: string): DiagramModel`

- **Invariant**: Changes only the `label` field of the named node/edge; every other field
  (position, style, shape, endpoints, etc.) is unchanged.
- **Invariant**: `updateEdgeLabel` accepts an empty string to clear a label (FR-005's "clear");
  `updateNodeLabel` with an empty string is rejected (shapes keep a non-empty label, consistent
  with 001's existing rename behavior) — the caller (canvas UI) is responsible for not calling it
  with an empty value, but the function itself documents this as a precondition rather than
  silently substituting a placeholder.

## Flowchart parser extensions (`packages/diagram-core/src/dsl/flowchart-parser.ts`)

- **`graph` header alias**: `parseFlowchart` accepts `graph <TD|LR|TB|RL|BT>` identically to
  `flowchart <...>` (FR-016). `serializeFlowchart` is unchanged — it always emits `flowchart`
  (research.md §5), so `parse(serialize(model))` round-trips to the canonical form even when the
  original import used `graph`.
- **`style` directive**: `parseFlowchart` accepts `style <nodeId> <prop>:<value>[,...]` lines
  anywhere in the body (not just after the referenced node's declaration) and applies `fill` →
  `NodeStyle.fillColor`, `stroke` → `NodeStyle.strokeColor` to that node (FR-017). A `style` line
  referencing a node id not otherwise present in the diagram creates no node (silently has no
  effect) — this is a deliberate divergence from FR-005's "never silently drop": a style rule for
  a nonexistent node has no content to drop, it simply doesn't apply.
- **Comments**: lines whose trimmed content starts with `%%` are skipped entirely, before any
  other pattern matching (FR-018) — never reach the "unrecognized line" error path.
