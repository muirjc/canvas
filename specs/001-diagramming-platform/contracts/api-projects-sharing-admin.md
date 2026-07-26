# Contract: Projects, Sharing, and Admin API

Covers User Stories 4 and 6.

## Projects/Folders (`apps/api/src/projects`)

| Method | Path | Purpose |
|---|---|---|
| POST | `/projects` | Create a project/folder. Body: `{ name, parentProjectId? }` (FR-016). Rejected with 400 if it would create a cycle. |
| GET | `/projects/:id` | Get a project's metadata, subfolders, and diagrams. |
| GET | `/projects/:id/tree` | Full nested tree for the project browser UI. |

## Sharing (`apps/api/src/sharing`)

| Method | Path | Purpose |
|---|---|---|
| POST | `/diagrams/:id/shares` \| `/projects/:id/shares` | Create a `ShareGrant`. Body: `{ granteeUserId, accessLevel }` (FR-020). `granteeUserId` MUST be an active org-internal user (FR-026) — 400 otherwise. |
| GET | `/diagrams/:id/shares` \| `/projects/:id/shares` | List grants on a subject (owner/admin only). |
| DELETE | `/shares/:id` | Revoke a grant. |

**Resolution rule**: Effective access level for a Diagram = most specific applicable grant
(diagram-level grant overrides an inherited project-level grant for the same user), else owner,
else none → 403 with a message explaining why the action was blocked (FR-021).

## Admin (`apps/api/src/admin`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/admin/users` | List users and roles. |
| PATCH | `/admin/users/:id` | Update `role`, `personas`, or `active` (FR-022). |
| GET | `/admin/overview` | Single admin-console landing view aggregating standards, libraries, and users (FR-023 — "single place to manage"). |

**Access control**: All `/admin/*` routes require `admin` role.
