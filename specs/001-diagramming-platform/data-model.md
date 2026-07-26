# Data Model: Governed Multi-Persona Diagramming Platform

Derived from spec.md's Key Entities, refined with fields, relationships, validation rules, and
state transitions needed to satisfy the functional requirements.

## DiagramType

Represents a supported kind of diagram (e.g., "C4 Context", "AWS Cloud Infrastructure").

| Field | Type | Notes |
|---|---|---|
| id | string (slug) | Stable identifier, e.g. `c4-context`, `business-capability-map` |
| name | string | Display name |
| personas | enum[] | One or more of: Business, Enterprise, Solution, Technical (FR-006/007) |
| abstractionLevel | string | e.g. "Context", "Container", "Component", "Code" for C4; free label otherwise |
| dslFamily | enum | Which Mermaid grammar family this type serializes to/from (e.g., `c4`, `flowchart`, `architecture`, `sequence`, `erd`, `class`) |
| defaultPaletteLibraryIds | string[] | Which Icon/Shape Libraries are offered by default for this type (FR-007) |

**Validation**: `personas` MUST be non-empty (Constitution III — every diagram type is scoped to
at least one persona). `dslFamily` MUST map to a supported parser/serializer in `diagram-core`.

## IconShapeLibrary

A named, versioned collection of shapes/icons (FR-008, FR-010, Constitution V).

| Field | Type | Notes |
|---|---|---|
| id | string (slug) | e.g. `azure-icons`, `aws-icons`, `c4-notation`, `uml`, `generic` |
| version | string | Library version/release tag |
| license | string | Attribution/license text, required for vendor libraries |
| icons | Icon[] | See below |

### Icon (child of IconShapeLibrary)

| Field | Type | Notes |
|---|---|---|
| id | string | Unique within library+version, e.g. `aws-lambda` |
| displayName | string | e.g. "AWS Lambda" |
| keywords | string[] | Used by palette search (FR-009) |
| category | string | e.g. "Compute", "Storage", "Person", "Container" |
| assetRef | string | Pointer to SVG asset in blob store |

**Validation**: `(libraryId, version, id)` is unique. Vendor libraries (`azure-icons`,
`aws-icons`) MUST carry a non-empty `license` field.

**State transitions**: A library version is immutable once ingested; updating icons means
ingesting a new `version`. Diagrams reference a specific `(libraryId, version, iconId)` so that a
library update does not silently change already-created diagrams (per Edge Case: icon library
version changes).

## Standard (Stencil)

Admin-defined, versioned rule set bound to one DiagramType (FR-011–FR-014, Constitution II).

| Field | Type | Notes |
|---|---|---|
| id | string | |
| diagramTypeId | string | FK → DiagramType |
| version | integer | Monotonically increasing per diagramTypeId |
| status | enum | `draft`, `published`, `retired` |
| allowedShapeIds | string[] | Shapes permitted for this type |
| mandatoryShapeIds | string[] | Shapes that MUST appear where semantically applicable (e.g., C4 "Person" shape) |
| allowedIconLibraryRefs | (libraryId, version)[] | Which icon library versions are approved |
| colorPalette | { role: string, colorHex: string }[] | Approved color per semantic role |
| fontConstraints | { family?: string, minSize?: number, maxSize?: number } | Optional |
| publishedAt | datetime? | Set when `status` becomes `published` |

**State transitions**: `draft → published` (admin action, FR-011); `published → published`
(new version created on edit, previous version retained for audit — FR-014's "existing diagrams
re-evaluated, not silently modified" requires the old version to still exist to explain historical
validation results); `published → retired` (admin retires a standard; diagrams keep their last
validation result but no new validation runs against a retired standard until an admin assigns a
replacement).

**Validation**: Only one `published` Standard is active per `diagramTypeId` at a time. Every
`allowedIconLibraryRefs` entry MUST reference an existing `IconShapeLibrary` version.

## Diagram

A single diagram instance (FR-001–FR-005, FR-016–FR-019).

