# Contract: Diagrams API (`apps/api/src/diagrams`)

Covers User Stories 1, 4, 5.

| Method | Path | Purpose |
|---|---|---|
| POST | `/projects/:projectId/diagrams` | Create a new diagram (FR-001). Body: `{ name, diagramTypeId, templateId? }`. If `templateId` given, seeds initial `DiagramVersion` from the Template's `seedDslContent`. |
| GET | `/diagrams/:id` | Fetch a diagram: current DSL, model, `lastValidationResult`, metadata. |
| PATCH | `/diagrams/:id` | Save an edit. Body: `{ dslContent }` **or** `{ model }` (either representation accepted; server calls `diagram-core.parse`/`serialize` as needed to keep both in sync — FR-003). Creates a new `DiagramVersion`. Re-runs `validate()` against the active Standard and returns updated `lastValidationResult` (never blocks the save — FR-024). |
| GET | `/diagrams/:id/versions` | List version history (FR-017). |
| POST | `/diagrams/:id/versions/:versionId/restore` | Restore a prior version by creating a new version copying its content (FR-017; append-only per data-model.md). |
| GET | `/diagrams/:id/export?format=mermaid\|svg\|png` | Export in the requested format (FR-004). `svg`/`png` are rendered via `diagram-core.renderToSvg` (+ server rasterization for `png`, research.md §4). |
| POST | `/projects/:projectId/diagrams/import` | Import raw Mermaid DSL (FR-018). Body: `{ dslContent, diagramTypeHint? }`. Calls `diagram-core.parse`; on `ParseError[]`, returns 422 with the specific unmapped-syntax details (FR-019) rather than a generic failure. |
| GET | `/projects/:projectId/diagrams?query=&type=&folder=` | Search/browse diagrams by name, type, folder (FR-016). |

**Access control**: every route enforces the caller's effective access level (owner, or highest
applicable `ShareGrant`, or `admin` role) per FR-020/FR-021; write routes (`PATCH`, `import`,
`restore`) require at least `edit`.

**Error shape**: `{ error: string, details?: object }`; parse/validation-detail errors always
populate `details` with structured, element-level information (never a bare string) so the UI can
render FR-005/FR-013/FR-019's "specific, actionable" requirement.
