# Contract: `diagram-core` Container Operations

Seven new pure functions in `packages/diagram-core/src/model/diagram-ops.ts`, alongside the
existing node and edge operations. Contract tests for these MUST be written and MUST fail before
implementation (Constitution Principle IV).

**Shared conventions**, matching the existing operations in this module:

- Pure and immutable — return a new `DiagramModel`, never mutate the input.
- Lenient about unknown ids — a no-op returning an equivalent model, never a throw. Feature 002
  depends on this for `removeNode`/`removeEdge`, and containers follow the same rule.
- Touch only what the operation names. Anything else in the model is returned unchanged.

---

## `addContainer(model, input): DiagramModel`

```
input: { label?: string; position?: Position; size?: Size }
```

| Guarantee | Detail |
|---|---|
| Generates a unique id | Consistent with `addNode`/`addEdge` id generation |
| Label defaults | `"Container"` when omitted |
| Position defaults | An unoccupied position, as `addNode` does |
| **Size is always set** | Defaults to 300×200 when omitted. **Never** produces a size-less container |
| No membership | Creating a container never assigns nodes to it |
| Everything else untouched | Nodes, edges, and other containers unchanged |

*Why the size guarantee matters*: the flowchart serializer omits containers without a size, so a
size-less container silently loses its position on the next save/parse cycle.

---

## `updateContainerLabel(model, id, label): DiagramModel`

| Guarantee | Detail |
|---|---|
| Replaces the label | Only for the named container |
| Rejects empty | Throws on an empty string, mirroring `updateNodeLabel`'s non-empty rule |
| Unknown id | No-op |
| Geometry untouched | Position, size, and membership unchanged |

---

## `moveContainer(model, id, position): DiagramModel`

| Guarantee | Detail |
|---|---|
| Sets the container's position | To the supplied absolute position |
| **Members move by the same delta** | Every node with `containerId === id` shifts by (newPos − oldPos) |
| **Child containers cascade** | Every container with `parentContainerId === id` moves by the same delta, and its own members with it |
| Relative positions preserved | A member's offset from the container is identical before and after (SC-004) |
| Size untouched | Moving never resizes |
| Membership untouched | Moving never adds or removes members |
| Unknown id | No-op |

---

## `resizeContainer(model, id, size): DiagramModel`

| Guarantee | Detail |
|---|---|
| Sets the size | To the supplied size |
| **Members are not moved or resized** | FR-010 — no node position or size changes |
| **Membership does not change** | Shrinking a container below its contents does **not** eject them |
| Position untouched | |
| Unknown id | No-op |

---

## `assignNodeToContainer(model, nodeId, containerId): DiagramModel`

| Guarantee | Detail |
|---|---|
| Sets the node's `containerId` | |
| Replaces prior membership | A node in another container moves to this one — never belongs to two |
| Node position untouched | Assignment is membership only, not a move |
| Unknown node or container | No-op |

---

## `removeNodeFromContainer(model, nodeId): DiagramModel`

| Guarantee | Detail |
|---|---|
| Clears the node's `containerId` | |
| Node position untouched | The shape stays exactly where it is |
| Container untouched | The container itself is not modified or removed |
| Node not in a container | No-op |

---

## `removeContainer(model, id): DiagramModel`

| Guarantee | Detail |
|---|---|
| Removes the container | |
| **Never removes nodes** | FR-013 / SC-004a |
| Members are released | `containerId` cleared, positions unchanged |
| **Child containers are re-parented, not deleted** | `parentContainerId` cleared; they and their members survive |
| Edges untouched | Connectors between released shapes remain |
| Unknown id | No-op |

---

## Round-trip contract

Covered by `packages/diagram-core/tests/contract/container-round-trip.test.ts`.

For any model produced by the operations above, `parse(serialize(model))` MUST preserve:

1. Every container's **id**, **label**, **position**, and **size**.
2. Every node's **membership** (`containerId`).
3. **Nested** container structure (`parentContainerId`), even though this feature provides no way
   to create nesting — imported diagrams may already contain it.
4. Containers holding **no** nodes — an empty container must survive a save/reload cycle rather
   than being dropped.

Point 4 is the one most likely to fail, and is the reason for the size invariant.

---

## Export fidelity

Exports are produced by a **separate** renderer
(`packages/diagram-core/src/render/svg-renderer.ts`), which already draws containers as a dashed
rectangle plus a label.

- Container **appearance** is NOT changed by this feature, so that renderer is not modified.
- Container **content** — presence, name, membership — must appear in exports (FR-015, SC-009),
  which the existing `subgraph` serialization already provides. This needs test coverage, not new
  rendering code.
- Screen-only affordances — selection highlight, drag cursor, resize handles — MUST NOT reach the
  export path.
