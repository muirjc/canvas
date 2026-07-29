# API Contract: Projects

Conventions follow the existing routes exactly — session cookie auth via `requireAuth`, responses
wrapped in a named key (`{ project }`, `{ tree }`), errors as `{ error: string }`.

---

## NEW — `GET /projects`

Lists the projects available to the signed-in user. The capability the picker needs, and the one
the brief flagged as genuinely new API surface.

**Request**: no parameters. No `?search=`, no `?page=` — the clarified scale is tens (FR-013e),
and adding either now would be speculative.

**200**

```json
{ "projects": [ { "id": "uuid", "name": "Platform Modernization", "parentProjectId": null } ] }
```

Ordered by `name` so the list is stable between loads. Returns `{ "projects": [] }` — not 404 —
when the user has access to none; that is the empty-system path (FR-014), not an error.

**401** when not signed in.

**Contract requirements**

- MUST include projects the user owns.
- MUST include projects shared with them via `share_grants`.
- MUST NOT include any other project, under any circumstance. This is FR-013a and the only
  requirement in this feature whose failure is a data leak rather than a bug.
- MUST derive membership from the same helper as the route guard below (`project.access.ts`).

---

## CHANGED — `POST /projects`

**Now sets `owner_id` from the session user** (FR-013c). `createProject({ name, parentProjectId })`
gains the acting user; it currently takes no user at all, which is why ownership could not exist.

Request body and 201 response shape are otherwise unchanged.

---

## CHANGED — guards added to every route taking a project id

Five routes gain `requireProjectAccess`. **None of them check anything today beyond `requireAuth`**
(research.md §1):

| Route | Guard added |
|---|---|
| `GET /projects/:id` | `requireProjectAccess('view')` |
| `GET /projects/:id/tree` | `requireProjectAccess('view')` |
| `POST /projects/:id/diagrams` | `requireProjectAccess('edit')` |
| `GET /projects/:id/diagrams` | `requireProjectAccess('view')` |
| `POST /projects/:id/diagrams/import` | `requireProjectAccess('edit')` |

Creating and importing require `edit` because both write into the project; reading requires
`view`. This mirrors the ladder `requireDiagramAccess` already uses.

### `requireProjectAccess(required: AccessLevel)`

Sits beside `requireDiagramAccess` in `auth/access-control.middleware.ts` and follows its shape
precisely — including the two behaviours that are easy to get wrong:

- **A nonexistent project id falls through to the route's own 404.** Do not 403 it. The existing
  middleware documents why: a 403 implies the thing exists but is out of reach, sending the user
  to solve the wrong problem.
- **401 when unauthenticated**, before any database work.

Owners and admins resolve to `edit`, matching `resolveDiagramAccess`.

**Parameter-name caveat — verified, and it bites**: `requireDiagramAccess` reads
`request.params.id`, but the five routes are split across *two* parameter names:

| Parameter | Routes |
|---|---|
| `:id` | `GET /projects/:id`, `GET /projects/:id/tree` |
| `:projectId` | `POST /projects/:projectId/diagrams`, `GET /projects/:projectId/diagrams`, `POST /projects/:projectId/diagrams/import` |

A guard copied from `requireDiagramAccess` reads `params.id`, which is `undefined` on the three
`:projectId` routes. It would then find no project, treat that as "nonexistent", fall through —
and **let the request past completely unchecked**. Those are precisely the three write/list routes
that matter most.

This failure is invisible to any test that only asserts the happy path succeeds. The guard MUST
therefore read the id explicitly per route, and there MUST be a negative test per route (see
`quickstart.md`).

---

## CHANGED — `getProjectTree` gains a predicate

Currently issues `SELECT id, name, parent_project_id FROM projects` and
`SELECT ... FROM diagrams WHERE deleted_at IS NULL` — **every project and every diagram in the
installation**, on every call, regardless of which subtree was asked for.

It MUST be scoped to the requested subtree. This is both the access fix and a performance
improvement; the existing behaviour is a full-table scan of the two largest tables to build one
project's tree.

The `ORDER BY created_at DESC, id DESC` on diagrams MUST be preserved — its secondary tiebreak is
load-bearing, and the existing comment records that removing it produces flaky ordering when rows
share a timestamp.

---

## Unchanged

`share_grants` and every `/share` route. Project sharing already works; this feature consumes it.
