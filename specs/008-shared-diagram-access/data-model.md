# Phase 1 Data Model: Reaching a Diagram Shared With You

No table is added and no column changes shape. This document is about the one read-model this
feature introduces, and the single supporting index it needs.

---

## New: Shared Diagram Entry (read-model, not a table)

A row exists for exactly one thing: an active `share_grants` record with
`subject_type = 'diagram'` whose `grantee_user_id` is the signed-in user, joined out to the
diagram, its immediate project, and the granting user.

```sql
SELECT
  d.id                AS diagram_id,
  d.name              AS diagram_name,
  d.diagram_type_id,
  p.name              AS project_name,
  sg.access_level,
  u.name              AS shared_by_name,
  u.email             AS shared_by_email,
  sg.created_at       AS shared_at
FROM share_grants sg
JOIN diagrams d ON d.id = sg.subject_id
JOIN projects p ON p.id = d.project_id
JOIN users    u ON u.id = sg.granted_by_user_id
WHERE sg.subject_type = 'diagram'
  AND sg.grantee_user_id = $1
  AND d.deleted_at IS NULL
ORDER BY d.name, d.id
```

| Field | Source | Notes |
|---|---|---|
| `diagram_id`, `diagram_name` | `diagrams` | Opening reuses the existing `GET /diagrams/:id` path — no new access check (FR-010). |
| `diagram_type_id` | `diagrams` | For the UI to pick the right icon/label, matching other diagram listings. |
| `project_name` | `projects`, via `diagrams.project_id` (immediate container only) | Never an ancestor (research.md §3, spec Clarifications). Display text only — never a link (FR-005). |
| `access_level` | `share_grants.access_level` | The grant's own stored value — identical to what `resolveDiagramAccess` would return for a diagram-level grant (FR-004). |
| `shared_by_name`, `shared_by_email` | `users`, via `share_grants.granted_by_user_id` | Shown unchanged regardless of that user's current `active` flag (FR-007, spec Clarifications). |
| `shared_at` | `share_grants.created_at` | Not currently rendered by any FR, kept available for sort/debugging; do not invent a UI requirement around it. |

**Why the join alone satisfies FR-002, FR-006, and FR-011** — no extra filtering logic is layered
on top of it (research.md §1):

- A diagram whose grant was revoked has no `share_grants` row to join from — it simply isn't in
  the result set (FR-011).
- A diagram the user could *also* reach via project access is not excluded — this query never
  looks at project access at all, so there is nothing to exclude it (FR-006).
- A user with zero projects gets the same query as a user with a hundred — visibility here has no
  dependency on `projects`/`project.access.ts` beyond the one `JOIN` for the display name
  (FR-002).

**Uniqueness**: `share_grants` already enforces `UNIQUE (subject_type, subject_id,
grantee_user_id)` — a user cannot hold two diagram-level grants on the same diagram, so this query
can never produce two rows for one diagram.

---

## Added index

```sql
CREATE INDEX share_grants_grantee_idx ON share_grants (grantee_user_id, subject_type);
```

`share_grants_subject_idx (subject_type, subject_id)` supports "who can access this specific
diagram/project" (`resolveDiagramAccess`, `resolveDiagramAccess`'s project fallback). It does
nothing for "every diagram granted to this user", which has no `subject_id` to narrow on. Every
other "list mine" query added by a prior feature got its own index for exactly this reason
(`projects_owner_id_idx`, feature 007); this is that same precedent applied here
(research.md §4).

Migration `0007_share_grants_grantee_idx.sql` — index only, no column added, no backfill needed.

---

## Unchanged

- `share_grants`, `diagrams`, `projects`, `users` — no column, constraint, or check added.
- `resolveDiagramAccess` / `resolveProjectAccess` / `project.access.ts` — untouched (FR-010).
  This feature reads the same `share_grants` rows those functions do, but through its own query,
  not by calling them.
- `packages/diagram-core` — not engaged; this feature never opens a diagram's model or DSL.
