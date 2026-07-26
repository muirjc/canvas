# Contract: Standards & Icon/Shape Libraries API (`apps/api/src/standards`, `apps/api/src/libraries`)

Covers User Stories 2 and 3, admin-facing.

## Standards

| Method | Path | Purpose |
|---|---|---|
| GET | `/diagram-types/:id/standard` | Get the currently `published` Standard for a diagram type (or 404 if none exists — palette falls back to unrestricted defaults per FR-012's "where one exists"). |
| POST | `/diagram-types/:id/standards` | Create a new Standard version in `draft` (FR-011). Body matches the Standard fields in data-model.md. |
| POST | `/standards/:id/publish` | Transition `draft → published`; supersedes the previously published version for that diagram type (FR-014). Triggers async re-validation of existing diagrams of that type (results available via `GET /diagrams/:id`, never silently rewriting diagram content — FR-014). |
| POST | `/standards/:id/retire` | Transition `published → retired`. |
| GET | `/diagram-types/:id/standards` | List all versions (draft/published/retired) for audit history. |

**Validation**: `allowedIconLibraryRefs` entries are checked against existing `IconShapeLibrary`
(id, version) pairs at creation time (400 if unknown). Only one `published` Standard per diagram
type is enforced server-side, not just by convention.

## Icon/Shape Libraries

| Method | Path | Purpose |
|---|---|---|
| GET | `/libraries` | List all libraries and versions (admin console + palette source). |
| POST | `/libraries` | Ingest a new library or new version via manifest upload (FR-010, Constitution V) — calls `diagram-core.loadLibrary`. Requires `license`/attribution field for non-generic libraries. |
| GET | `/libraries/:id/versions/:version/icons?query=` | Search icons within a library version by keyword (backs FR-009's palette search, scoped or combined across libraries by the frontend). |
| GET | `/icons/search?query=&diagramTypeId=` | Cross-library search scoped to a diagram type's `defaultPaletteLibraryIds` (FR-007 + FR-009 combined). |

**Access control**: `POST /standards`, `/publish`, `/retire`, and `POST /libraries` require
`admin` role (FR-011, FR-022, FR-023). Read endpoints are available to any authenticated user.
