# Feature Specification: Canvas Authoring & Admin Console

**Feature Branch**: `006-authoring-admin-console`
**Created**: 2026-07-28
**Status**: Draft
**Input**: User description: "Improve diagram authoring and the admin console, per docs/authoring-and-admin-brief.md. Adds container objects that can be created, named, moved, resized and have shapes dragged into and out of them, so architects can visually organize a diagram. Makes the existing shape and connector label editing discoverable with a visible affordance. Centers and pads the admin screens, which currently render flush against the viewport edge, and gives every admin screen persistent navigation between the admin destinations plus a route back to the diagrams. Caps version history at the five most recent entries with search to reach older ones. Adds a name, description, creation date and retirement date to standards, which today are distinguishable only by identifier and version number."

## Clarifications

### Session 2026-07-28

- Q: Is User Story 3 about making the existing label-editing gesture discoverable, or about a
  properties panel for editing a shape's other attributes? → A: Visible affordance only — surface
  the editor that already exists; no properties panel in this feature.
- Q: When a container holding shapes is deleted, what happens to those shapes? → A: They are
  released onto the canvas — kept at their current positions, no longer members. Deleting a
  container never deletes its contents.
- Q: Is container nesting in scope for this feature? → A: No — flat containers only. Nested
  containers arriving from existing or imported diagrams must still render and round-trip
  unchanged; only *creating* nesting is deferred.
- Q: The canvas already has a "Group Selected" action producing a container labelled "Group" —
  how should the vocabulary settle? → A: One concept, called "container". The existing action is
  relabelled to present grouping as a way to create a container; the control itself is preserved.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Move around the admin console and read it (Priority: P1)

An admin opens any admin screen and finds its content laid out in a comfortable, centred column
rather than jammed against the left edge of the window, with every other admin destination one
click away and an obvious route back to their diagrams. Today the content sits flush against the
viewport edge with no spacing, adjacent links run together into a single unreadable string, and
the only way to leave an admin screen is to edit the address bar or use browser Back.

**Why this priority**: This is a defect rather than an enhancement — the console is unpleasant to
read and effectively a dead end to navigate out of, which makes every other admin task harder. It
is also the smallest slice in this feature, and the remaining admin-facing work lands on top of
it.

**Independent Test**: Visit each of the five admin screens. Confirm content is centred and
padded, that every other admin destination and a route back to the diagrams is reachable in one
action from each screen, and that the accessibility audit still reports zero violations.

**Acceptance Scenarios**:

1. **Given** any admin screen, **When** it is displayed, **Then** its content is horizontally
   centred within a readable column with clear space on both sides, not flush against the window
   edge.
2. **Given** any admin screen, **When** it is displayed, **Then** navigation to every other admin
   destination is visible without scrolling.
3. **Given** any admin screen, **When** the admin chooses the route back to their diagrams,
   **Then** they arrive at the diagram list without editing the address bar or using browser
   Back.
4. **Given** an admin screen, **When** it is displayed, **Then** the destination the admin is
   currently on is visually distinguishable from the others.
5. **Given** two adjacent links or actions, **When** they are displayed, **Then** they are
   visually separated rather than running together as continuous text.
6. **Given** a non-admin user, **When** they attempt to reach an admin destination, **Then**
   access is denied exactly as it is today.

---

### User Story 2 - Organize a diagram with containers (Priority: P2)

An architect groups related shapes inside a named container — a boundary such as "Payments
Domain" or "AWS VPC" — to show at a glance which parts of a diagram belong together. They can
create an empty container and populate it, rename it, move it so its contents travel with it,
resize it as the diagram grows, and drag shapes into or out of it. Today a container can only be
produced by selecting two or more existing shapes and grouping them, is always called "Group",
and cannot afterwards be renamed, moved, resized, or changed in membership at all.

**Why this priority**: The largest genuinely new capability in this feature, and the one that
changes what an architect can express on the canvas. It is second only because the console defect
above is actively obstructing work today.

**Independent Test**: Create an empty container on a diagram, give it a meaningful name, drag two
shapes into it, move the container and confirm its contents move with it, resize it, then drag
one shape out and confirm it is no longer a member.

**Acceptance Scenarios**:

1. **Given** an open diagram, **When** the architect creates a container, **Then** a named,
   visible boundary appears on the canvas without requiring any shape to be selected first.
