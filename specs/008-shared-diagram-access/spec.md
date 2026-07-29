# Feature Specification: Reaching a Diagram Shared With You

**Feature Branch**: `008-shared-diagram-access`
**Created**: 2026-07-29
**Status**: Draft
**Input**: User description: "docs/shared-diagram-access-brief.md" — A user who has been granted
access to a diagram, but not to the project containing it, currently has no way to reach that
diagram and is actively told they have no work ("You do not have any projects yet"). The access
control is already correct (a diagram-level grant already resolves to the right view/comment/edit
level); the gap is entirely one of discovery. Introduced as a deliberate side effect of feature
007 closing a prior hole where any signed-in user could browse any project's entire diagram tree
by id — which is how a diagram-grantee used to stumble onto their diagram, among everyone else's.

## Clarifications

### Session 2026-07-29

- Q: May a shared-diagram row name the project containing the diagram? → A: **Yes — show the
  project's name as read-only text, never as a link.** Feature 007's FR-013a ("projects belonging
  to others MUST NOT be listed or named") is explicitly narrowed to allow this one disclosure: the
  project's name may appear beside a diagram directly shared with the user, but nothing about the
  project's contents, other diagrams in it, or access to it is exposed. FR-013a has been updated
  with this carve-out.
- Q: Should diagrams already reachable through the user's project access also appear in this list,
  or only the otherwise-unreachable ones? → A: **All diagrams with a direct grant, regardless of
  project access.** "Shared with me" means one consistent thing: every diagram anyone has directly
  granted the user, full stop. A diagram may therefore appear both here and in the project browser
  — that duplication is accepted in exchange for the list never being a surprising, partial view
  of what has been shared.
- Q: Projects can nest (a project may have a parent project). When the diagram's immediate
  project itself sits inside a parent the user cannot reach, does "the project's name" on a
  shared-diagram row extend to that ancestor, or stop at the immediate container? → A: **Stops at
  the immediate containing project. Never an ancestor, even as a breadcrumb.** Showing an
  ancestor's name would re-expose a project the user may have zero access to — exactly the leak
  feature 007 closed, just one level removed.
- Q: FR-002 requires the shared list be visible independent of project access, but what about a
  user who has project access and simply has zero diagrams shared with them directly — the common
  case? → A: **The section is omitted entirely when there is nothing to show.** It only appears
  once at least one diagram has been shared directly with the user; no permanent empty state
  competes with the project browser for a user with nothing shared.
- Q: If the user who granted access has since had their account deactivated, does the row still
  show their identity, or a generic placeholder? → A: **Show their identity unchanged.** A grant
  made while active remains a true historical fact; the product has no existing convention of
  hiding a deactivated user's name elsewhere (e.g., version history), so this introduces none.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Find and open a diagram shared with you (Priority: P1)

A user has been granted access to a single diagram by a colleague, but holds no access to the
project that contains it. Today, signing in shows them the first-run invitation to create a
project — as if they had no work at all — even though one query away, the diagram is already
fully readable. This story makes that diagram visible and openable from the home screen, with
no project access required and no out-of-band link needed from anyone.

**Why this priority**: This is the reported defect. Nothing else in this feature matters if a
diagram-grantee still cannot find their diagram.

**Independent Test**: Sign in as a user who holds a diagram-level grant on exactly one diagram and
no project access at all. Without receiving a link or any instruction from anyone else, locate and
open that diagram from the home screen.

**Acceptance Scenarios**:

1. **Given** a user with a diagram-level grant and no project access, **When** they sign in,
   **Then** the diagram they were granted appears in a list on the home screen, and the "you have
   no projects" invitation is not shown.
2. **Given** that list, **When** the user selects the diagram, **Then** it opens at exactly the
   access level their grant carries (view, comment, or edit).
3. **Given** a user with no project access and no diagrams shared with them either, **When** they
   sign in, **Then** they see the existing first-run invitation — the truth for them has not
   changed.

---

### User Story 2 - The home screen never claims you have no work when you do (Priority: P1)

A user with only diagram-level grants and zero projects currently sees "You do not have any
projects yet. Create one to start drawing diagrams." — which is false; they have diagrams waiting.
This story corrects that message so it is only ever shown to a user for whom it is true.

**Why this priority**: Equal to User Story 1 — the misinformation is as much the reported defect as
the missing navigation is. A fix that adds the list but leaves the false invitation showing above
it still misleads the user about their own situation.

**Independent Test**: Sign in as a user with a diagram-level grant and no project access. Confirm
the first-run "create a project" invitation is absent and the shared-diagrams list is present in
its place.

**Acceptance Scenarios**:

1. **Given** a user with no project access but at least one diagram shared with them, **When**
   they land on the home screen, **Then** the first-run project invitation is not shown.
2. **Given** a user with no project access and no diagrams shared with them, **When** they land on
   the home screen, **Then** the first-run project invitation is shown, unchanged from today.

---

### User Story 3 - Know who shared it with you (Priority: P3)

Each diagram in the shared list identifies who granted the user access, so the user has enough
context to judge what the diagram is and whether to trust it, without that information revealing
anything the user could not already infer from having the grant at all.

**Why this priority**: Useful context, not load-bearing for the defect itself — the diagram is
already fully discoverable and openable without it.

**Independent Test**: Sign in as a user with a diagram-level grant from a specific colleague.
Confirm that colleague's identity is shown alongside the diagram in the shared list.

**Acceptance Scenarios**:

1. **Given** a diagram shared directly with the signed-in user, **When** they view the shared
   list, **Then** the row identifies who granted them access.

---

### Edge Cases

- A user's diagram-level grant is revoked while they are signed in: the diagram MUST NOT remain
  openable from the shared list on next load (the list reflects current grants, not a cached
  snapshot).
- The diagram behind a grant has been soft-deleted: it MUST NOT appear in the shared list, matching
  how soft-deleted diagrams are already excluded elsewhere.
- A user has multiple diagrams shared with them, from multiple different sharers and at different
  access levels (view/comment/edit): each appears as its own row with its own sharer and level.
- A user holds project-level access to the entire project a diagram lives in, and that diagram
  also has a direct grant to them: the diagram appears in both the project browser and the shared
  list (per FR-006's resolution) — this is expected duplication, not a defect.
- A diagram's containing project has been renamed or deleted after the grant was made: the shared
  list MUST reflect the project's current name, or handle a deleted project without failing the
  whole list (e.g., omitting the project name for that row rather than erroring).
- A user has project access (owns or holds a project grant) but has zero diagrams shared with them
  directly: the shared-diagrams section MUST NOT appear at all — not even as an empty state.
- The person who granted a share has since been deactivated: their identity is still shown on the
  row exactly as it would be if they were still active.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST show a signed-in user every diagram for which they hold a direct
  diagram-level share grant, in a list reachable from the home screen — independent of whether
  they hold access to that diagram's containing project.
- **FR-002**: The shared-diagrams list MUST be visible regardless of whether the user has any
  project of their own, including a user with zero projects. The section MUST be omitted entirely
  — not shown empty — for a user who has zero diagrams shared with them directly; it appears only
  once at least one exists.
- **FR-003**: The first-run "you have no projects yet" invitation MUST NOT be shown to a user who
  has at least one diagram shared with them directly; it remains shown, unchanged, to a user with
  neither project access nor any shared diagram.
- **FR-004**: Users MUST be able to open a diagram directly from the shared list, arriving at
  exactly the access level (view, comment, or edit) already resolved for that grant — no new
  access path and no change to how that level is decided.
- **FR-005**: A shared-diagram row MUST show the name of the diagram's *immediate* containing
  project as read-only text — never as a navigable link, never accompanied by any other
  information about that project (its other diagrams, its members, or a way to browse it), and
  never extended to name any ancestor of that project even when the project itself is nested
  under a parent the user cannot reach. This narrows feature 007's FR-013a specifically for this
  row (see amended FR-013a in `specs/007-project-context/spec.md`).
- **FR-006**: The shared list MUST include every diagram for which the user holds a direct
  diagram-level grant, regardless of whether that diagram is also reachable through project access
  the user holds. A diagram MAY therefore appear both in the shared list and in the project
  browser.
- **FR-007**: Each row in the shared list MUST identify who granted the user access to that
  diagram, unchanged by whether that person's account is still active — a grant made while active
  remains attributed to them.
- **FR-008**: The shared list and every control in it MUST be operable by keyboard alone and MUST
  NOT introduce any accessibility (axe) violation, consistent with the product's existing WCAG 2.1
  AA bar.
- **FR-009**: Any new interactive element introduced for this feature MUST carry a `data-testid`
  identifier; no existing `data-testid` may be removed or renamed.
- **FR-010**: No change may be made to how a user's access level to a diagram is resolved (the
  existing owner/admin/diagram-grant/project-grant precedence) — this feature only adds a way to
  discover diagrams that access resolution already permits.
- **FR-011**: The shared list MUST reflect currently active grants; a diagram whose grant has been
  revoked, or that has been soft-deleted, MUST NOT be openable from it.

### Key Entities

- **Shared Diagram Entry**: A read-model row representing one diagram directly shared with the
  signed-in user — the diagram's name and identifier, the name of its containing project (display
  only, not a link), the resolved access level (view/comment/edit), and who granted it. Derived
  from an existing diagram-level `ShareGrant` plus its diagram and that diagram's project.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user holding only a diagram-level grant, with no project access, locates and opens
  that diagram from the home screen in one navigation step, without receiving any link or
  instruction from another person.
