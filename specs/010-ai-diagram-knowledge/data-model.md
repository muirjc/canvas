# Phase 1 Data Model: AI Chat Diagram-Type and Persona-Scoped Knowledge Grounding

## New table: `ai_persona_reference_material`

One row per reference-material entry (spec's *Persona Reference Material Entry*). A persona has
zero or more entries.

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID PRIMARY KEY DEFAULT gen_random_uuid()` | |
| `persona_id` | `UUID NOT NULL REFERENCES ai_personas (id)` | |
| `content` | `TEXT NOT NULL` | Admin-authored reference text (FR-006). No length cap at the schema level; the edge case of "very large" material is a request-time scoping/truncation concern (research.md §4), not a storage constraint. |
| `diagram_families` | `TEXT[]` | `NULL` or `'{}'` = applies regardless of diagram type (unscoped). Otherwise, one or more of `registry.ts`'s existing family ids (`flowchart`, `c4`, `architecture`, `sequence`, `erd`, `uml`) — validated against that exact set at the service layer, the same way `persona.service.ts` validates `category` against `AI_PERSONA_CATEGORIES` today. |
| `created_at` / `updated_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | Same convention as `ai_personas`. |

Migration: `apps/api/migrations/0010_ai_persona_reference_material.sql`.

**Relationships**: many-to-one with `ai_personas` (FK, no cascade behavior change needed —
`ai_personas` rows are never hard-deleted, only archived, mirroring the existing
`archivePersona` precedent; a reference-material entry belonging to an archived persona is simply
never surfaced again since archived personas no longer appear in the chat picker).

**Validation rules** (service layer, matching `InvalidPersonaCategoryError`'s existing pattern):
- `content` MUST be non-empty.
- Every value in `diagram_families`, if present, MUST be one of the 6 registered `dslFamily` ids.

**State transitions**: none beyond create/edit/delete (FR-009) — no status/lifecycle field, unlike
`ai_personas`' `active`/`archived`; a reference-material entry is either present or removed.

## Changed: `SendChatMessageInput` (`diagram-chat.service.ts`)

Adds a required `dslFamily: string` field (research.md §1) — the caller (route handler) resolves
it from the diagram's own record via the existing `getDiagram`/`loadDiagramTypeDslFamily`
mechanism before calling `sendChatMessage`; `sendChatMessage` itself no longer calls
`getDslFamily('flowchart')` unconditionally.

## New: `DiagramTypePrimer` (in-memory only, not persisted)

```ts
interface DiagramTypePrimer {
  dslFamily: string;         // matches registry.ts's family ids
  summary: string;           // 2-4 sentence plain-language orientation (research.md §2)
}
```

One entry per family, hand-authored in `apps/api/src/ai/diagram-type-primers.ts`. Not a database
table — this is static, code-reviewed content, versioned with the rest of the codebase like any
other prompt-construction logic, not admin-editable data (distinct from `ai_persona_reference_material`,
which is admin-editable by design).

Content direction for each (finalized during implementation, not this plan):
- **flowchart**: shapes represent steps/decisions; connectors show flow direction; supports
  grouping via subgraphs.
- **c4**: elements have a role (person, software system, container, component) and an abstraction
  level; boundaries group related elements; relationships describe interactions between roles.
- **sequence**: participants exchange ordered messages over time; activation marks when a
  participant is actively processing; messages can be synchronous, asynchronous, or a reply.
- **erd**: entities have typed attributes, optionally marked as a primary, foreign, or unique key;
  relationships between entities carry cardinality.
- **uml**: classes have typed, visibility-marked attributes and methods; relationships between
  classes have a specific kind (inheritance, composition, aggregation, association, dependency,
  realization) distinct from a plain connector.
- **architecture**: services belong to groups representing logical/network boundaries; edges
  connect services (optionally at group-level) rather than describing generic flow.

## Changed: `packages/diagram-core` — new pure operations (`diagram-ops.ts`)

All follow the existing merge-patch, no-op-if-missing-id convention `updateNodeStyle`/
`updateEdgeStyle` already established.

| Operation | Signature | Notes |
|---|---|---|
| `updateNodeRole` | `(model, nodeId, role: string) => DiagramModel` | Sets `DiagramNode.role`. |
| `updateEntityAttributes` | `(model, nodeId, attributes: EntityAttribute[]) => DiagramModel` | Replaces `DiagramNode.attributes` wholesale (matches how `updateNodeLabel` replaces, not merges, a scalar field — an attribute *list* is naturally replace-whole rather than patched, since reordering/removal needs the same call shape as addition). |
| `updateClassMembers` | `(model, nodeId, members: ClassMember[]) => DiagramModel` | Replaces `DiagramNode.members` wholesale, same rationale. |
| `updateEdgeRelationKind` | `(model, edgeId, patch: { umlRelationKind?, sourceCardinality?, targetCardinality? }) => DiagramModel` | Merge-patch, mirrors `updateEdgeStyle`. |
| `updateEdgeArrowStyle` | `(model, edgeId, patch: { arrow?, lineStyle? }) => DiagramModel` | Merge-patch. |
| `addPointMarkerContainer` | `(model, input: { role: 'activate' \| 'deactivate'; attachedNodeId: string; sequenceOrder?: number }) => DiagramModel` | Mirrors the existing `activate`/`deactivate` `DiagramContainer` shape sequence parsing already produces (`jmuir-dtu.4`) — an AI-authored activation becomes indistinguishable from a DSL-parsed one. |

Each ships with contract tests in `packages/diagram-core/tests/contract/diagram-ops.test.ts`
(extends the existing file, same as 004 did for `addNode`/`addEdge`), written before the
implementation per Constitution IV.

## Changed: `apps/api/src/ai/diagram-tools.ts`

`createDiagramTools(context: DiagramToolsContext, family: string)` — new required `family`
parameter. Returns the existing 8 tools (unchanged) for every family, plus the family-conditional
set below:

| Tool | Families it is offered on |
|---|---|
| `setNodeRole` | `c4`, `sequence` |
| `setEntityAttributes` | `erd` |
| `setClassMembers` | `uml` |
| `setRelationshipKind` | `uml` |
| `setConnectorStyle` | `sequence`, `flowchart` |
| `groupIntoContainer` | `architecture`, `c4`, `uml`, `sequence` |
| `activateParticipant` / `deactivateParticipant` | `sequence` |

`addNode`'s existing `shape` parameter's enum widens from the current hardcoded
`FLOWCHART_SHAPES` to the family-appropriate `NodeShape` subset (e.g. `erd`/`uml`/`c4` diagrams
default to `'rectangle'` only where that is the only shape those families' own parsers ever
produce — confirmed per-family during implementation against each `dsl/*.ts` parser's own shape
handling, not assumed).
