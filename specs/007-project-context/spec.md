# Feature Specification: Project Context

**Feature Branch**: `007-project-context`
**Created**: 2026-07-29
**Status**: Draft
**Input**: User description: "Give the application a real project context so a user is never required to type a query parameter into the address bar. Today the project a diagram belongs to is held only in the URL: the application reads it but never writes it, so landing on the app root and clicking New Diagram fails, and navigating to an admin screen and back silently discards it. Add in-application project selection that survives navigation, a sensible first-run experience when no project exists yet, and shareable links that still work and still reflect the project currently in view. Also stop discarding the diagram type the user already chose when creation cannot proceed."

## Clarifications

### Session 2026-07-29

- Q: When the user chooses a project, what should the chooser list — given projects currently have
  no owner and are reachable only by knowing their identifier? → A: **Add project ownership now.**
  A project gains an owner, and a user sees the projects they own plus those explicitly shared
  with them. This closes the constitution's per-tenant visibility requirement for projects rather
  than deferring it, and it is smaller than it first appears: project-level sharing is already
  modelled *and implemented*; only ownership is missing.
- Q: What happens when the user switches project while a diagram is open with unsaved changes? →
  A: **Warn and let them confirm or cancel**, matching the confirmation pattern already used for
  destructive actions. Nothing is discarded silently.
- Q: How many projects must the chooser handle gracefully? → A: **Tens.** A simple list, with no
  search or paging. Designing for more is speculative until an installation holds more than one.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Create a diagram without knowing about the address bar (Priority: P1)

An architect opens the application, signs in, and creates a diagram. Today this fails outright:
unless the address bar happens to carry a project identifier the interface never puts there, the
attempt ends in *"Missing ?projectId= in the URL — create a project first"*. Worse, the failure
arrives only **after** they have chosen a diagram type, and that choice is thrown away.

**Why this priority**: This is the reported defect, and it blocks the product's single most basic
action for anyone who does not already know an undocumented URL trick. Nothing else in this
feature matters if this remains broken.

**Independent Test**: Open the application at its root address with nothing after the domain,
sign in, and create a diagram. It succeeds, with no manual editing of the address bar at any
point.

**Acceptance Scenarios**:

1. **Given** a user who opens the application at its root address and signs in, **When** they
   create a diagram, **Then** the diagram is created and opens in the editor.
2. **Given** that same user, **When** they import a diagram, **Then** the import proceeds without
   an error about a missing project.
3. **Given** that same user, **When** they create a diagram with AI assistance, **Then** it
   proceeds without an error about a missing project.
4. **Given** a user who has chosen a diagram type, **When** creation cannot proceed for any
   reason, **Then** their chosen type is still selected and they are not made to choose again.
5. **Given** any primary action on the main screen, **When** the user reaches it, **Then** they
   have not had to type or edit anything in the address bar.

---

### User Story 2 - Keep working in the same project while moving around (Priority: P2)

An architect working in a project visits an admin screen, then returns to their diagrams and
carries on in the same project. Today the project is silently lost the moment they navigate — and
lost on the *first* hop, so returning drops them somewhere with no project at all and the next
thing they try fails.

**Why this priority**: Without this, User Story 1 is only true until the user clicks something.
It is the difference between the fix holding and the bug reappearing a moment later.

**Independent Test**: Open a project, visit each admin screen in turn, return to the diagrams,
and create a diagram. The project is the same one throughout and creation succeeds.

**Acceptance Scenarios**:

1. **Given** a user working in a project, **When** they navigate to an admin screen and back,
   **Then** they are returned to the same project.
2. **Given** a user working in a project, **When** they move between admin screens before
   returning, **Then** the project is still the same one.
3. **Given** a user who has returned from an admin screen, **When** they create a diagram,
   **Then** it is created in the project they were working in, without error.
4. **Given** a user working in a project, **When** they open a diagram and then leave the editor,
   **Then** they are still in the same project.

---

### User Story 3 - Work with more than one project, seeing only your own (Priority: P3)

An architect can see which project they are working in, switch between the projects available to
them, and send a colleague a link that opens the same project the sender was looking at. The
projects offered are the ones they own or that have been shared with them — never everyone's.

**Why this priority**: The system currently holds one project, so switching is not yet blocking.
It becomes essential the moment a second project exists, and it is the capability the address
parameter was always standing in for. It also carries this feature's only access-visibility
decision, which is why it is specified rather than left implicit.

**Independent Test**: With more than one project present and two users, confirm each sees only
the projects they own or have been given, that switching changes which diagrams are listed and
where new ones are created, and that a link copied while viewing a project opens that same project
for a colleague who has access.

