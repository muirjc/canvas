# API Contract: Shared Diagrams

Conventions follow the existing routes exactly — session cookie auth via `requireAuth`, responses
wrapped in a named key (`{ diagrams }`), errors as `{ error: string }`.

---

## NEW — `GET /shared-diagrams`

Lists the diagrams shared directly with the signed-in user. Self-scoped, exactly like
`GET /projects` (feature 007) — no parameter names a user or diagram, the session does.

**Request**: no parameters. No `?search=`, no `?page=`, matching the spec's Assumption that this
mirrors feature 007's precedent of not designing for scale that does not exist yet.

**200**

```json
{
  "diagrams": [
    {
      "diagramId": "uuid",
      "diagramName": "Payment Flow",
      "diagramTypeId": "flowchart",
      "projectName": "Confidential Merger",
      "accessLevel": "view",
      "sharedByName": "Jordan Rivera",
      "sharedByEmail": "jordan@example.com",
      "sharedAt": "2026-07-29T00:00:00.000Z"
    }
  ]
}
```

Ordered by `diagramName` so the list is stable between loads, matching `GET /projects`. Returns
`{ "diagrams": [] }` — not 404 — for a user with nothing shared; that is the common case, not an
error (FR-002's clarified behavior: the frontend, not this endpoint, decides to omit the section
entirely when the array is empty — see `ui-contract.md`).

**401** when not signed in.

**Contract requirements**

- MUST include every diagram for which the caller holds a direct `share_grants` row with
  `subject_type = 'diagram'` (FR-001).
- MUST include such a diagram even when the caller also has project-level access to it (FR-006) —
  this endpoint MUST NOT call into `project.access.ts` or otherwise check project access.
- MUST NOT include a diagram whose grant has been revoked, or that is soft-deleted (FR-011).
- MUST NOT include or derive anything about the project beyond its immediate name — no parent
  project, no sibling/child diagram data, no project id exposed for navigation purposes beyond
  what the client already needs to render the name (FR-005).
- `accessLevel` MUST be the grant's own stored value, unchanged — the same value
  `resolveDiagramAccess` would return for a diagram-level grant, not independently recomputed
  (FR-004).
- `sharedByName`/`sharedByEmail` MUST be populated regardless of whether that user's account is
  currently `active` (FR-007, spec Clarifications) — do not filter the join on `active = true`.

---

## Unchanged — opening a shared diagram

`GET /diagrams/:id` (existing, `requireDiagramAccess('view')`) is reused as-is. The shared list's
"open" action calls this exact endpoint with no new parameter and no new guard — FR-004 requires
arriving at exactly the access level already resolved, and this route already does that. No
contract change here; stated for completeness because it is the second half of User Story 1.

---

## Unchanged

`share_grants` and every `/*/shares` route (`sharing.routes.ts`) — granting and revoking continue
to work exactly as today; this feature only adds a way to read a user's own diagram-level grants
back out as a list.