2. **Given** an existing container, **When** the architect renames it, **Then** the new name is
   shown on the canvas and preserved when the diagram is saved and reopened.
3. **Given** a container holding shapes, **When** the architect moves the container, **Then**
   every shape inside it moves with it and their positions relative to the container are
   unchanged.
4. **Given** an existing container, **When** the architect resizes it, **Then** the new size is
   preserved when the diagram is saved and reopened, and no shape inside it is moved or resized
   as a side effect.
5. **Given** a shape outside a container, **When** the architect drags it into the container,
   **Then** it becomes a member and subsequently moves with the container.
6. **Given** a shape inside a container, **When** the architect drags it out, **Then** it is no
   longer a member and no longer moves with the container.
7. **Given** a container with shapes inside it, **When** the architect deletes the container,
   **Then** they are told the contained shapes will be kept, and on confirming, every shape
   remains on the canvas at its current position and is no longer a member.
8. **Given** a diagram containing containers, **When** it is exported, **Then** the exported
   output shows the same containers, names, and membership as the canvas.

---

### User Story 3 - Discover how to edit a label (Priority: P3)

An architect who has never used the product before can tell how to change the text on a shape or
a connector. The capability already exists — double-clicking opens an inline editor — but nothing
on screen communicates it, so it is only found by accident or by being told.

**Why this priority**: High value for very little work, but unlike the stories above it makes an
existing capability findable rather than adding one, so nothing is currently impossible without
it.

**Independent Test**: Give someone unfamiliar with the product a diagram and ask them to rename a
shape, without telling them how. Confirm they can do it using only what is visible on screen.

**Acceptance Scenarios**:

1. **Given** a shape on the canvas, **When** the architect selects or hovers it, **Then** a
   visible affordance indicates that its label can be edited.
2. **Given** that affordance, **When** the architect activates it, **Then** the same inline label
   editor opens as the existing double-click gesture produces.
3. **Given** a connector, **When** the architect selects or hovers it, **Then** its label can be
   edited through the same visible affordance.
4. **Given** the existing double-click gesture, **When** it is used, **Then** it continues to
   work exactly as before.
5. **Given** the label editor is open, **When** the architect commits or cancels, **Then**
   behaviour is unchanged from today.

---

### User Story 4 - Tell standards apart and see their lifecycle (Priority: P4)

An admin looking at the standards list can tell what each standard is for, read a description of
its intent, and see when it was created and — if it is no longer in force — when it was retired.
Today standards carry only an identifier, a diagram type, a version number, and a status, so a
list of them is unreadable: the current database holds 33 standards distinguishable only by UUID
and version.

**Why this priority**: Real governance value — machine-checked standards are the product's core
promise — but it is the heaviest item here relative to its visible payoff, because it changes
stored data.

**Independent Test**: Create a standard with a name and description, confirm both appear in the
standards list, retire it, and confirm the retirement date is recorded and displayed alongside
its creation date.

**Acceptance Scenarios**:

1. **Given** the standards list, **When** it is displayed, **Then** each standard shows a
   human-readable name rather than only an identifier and version.
2. **Given** a standard being created, **When** the admin supplies a name and description,
   **Then** both are stored and shown wherever that standard is listed.
3. **Given** any standard, **When** it is displayed, **Then** its creation date is shown.
4. **Given** a published standard, **When** an admin retires it, **Then** the date of retirement
   is recorded and displayed.
5. **Given** a standard that has never been retired, **When** it is displayed, **Then** no
   retirement date is shown.
6. **Given** standards that existed before this feature, **When** they are displayed, **Then**
   they remain usable and readable despite having no name or description originally.

---

### User Story 5 - Find a specific version in a long history (Priority: P5)

An architect opening the version history of a long-lived diagram sees the five most recent
versions rather than an unbroken list of every version ever saved, and can search to reach an
older one. Today every version is listed, so a diagram saved a hundred times produces a hundred
rows.

**Why this priority**: The smallest usability gain of the five, and it only becomes noticeable on
diagrams with long histories.

**Independent Test**: On a diagram with more than five saved versions, confirm only the five most
recent are listed by default, then search for an older version and confirm it can be found and
restored.

**Acceptance Scenarios**:

1. **Given** a diagram with more than five saved versions, **When** the history is displayed,
   **Then** only the five most recent are listed.