**Acceptance Scenarios**:

1. **Given** a user working in the application, **When** they look at the screen, **Then** they
   can tell which project they are working in.
2. **Given** more than one project is available to them, **When** the user switches project,
   **Then** the diagrams shown, and any diagram they then create, belong to the newly chosen
   project.
3. **Given** a project the user neither owns nor has been given access to, **When** they look at
   the projects available to them, **Then** that project is not among them.
4. **Given** a project shared with the user, **When** they look at the projects available to them,
   **Then** it is among them.
5. **Given** a user viewing a project, **When** they copy the address and give it to a colleague
   with access, **Then** the colleague opens the same project.
6. **Given** a user who has switched project several times, **When** they use the browser's back
   control, **Then** its behaviour is predictable and does not require one press per switch to
   escape.
7. **Given** an address naming a project that does not exist, or that the user has no access to,
   **When** it is opened, **Then** the user is told plainly and is left somewhere usable rather
   than stuck.
8. **Given** a user with a diagram open and unsaved changes, **When** they switch project,
   **Then** they are warned and can confirm or cancel, and cancelling leaves their work intact.

---

### User Story 4 - Start from an empty system (Priority: P4)

The first person to use a freshly installed system, where no project exists at all, is guided to
create one rather than shown an error about something they have never heard of.

**Why this priority**: It affects every new installation, but only once, and only until a first
project exists. Every seeded or established environment already has one.

**Independent Test**: With no projects present, open the application, sign in, and reach the point
of having a diagram — without encountering an error message as the first response.

**Acceptance Scenarios**:

1. **Given** a system with no projects, **When** a user signs in, **Then** they are invited to
   create a project rather than shown an error.
2. **Given** that invitation, **When** the user creates a project, **Then** they are placed in it
   and can immediately create a diagram.
3. **Given** a system with no projects, **When** a user signs in, **Then** no project is created
   on their behalf without their knowledge.

---

### Edge Cases

- **An address naming a project that has been deleted, or that the user has no access to** must
  say so and leave the user somewhere they can continue, not on a dead screen.
- **An address containing a malformed project identifier** must be treated as no project rather
  than causing a failure.
- **Switching project while a diagram is open with unsaved changes** warns the user and lets them
  confirm or cancel; work is never discarded silently.
- **Exactly one project exists** — the common case today — must not force the user through a
  chooser for a decision with only one answer.
- **Tens of projects** must remain usable in the chooser without search or paging. Beyond that
  scale is out of scope.
- **A user with access to no projects at all** — possible now that visibility is
  access-controlled — must be treated like the empty-system case rather than shown an error.
- **Projects that existed before this feature** must end up with an owner, so that none becomes
  invisible to everyone once visibility follows ownership.
- **Two browser tabs open on different projects** must each keep their own context rather than
  one overwriting the other.
- **A project deleted while the user is working in it** must be handled without stranding them.
- **Browser back and forward** after switching project must behave predictably.

## Requirements *(mandatory)*

### Functional Requirements

**Reaching the primary actions (US1)**

- **FR-001**: A signed-in user MUST be able to create a diagram without supplying, typing, or
  editing any part of the address bar.
- **FR-002**: Importing a diagram and creating a diagram with AI assistance MUST be reachable on
  the same terms as creating one.
- **FR-003**: When an action cannot proceed, choices the user has already made in that flow —
  including a chosen diagram type — MUST be preserved rather than discarded.
- **FR-004**: The system MUST NOT present an error that instructs the user to modify the address
  bar.

**Continuity of context (US2)**

- **FR-005**: The project a user is working in MUST survive navigation to any other screen and
  back, including every admin screen.
- **FR-006**: Returning from an admin screen MUST place the user back in the project they were
  working in.
- **FR-007**: Actions taken after navigating MUST apply to the project the user is in, not to a
  different or absent one.

**Choosing and sharing (US3)**

- **FR-008**: The user MUST be able to tell, from the screen, which project they are working in.
- **FR-009**: The user MUST be able to change which project they are working in.
- **FR-010**: Diagrams listed, and diagrams created, MUST belong to the project currently in
  effect.
- **FR-011**: An address copied while viewing a project MUST open that same project for another
  user who has access to it.
- **FR-012**: Changing project MUST NOT make the browser's back control impractical to use.
- **FR-013**: An address naming a project that is missing, or that the user has no access to,
  MUST produce a clear explanation and leave the user able to continue.
- **FR-013a**: The projects offered to a user MUST be limited to those they own or that have been
  explicitly shared with them; projects belonging to others MUST NOT be listed or named.