- **SC-002**: No user who has at least one diagram shared with them is ever shown a message
  telling them they have no work — 100% of such users see the shared list instead of the first-run
  invitation.
- **SC-003**: The new list and its controls produce zero accessibility (axe) violations and are
  fully operable without a pointing device.
- **SC-004**: Every pre-existing automated check continues to pass unmodified — no existing test
  assertion is weakened or removed to accommodate this feature — and the previously untested
  scenario (a user with a diagram grant and no project grant) gains its own coverage.

## Assumptions

- The shared list lives on the home/root screen and is shown independent of project context —
  never nested under, or gated behind, a specific project being in view — since a user with zero
  project access still needs to see it.
- "Diagram-level grant" means a `share_grants` row with `subject_type = 'diagram'` whose grantee is
  the signed-in user; project-level grants themselves are not entries in this list, though a
  diagram covered by both a project-level and a diagram-level grant still appears (FR-006).
- The sharer identity shown is the granting user's name (resolved via a join at query time), not
  the raw grantee-id text `ShareDialog.tsx` currently renders — planning (research.md §2) found
  that existing display to be a UUID, not a name, which would satisfy FR-007's letter while
  failing its purpose.
- Sorting and paging of the shared list are not specified beyond a simple list, mirroring feature
  007's existing precedent of not designing for scale that does not yet exist (tens of items, not
  thousands).
- Per-diagram deep links (`?diagramId=`) are a distinct, out-of-scope capability (brief option B);
  this feature does not add or depend on one.
- Granting access continues to work exactly as it does today; no change to the sharing UI is in
  scope.
