# Phase 1 Data Model: Canvas Authoring & Admin Console

Two entities change. `DiagramContainer` already exists in the diagram model and gains no fields —
it gains *operations*. `Standard` gains three stored columns.

---

## 1. DiagramContainer — existing entity, no field changes

Defined in `packages/diagram-core/src/model/diagram-model.ts`. This feature makes the existing
shape manipulable; it does not extend it.

| Field | Type | Role in this feature |
|---|---|---|
| `id` | ElementId | Stable identity; survives save/reload via the DSL |
| `label` | string | The container's name (FR-008). Currently hardcoded `"Group"` at creation |
| `position` | Position | Absolute top-left. Moving the container rewrites this **and** every member's position |
| `size` | Size (optional in the type) | **Must always be set in practice** — see the invariant below |
| `style` | NodeStyle | Untouched by this feature |
| `parentContainerId` | ElementId | Nesting. Not creatable here, but preserved and cascaded |
| `role`, `attachedNodeIds`, `sequenceOrder` | — | Sequence-diagram concerns; untouched |

Membership lives on the node, not the container: `DiagramNode.containerId`.

### Invariants

1. **A container always has a `size`.** The type marks it optional, but the flowchart serializer
   writes geometry with `.filter((c) => c.size)` — a size-less container is omitted from
   front-matter entirely and its position is lost on the next parse. Every operation that creates
   or modifies a container must leave a size present. *This is the single most likely way to
   introduce silent data loss in this feature.*
2. **A node belongs to at most one container** (FR-012). `containerId` is a single value, so this
   holds structurally; operations must not introduce a second membership concept.
3. **Deleting a container never deletes nodes** (FR-013). Removal clears `containerId` and leaves
   positions untouched.
4. **Membership is explicit, not geometric.** Geometry decides membership only at the moment of a
   drop; afterwards `containerId` is authoritative, so resizing a container never changes who is
   inside it.

### Operations (new, pure — `packages/diagram-core/src/model/diagram-ops.ts`)

| Operation | Effect | Notes |
|---|---|---|
| `addContainer(model, input)` | Appends a container with a generated id, a label, a position, and **always** a size | Default label and size supplied when omitted (invariant 1) |
| `updateContainerLabel(model, id, label)` | Replaces the label | Rejects empty, mirroring `updateNodeLabel` |
| `moveContainer(model, id, position)` | Sets the position **and** applies the same delta to every member node and every child container | Preserves relative positions (FR-009, SC-004) |
| `resizeContainer(model, id, size)` | Sets the size only | Must not move or resize members (FR-010), and must not change membership (invariant 4) |
| `assignNodeToContainer(model, nodeId, containerId)` | Sets the node's `containerId` | Replaces any existing membership (invariant 2) |
| `removeNodeFromContainer(model, nodeId)` | Clears the node's `containerId` | Position untouched |
| `removeContainer(model, id)` | Removes the container, clears `containerId` on members, re-parents child containers to none | Never removes nodes (invariant 3, SC-004a) |

All follow the existing conventions in that module: pure, immutable, returning a new model, and
lenient about ids that do not exist (consistent with `removeNode`/`removeEdge`, which feature 002
relies on being no-ops).

### State transitions — node membership

```
        ┌──────────────────┐   drop inside a container's bounds   ┌─────────────────┐
        │  unassigned      │ ───────────────────────────────────► │  member of C    │
        │ (containerId ∅)  │ ◄─────────────────────────────────── │ (containerId=C) │
        └──────────────────┘   drop outside, or C is deleted      └─────────────────┘
                                                                          │
                                              drop inside container D     │
                                              (membership replaced) ──────┘
```

Resizing a container is deliberately absent from this diagram: it never causes a transition.

---

## 2. Standard — three new stored fields

Table `standards` in `apps/api`. Additive migration; no column is removed or retyped.

| Field | Type | New? | Notes |
|---|---|---|---|
| `id` | uuid | — | |
| `diagram_type_id` | text | — | |
| `version` | integer | — | |
| `status` | text | — | `draft` \| `published` \| `retired` |
| **`name`** | text | **new** | Human-readable identity (FR-021). Backfilled for existing rows |
| **`description`** | text | **new** | Statement of intent (FR-022). Nullable |
| **`retired_at`** | timestamptz | **new** | Set when the standard leaves force (FR-024). Null until then |
| `created_at` | timestamptz | — | Already present; surfaced by FR-023 |
| `published_at` | timestamptz | — | Already present |
| rule columns | — | — | Untouched |

### Validation rules

- `name` is required for standards created after this feature; existing rows are backfilled with a
  derived value (see below), so no row is ever nameless (FR-026, SC-006).
- `description` is optional — a standard may legitimately have no elaboration beyond its name.
- `retired_at` is set **if and only if** `status = 'retired'`, and is shown only then (FR-025).

### Lifecycle — and the trap

```
  draft ──publish──► published ──retire──► retired          (retired_at set)
                          │
                          └──superseded by a newer publish──► retired   (retired_at ALSO set)
```

`status = 'retired'` is written in **two** places in `standard.service.ts`:

1. `retireStandard(id)` — the explicit admin action.
2. `publishStandard(id)` — which auto-retires the previously published standard for that diagram
   type, inside the same transaction.

**Both must set `retired_at`.** Handling only the explicit action would leave every
supersession-retired standard with a null date — and supersession is the more common path.

### Backfill

Existing rows (33 in the current development database, 31 of them already retired) have no name.
Backfill from data already present — diagram type and version, e.g. `flowchart v3` — rather than
inventing intent. `description` stays null; `retired_at` stays null for already-retired rows,
since the retirement date was never recorded and cannot be recovered.

---

## 3. Version listing — query shape, not a schema change

`diagram_versions` is unchanged. Only the read path changes.

| Aspect | Today | After |
|---|---|---|
| Ordering | `sequence_number DESC` | unchanged |
| Bound | none — every version returned | default **5** (FR-028) |
| Filter | none | optional term matching version number or creation date (FR-030) |

No version is ever deleted: the cap is a display and transfer default, not a retention policy.
Anything outside the default window remains reachable by search and restorable (FR-031).

---

## 4. Not persisted

| Candidate | Why not |
|---|---|
| Container selection / resize-handle state | Ephemeral canvas interaction state, like node selection today |
| Which admin screen is active | Derived from the existing `?admin=` query parameter |
| Version search term | Transient input, not a user preference |
| A separate "group" concept | Clarified: "container" is the single concept and the single term; grouping shapes is one way to create one |
