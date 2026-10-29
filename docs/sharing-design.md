# Sharing: goal and model

Decided with the product owner on 2026-10-29 (bead canvas-8c41). This note is the reference for the
sharing epic. Implementation beads link back here.

## Goal

Sharing in Canvas supports two things:

- **Team co-authoring.** A team works on a project's diagrams together.
- **Review and feedback.** Other people read diagrams and comment. Formal approval happens in
  GitHub (canvas-3s5), not through Canvas sharing.

Publishing to the public and anonymous access are not goals. Canvas is sign-in only.

## Model

| Topic | Decision |
|---|---|
| Default visibility | **Open, read-only.** Every signed-in person can browse and read every project and diagram. Changing anything needs membership. |
| Unit of sharing | **Projects.** A project has members, and members see all its diagrams. Sharing a single diagram stays possible, as the exception. |
| Levels | **View, Comment, Edit, Manage.** Manage = Edit + add/remove members. The owner always has Manage, and ownership can be transferred. |
| Commenting | Comment, Edit or Manage only. Open read-only access does not include commenting. |
| Who manages members | The owner and Manage members (plus admins). Plain editors can't. |
| Recipients | **People and Microsoft Entra groups.** Group membership comes from Entra, so joiners and leavers need no Canvas change. |
| Notifications | **In-app first** (a badge and list in Canvas). Email later, once a mail provider is chosen (canvas-q9v). |
| Links | **Plain links only.** "Copy link" copies the diagram's or project's address. With open read-only access, anyone who signs in can open it. No access-granting or anonymous links. |
| Real-time co-editing | Out of scope here (canvas-vvi). Concurrent edits are guarded by canvas-obp0. |

### Effective access

A person's access to a diagram is the **highest** of:

1. view (everyone signed in, from open read-only);
2. their project membership, direct or through an Entra group;
3. a diagram-level share, direct or through a group;
4. owner of the diagram or project = Manage; admin = Manage everywhere.

Two changes from today's `resolveDiagramAccess` (`apps/api/src/sharing/sharing.service.ts`):

- It takes the highest level instead of letting a diagram grant override a project grant. Today a
  diagram-level View hides a project-level Edit.
- It adds the open-read and group sources.

**Open point (proposed):** the global Entra role should cap access. A **viewer** never gets more
than Comment, whatever they're granted. **architect** and **admin** aren't capped. Today a viewer
given Edit can edit.

### Private projects

Not in scope now (the decision was fully open). If confidential work appears later, the natural
extension is a per-project "private" flag that turns off open read for that project.

## What changes

1. **Open read-only visibility.** Access resolution and every list (projects, search) include all
   projects at View. The Projects page separates "My projects" (owned or member) from
   "All projects".
2. **Project members.** A Members dialog on the project page: add people and groups, set
   View/Comment/Edit/Manage, remove, transfer ownership. The API already stores project grants
   (`share_grants.subject_type = 'project'`); add the `manage` level.
3. **Entra groups.** Grants to a group, with the grantee stored as an Entra group object id. A
   user's groups are read at sign-in, from the ID token's `groups` claim or through Microsoft Graph
   when the claim overflows (more than 200 groups). The group picker searches groups through Graph,
   which needs an app permission such as `GroupMember.Read.All` or `Group.Read.All`. Local-account
   mode has no groups, so the picker is hidden there.
4. **In-app notifications.** A notifications table and a header badge and list: "You were added to
   Payments (Edit)". canvas-q9v covers email later.
5. **Copy link** in the editor and on the project page.
6. **Diagram-level Share** stays as the exception, still behind the admin switch from canvas-8em
   until the project Members dialog exists. The switch is then turned on, or removed.

These are backend-heavy changes: authorization, Graph integration and notifications. The backend
is moving to Python (canvas-lvlo), so decide per phase whether to build it in TypeScript now or
in the Python service.