2. **Given** a diagram with five or fewer versions, **When** the history is displayed, **Then**
   all of them are listed with no indication that anything is hidden.
3. **Given** a history showing only the most recent versions, **When** it is displayed, **Then**
   it is evident that older versions exist and can be searched for.
4. **Given** an older version not shown by default, **When** the architect searches for it,
   **Then** it appears and can be restored exactly as a recent version can.
5. **Given** a search that matches nothing, **When** it is performed, **Then** the architect is
   told nothing matched rather than shown an empty area.

---

### Edge Cases

- **A container dragged so it overlaps another container** must leave membership unambiguous —
  a shape belongs to exactly one container.
- **A container resized smaller than the shapes it holds** must not silently drop or hide
  members.
- **A container moved so its members would sit outside the visible canvas area** must not lose
  those shapes.
- **Deleting a container** never deletes the shapes inside it — they are released onto the canvas
  and kept.
- **A very long container or standard name** must truncate predictably rather than breaking the
  surrounding layout.
- **A standard created before this feature**, having no name or description, must still be
  identifiable in a list.
- **A diagram with exactly five versions** sits on the boundary of the history cap and must not
  imply hidden versions that do not exist.
- **An admin screen viewed at the minimum supported window width** must keep its navigation
  usable rather than overflowing.
- **A diagram that already contains nested containers**, from an earlier import, must still
  render, save, and export unchanged even though this feature does not let an architect create
  nesting.

## Requirements *(mandatory)*

### Functional Requirements

**Admin console (US1)**

- **FR-001**: Every admin screen MUST present its content horizontally centred within a readable
  column, with clear space between the content and the window edges.
- **FR-002**: Every admin screen MUST offer navigation to every other admin destination without
  scrolling.
- **FR-003**: Every admin screen MUST offer a route back to the diagram list that does not
  require editing the address bar or using browser navigation.
- **FR-004**: The admin destination currently being viewed MUST be visually distinguishable from
  the others.
- **FR-005**: Adjacent links and actions MUST be visually separated from one another.
- **FR-006**: Existing access control MUST be unchanged — admin destinations remain unavailable
  to non-admin users.

**Containers (US2)**

- **FR-007**: An architect MUST be able to create a container without first selecting any shape.
- **FR-008**: An architect MUST be able to give a container a name of their choosing and change
  it later.
- **FR-009**: Moving a container MUST move every shape it contains, preserving each shape's
  position relative to the container.
- **FR-010**: An architect MUST be able to resize a container, and doing so MUST NOT move or
  resize any shape it contains.
- **FR-011**: An architect MUST be able to add a shape to a container and remove a shape from it
  by direct manipulation on the canvas.
- **FR-012**: A shape MUST belong to at most one container at a time.
- **FR-013**: Deleting a container MUST release the shapes inside it onto the canvas — each shape
  is kept at its current position and simply ceases to be a member. Deleting a container MUST
  NEVER delete the shapes it holds.
- **FR-013a**: Deleting a container MUST tell the architect that its contents will be kept before
  the deletion takes effect.
- **FR-014**: Container names, positions, sizes, and membership MUST survive saving and reopening
  a diagram.
- **FR-015**: Exported diagrams MUST show the same containers, names, and membership as the
  canvas.
- **FR-016**: The existing action that groups selected shapes MUST continue to work, and MUST be
  presented as a way of creating a container so that the interface uses a single term for a
  single concept.
- **FR-016a**: Creating a container inside another container is OUT of scope for this feature.
  Diagrams that already contain nested containers MUST continue to render, save, and export
  unchanged.

**Label editing (US3)**

- **FR-017**: A visible affordance MUST indicate that a shape's label can be edited.
- **FR-018**: A visible affordance MUST indicate that a connector's label can be edited.
- **FR-019**: Activating that affordance MUST open the same label editor the existing
  double-click gesture opens.
- **FR-020**: The existing double-click gesture MUST continue to work unchanged.

**Standards (US4)**

- **FR-021**: A standard MUST carry a human-readable name.
- **FR-022**: A standard MUST carry a description of its intent.
- **FR-023**: A standard's creation date MUST be shown wherever the standard is presented in
  detail.
