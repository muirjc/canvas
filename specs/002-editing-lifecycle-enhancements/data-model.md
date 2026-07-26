# Data Model: Editing & Lifecycle Enhancements

Extends 001's data model (`specs/001-diagramming-platform/data-model.md`). Only the deltas are
described here; all other entities are unchanged.

## Diagram (extended)

Adds four nullable columns to the existing `Diagram` entity:

| Field | Type | Notes |
|---|---|---|
| deletedAt | datetime? | Null while active. Set to the deletion time on soft-delete (FR-012). |
| deletedByUserId | string? | FK → User. Who deleted it (owner or admin). Null while active. |
| restoredAt | datetime? | Set when an admin restores the diagram (FR-021); null otherwise. Not cleared on a later delete — a diagram can be deleted → restored → deleted again, and only the most recent cycle's timestamps are retained (no history table). |
| restoredByUserId | string? | FK → User. Which admin restored it (FR-021). Null unless `restoredAt` is set. |

**Validation**: `deletedByUserId` is set if and only if `deletedAt` is set (both null, or both
populated together); same pairing rule for `restoredByUserId`/`restoredAt`. `restoredAt`, when
set, MUST be later than `deletedAt`.

**Admin deleted-diagrams listing**: per clarification, this listing exposes only `name`,
`ownerId`, `projectId`, and `deletedAt` for each entry — never the diagram's `dslContent`/model.
Fetching full content requires calling restore first (FR-020).

**State transitions**:

```
active ──(owner or admin deletes)──> soft-deleted
soft-deleted ──(admin restores, within 30 days of deletedAt)──> active
soft-deleted ──(30+ days since deletedAt)──> purge-eligible (behaves as permanently gone;
                                                              physical row removal is a deferred
                                                              housekeeping concern — research.md §1)
```

**Access rule while soft-deleted**: Every existing read path (`getDiagram`, `searchDiagrams`,
`getProjectTree`, export) MUST behave exactly as if the diagram did not exist (404/absent from
listings) for every caller except the admin-only restore/deleted-list path — consistent with
FR-012's "consistent with existing access-denial behavior."

## DiagramModel operations (new, in `packages/diagram-core`)

Not persisted entities — pure functions over the existing in-memory `DiagramModel` (nodes/edges/
containers), used by the canvas for shape deletion (data-model.md's existing `DiagramNode`/
`DiagramEdge`/`DiagramContainer` shapes from 001 are unchanged):

- **removeNode(model, nodeId) → DiagramModel**: removes the node; removes every edge whose
  `sourceId` or `targetId` equals `nodeId` (FR-008 — no dangling connector reference); if the
  node's `containerId` container has no remaining member nodes afterward, removes that container
  too (FR-010).
- **removeEdge(model, edgeId) → DiagramModel**: removes a single connector without touching its
  endpoint nodes.
- **updateNodeLabel(model, nodeId, label) → DiagramModel** / **updateEdgeLabel(model, edgeId,
  label) → DiagramModel**: label-only mutations (FR-004/FR-005); `label` may be an empty string
  to clear an edge's label (shapes always keep a non-empty label, consistent with 001's existing
  node-rename behavior).

## Entity Relationship Summary (delta)

```
Diagram ── (new) deletedAt/deletedByUserId ── User (deletedByUserId FK)
```

No other relationships change.