- **FR-013b**: Every project MUST have an owner, including projects that existed before this
  feature.
- **FR-013c**: A user creating a project MUST become its owner.
- **FR-013d**: Switching project while a diagram has unsaved changes MUST warn the user and let
  them confirm or cancel; cancelling MUST leave the unsaved work intact, and the system MUST NOT
  discard it silently.
- **FR-013e**: The means of choosing a project MUST remain usable with tens of projects; search
  and paging are out of scope.

**Starting from empty (US4)**

- **FR-014**: When no project exists, the user MUST be invited to create one rather than shown an
  error.
- **FR-015**: The system MUST NOT create a project on the user's behalf without their knowledge.

**Preservation**

- **FR-016**: Addresses that already name a project explicitly MUST continue to work as they do
  today.
- **FR-017**: All existing functionality MUST behave as it does now, and no existing control may
  be removed, merged, or renamed.
- **FR-018**: The accessibility standard the product meets today MUST be maintained, including
  full keyboard operation of any new means of choosing a project.

### Key Entities

- **Project**: An existing container for diagrams, which may nest. This feature makes the user's
  *current* project something the application knows and keeps, rather than something only the
  address bar remembers, and gives a project an **owner** so that "the projects available to me"
  becomes expressible. Projects that predate this feature must be given an owner too.
- **Project access**: Who may see and use a project — its owner, plus anyone it has been
  explicitly shared with. Sharing a project with a user is already an established concept in the
  product; this feature begins relying on it for visibility.
- **Current project selection**: Which project the user is working in right now. Session-scoped
  and per-tab rather than a stored preference, so two tabs can sit on different projects without
  fighting.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user who opens the application at its root address can create a diagram with
  **zero** manual edits to the address bar — versus impossible today.
- **SC-002**: **All three** primary actions on the main screen — create, import, create with AI —
  succeed from that same starting point.
- **SC-003**: Project context survives a round trip through **every** admin screen, measured as
  **100%** of admin destinations.
- **SC-004**: **Zero** user choices are discarded when an action cannot proceed; a chosen diagram
  type is still selected afterwards.
- **SC-005**: The three scenarios in the existing reproduction test all pass, **with no weakening
  of their assertions**.
- **SC-006**: A link copied while viewing a project opens that same project for a recipient with
  access, in **100%** of cases.
- **SC-006a**: A user is offered **zero** projects they neither own nor have been given access to,
  and **every** project they do own or have been given remains reachable.
- **SC-006b**: **Zero** unsaved diagrams are lost to a project switch.
- **SC-007**: The complete existing automated test suite passes, and the accessibility audit
  continues to report **zero** violations.
- **SC-008**: Addresses that explicitly name a project continue to work unchanged — **no**
  existing link is broken.

## Assumptions

- **The project in effect is session-scoped and per-tab**, not a saved user preference. Two tabs
  can therefore sit on different projects, which matches how people compare diagrams side by side.
  A stored per-user default is a plausible later addition and is not assumed here.
- **The address continues to reflect the project in view**, so links stay shareable, but keeping
  it current must not add a browser-history entry for every switch (FR-012).
- **With exactly one project — the situation in every current environment — the user is placed in
  it** rather than being asked to choose from a list of one.
- **On a system with no projects, the user is prompted to create one.** Creating one silently was
  considered and rejected: it would invent a name on the user's behalf and leave them unable to
  explain where it came from.
- **Project selection needs a way to know which projects are available to the user.** No such
  capability is exposed today, and adding one is part of this work rather than assumed away. It
  returns only projects the user owns or has been given.
- **Project visibility becomes access-controlled.** This was originally assumed to be out of
  scope and is not: choosing a project requires knowing which projects are available, and listing
  every project to everyone would expose names across tenants, which the constitution's
  namespacing principle forbids. Projects therefore gain an owner, and visibility follows
  ownership plus existing sharing. Access rules for *diagrams* are unchanged.
- **Projects gain an owner; that is the only structural change.** The absence of an owner is
  exactly why "fall back to the user's project" was rejected as a shortcut fix
  (`docs/project-context-brief.md` §3) — this feature supplies the missing concept properly
  instead. Existing projects are given an owner as part of the change, so none becomes orphaned
  or invisible.
- **Project sharing is reused, not invented.** Sharing a project with another user is already an
  established concept in the product; this feature starts relying on it for visibility rather than
  defining a new mechanism.
- **`docs/project-context-brief.md` and bead `canvas-xyl`** hold the diagnosis behind this
  specification, including why the test suite never caught the defect and which alternative
  approaches were rejected.