- **FR-024**: Retiring a standard MUST record the date of retirement.
- **FR-025**: A standard's retirement date MUST be shown when, and only when, it has been
  retired.
- **FR-026**: Standards stored before this feature MUST remain usable and identifiable despite
  having no name or description.
- **FR-027**: Standards MUST remain distinguishable in a list without relying on their
  identifier.

**Version history (US5)**

- **FR-028**: Version history MUST show only the five most recent versions by default.
- **FR-029**: When older versions exist beyond those shown, the architect MUST be able to tell
  that they exist.
- **FR-030**: An architect MUST be able to search version history to reach a version not shown by
  default.
- **FR-031**: A version found by searching MUST be restorable in the same way as one shown by
  default.
- **FR-032**: A search matching nothing MUST say so explicitly.

**Preservation**

- **FR-033**: All existing functionality MUST continue to behave as it does today, and no
  existing control may be removed, merged, or renamed.
- **FR-034**: The accessibility standard the product meets today MUST be maintained on every
  screen this feature touches.

### Key Entities

- **Container**: A named, positioned, resizable boundary on a diagram that holds zero or more
  shapes and expresses that they belong together. A shape belongs to at most one container.
  Deleting a container releases its shapes rather than deleting them. The underlying model
  permits containers to nest, but creating nesting is out of scope for this feature. Already
  represented in the diagram model; this feature makes it manipulable. "Container" is the single
  user-facing term for this concept — grouping selected shapes is presented as one way to create
  one.
- **Standard**: An admin-authored, machine-checked rule set for a diagram type. Gains a
  human-readable name, a description of intent, and a retirement date recorded when it leaves
  force; already carries a creation date, a version, and a status.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: From any admin screen, every other admin destination and the diagram list are
  reachable in **one action**, versus editing the address bar today.
- **SC-002**: On every admin screen, content is centred with clear margins on both sides at the
  supported window size — **none** renders flush against the window edge.
- **SC-003**: An architect can create a container, name it, populate it, move it, resize it, and
  change its membership **entirely through direct manipulation on the canvas**, with no step
  requiring the DSL to be edited by hand.
- **SC-004**: Moving a container leaves the relative position of **every** contained shape
  unchanged.
- **SC-004a**: Deleting a container leaves **100%** of the shapes it held still on the diagram,
  at unchanged positions.
- **SC-005**: A person unfamiliar with the product can rename a shape using only what is visible
  on screen, without being told the gesture.
- **SC-006**: **100%** of standards presented in a list are identifiable by name rather than by
  identifier, including those created before this feature.
- **SC-007**: Every retired standard displays the date it was retired; every standard displays
  the date it was created.
- **SC-008**: Version history displays at most **five** entries by default regardless of how many
  versions exist, and any older version can be reached by search.
- **SC-009**: Exporting a diagram that contains containers produces output whose containers,
  names, and membership match the canvas exactly.
- **SC-010**: The complete existing automated test suite passes, and the accessibility audit
  continues to report **zero** violations.

## Assumptions

- **Label editing already exists and this feature makes it discoverable.** Double-clicking a
  shape or connector has opened an inline editor since an earlier release; nothing on screen
  communicates it. This feature adds a visible affordance for that editor. A properties panel for
  a shape's other attributes — colour, size, icon — is explicitly **not** in scope (confirmed
  during clarification).
- **Dropping a shape onto a container adds it to that container**, and dragging it clear removes
  it. Membership is inferred from direct manipulation rather than set through a separate control.
- **Version history search covers version number and date.** Searching by author is excluded
  because author names are not currently surfaced in the history.
- **Admin navigation is placed in a bar beneath the global header**, rather than a left sidebar,
  to preserve horizontal width for the wide data tables on the Users, Standards, and Deleted
  Diagrams screens. A sidebar becomes the better choice if the number of admin destinations grows
  substantially.
- **Containers are in scope for flowchart diagrams only**, consistent with the diagram type the
  product supports most completely.
- **Existing standards are backfilled with a readable placeholder name** derived from their
  diagram type and version, so no stored standard becomes unidentifiable.
- **The five-version history cap is a display default, not a retention policy.** No version is
  deleted; older versions remain restorable via search.
- **`docs/authoring-and-admin-brief.md` records the verified current-state findings** behind this
  specification, including which requests describe genuinely missing capability and which
  describe existing capability that is merely undiscoverable.