| Field | Type | Notes |
|---|---|---|
| id | string | |
| name | string | |
| diagramTypeId | string | FK → DiagramType, fixed at creation |
| projectId | string | FK → Project/Folder |
| ownerId | string | FK → User |
| currentVersionId | string | FK → DiagramVersion (latest) |
| standardVersionAtLastCheck | integer? | Which Standard version the last validation ran against |
| lastValidationResult | Violation[] | Cached result of FR-013 validation, refreshed on save |
| createdAt / updatedAt | datetime | |

**Validation**: `diagramTypeId` is immutable after creation (a diagram doesn't change abstraction
level/persona mid-life — Constitution III). `lastValidationResult` MUST be recomputed on every
save (FR-024's soft-flag requires current, not stale, violations).

### Violation (value object, not persisted independently)

`{ elementId: string, rule: string, message: string, severity: "warning" }` — all violations are
`warning` severity per the resolved soft-flag decision (FR-024); there is no `blocking` severity
in this spec.

## DiagramVersion

Immutable snapshot of a Diagram's content at a point in time (FR-017).

| Field | Type | Notes |
|---|---|---|
| id | string | |
| diagramId | string | FK → Diagram |
| sequenceNumber | integer | Monotonically increasing per diagramId |
| dslContent | text | Canonical Mermaid DSL (+ front-matter metadata, see research.md §1) |
| authorId | string | FK → User |
| createdAt | datetime | |
| violationsAtSave | Violation[] | Snapshot of validation result at the time this version was saved |

**State transitions**: Append-only. "Restoring" a prior version (FR-017) creates a **new**
DiagramVersion whose `dslContent` copies the restored version's content — history is never
rewritten or deleted.

## Project (Folder)

Organizational container for Diagrams (FR-016), supports nesting.

| Field | Type | Notes |
|---|---|---|
| id | string | |
| name | string | |
| parentProjectId | string? | Null for root-level projects; enables folder nesting |

**Validation**: No cycles in the `parentProjectId` chain.

## User

| Field | Type | Notes |
|---|---|---|
| id | string | |
| name / email | string | |
| role | enum | `admin`, `architect`, `viewer` (FR-022) — controls platform-wide capability (defining standards, managing libraries) |
| personas | enum[] | Business/Enterprise/Solution/Technical association(s), used to tailor default diagram-type suggestions (Assumptions) |
| active | boolean | Deactivated users lose the ability to authenticate; their owned diagrams/projects are unaffected (Edge Case) and remain owned by them until reassigned by an admin |

## ShareGrant

Grants a User a specific access level to a Diagram or Project (FR-020, FR-021).

| Field | Type | Notes |
|---|---|---|
| id | string | |
| subjectType | enum | `diagram` or `project` |
| subjectId | string | FK → Diagram or Project depending on `subjectType` |
| granteeUserId | string | FK → User (org-internal only, per FR-026) |
| accessLevel | enum | `view`, `comment`, `edit` |
| grantedByUserId | string | FK → User (owner or admin who created the grant) |
| createdAt | datetime | |

**Validation**: `granteeUserId` MUST reference an active User within the (single) organization.
A grant on a `project` applies to every Diagram within it unless a more specific per-diagram grant
overrides it (most-specific-grant-wins), giving folder-level sharing without per-diagram setup.

## Template

Pre-built starting point for a new Diagram (FR-015).

| Field | Type | Notes |
|---|---|---|
| id | string | |
| diagramTypeId | string | FK → DiagramType |
| persona | enum | Which persona this template is primarily aimed at |
| name / description | string | |
| seedDslContent | text | Starting DSL content, pre-populated per the DiagramType's active Standard where one exists |

**Validation**: `seedDslContent` MUST itself pass validation against the active Standard for
`diagramTypeId` at the time the template is published (a non-compliant template would defeat the
purpose of FR-012's "defaults reflect the standard").

## Entity Relationship Summary

```
Organization (implicit, single) ── has many ── User
User ── owns ── Diagram, Project
Project ── contains (nested) ── Project
Project ── contains ── Diagram
Diagram ── belongs to ── DiagramType
Diagram ── has many (append-only) ── DiagramVersion
DiagramType ── has ── Standard (versions, one published at a time)
Standard ── references ── IconShapeLibrary (version-pinned)
DiagramType ── has many ── Template
Diagram / Project ── has many ── ShareGrant ── references ── User (grantee)
```
