# Contract: Diagram Deletion & Restore API (extends `apps/api/src/diagrams`)

Covers User Story 4. Builds on the existing `/diagrams/:id` surface from
`specs/001-diagramming-platform/contracts/api-diagrams.md`.

| Method | Path | Purpose |
|---|---|---|
| DELETE | `/diagrams/:id` | Soft-deletes a diagram (FR-011/FR-012). Requires the caller to be the diagram's owner or an admin (not the view/comment/edit ladder — research.md §2). Sets `deletedAt`/`deletedByUserId`. Idempotent: deleting an already-deleted diagram is a no-op success, not an error. |
| GET | `/admin/deleted-diagrams` | Lists soft-deleted diagrams still within their retention window (admin-only). Per clarification (FR-020), each entry returns metadata only — `name`, `ownerId`, `projectId`, `deletedAt` — never `dslContent` or the diagram model. |
| POST | `/diagrams/:id/restore` | Restores a soft-deleted diagram (FR-014), admin-only. Sets `restoredAt`/`restoredByUserId` (FR-021) without clearing `deletedAt`/`deletedByUserId` (the prior deletion stays on record). Returns 409/expired-style error if outside the retention window (FR-015), 404 if the diagram was never deleted or doesn't exist. |

**Effect on existing endpoints**: `GET /diagrams/:id`, `GET /projects/:id/diagrams`,
`GET /projects/:id/tree`, and `GET /diagrams/:id/export` all now implicitly filter out
soft-deleted diagrams for non-admin-restore callers — a soft-deleted diagram 404s exactly like a
nonexistent one.

**Error shape**: consistent with 001 — `{ error: string }`; the expired-restore case uses a
distinct, human-readable message (e.g., "This diagram's recovery window has passed and it is no
longer available") rather than a generic 404, satisfying FR-015's "clear ... outcome."
