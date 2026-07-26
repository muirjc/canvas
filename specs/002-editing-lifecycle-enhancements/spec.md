# Feature Specification: Editing & Lifecycle Enhancements

**Feature Branch**: `002-editing-lifecycle-enhancements`
**Created**: 2026-07-26
**Status**: Draft
**Input**: User description: "Add five editing and lifecycle enhancements to the existing governed diagramming platform: sign out of the application; edit labels on shapes and connectors; delete shapes from the canvas; delete a diagram; and broader Mermaid flowchart DSL compatibility (graph/flowchart header alias, style directive, and other common constructs on a prioritized, non-exhaustive basis)."

This feature extends `001-diagramming-platform`. It does not change that feature's diagram types,
governance model, or persona scoping — it closes five concrete gaps in day-to-day use of the
platform that exists today.

## Clarifications

### Session 2026-07-26

- Q: Can an admin see a soft-deleted diagram's full content (canvas/DSL) before deciding whether
  to restore it, or only its metadata (name, owner, project, deletion date)? → A: Metadata only —
  full content requires restoring it first.
- Q: Should restoring a diagram be tracked (who restored it, when), symmetrically with the
  existing deletion record? → A: Yes — track it for audit purposes.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Edit Labels on Shapes and Connectors (Priority: P1)

An architect changes the text label of any shape already on the canvas, and — separately —
adds, edits, or clears the label on any connector between two shapes, with both the canvas and
the underlying Mermaid DSL updating immediately.

**Why this priority**: Diagrams are edited far more often than they're first drawn. Renaming a
shape and labeling a connector (e.g., naming a relationship "Uses" or "Reads/Writes") are the
most basic, most frequent editing actions there are, and connector labeling currently has no
supported path at all once a connector exists.

**Independent Test**: Can be fully tested by opening any existing diagram, renaming a shape,
adding a label to an existing unlabeled connector, and confirming both the canvas display and
the exported/DSL representation reflect the change.

**Acceptance Scenarios**:

1. **Given** a shape with an existing label, **When** the user edits its label, **Then** the
   canvas displays the new label and the Mermaid DSL updates to match.
2. **Given** a connector with no label, **When** the user adds a label to it, **Then** the
   connector displays that label on the canvas and in the DSL.
3. **Given** a connector with an existing label, **When** the user clears it, **Then** the
   connector displays with no label and the DSL reflects an unlabeled connector.
4. **Given** an in-progress label edit, **When** the user cancels instead of confirming,
   **Then** the original label is left unchanged.

---

### User Story 2 - Delete Shapes from the Canvas (Priority: P2)

An architect selects one or more shapes on the canvas and deletes them, after confirming the
action. Any connector attached to a deleted shape is removed with it, and a group/container left
with no remaining members is automatically removed too.

**Why this priority**: There is currently no way to remove a shape once placed — the only
recourse is discarding the whole diagram. This is a basic editing capability the tool is
currently missing entirely.

**Independent Test**: Can be fully tested by creating a small diagram with a connected pair of
shapes and a group, deleting one shape, and confirming its connector disappears, the shape is
gone from the canvas and DSL, and — when it was a group's last member — the group is gone too.

**Acceptance Scenarios**:

1. **Given** a shape with no connectors, **When** the user selects it and confirms deletion,
   **Then** it is removed from the canvas and the DSL.
2. **Given** a shape connected to another shape, **When** the user deletes it, **Then** the
   connector between them is also removed (no dangling reference to a nonexistent shape).
3. **Given** multiple selected shapes, **When** the user confirms deletion, **Then** all
   selected shapes (and their connectors) are removed in one action.
4. **Given** a shape is the only remaining member of a group, **When** it is deleted, **Then**
   the now-empty group is automatically removed as well.
5. **Given** a pending delete confirmation, **When** the user cancels it, **Then** nothing is
   removed.

---

### User Story 3 - Sign Out of the Application (Priority: P3)

A signed-in user ends their session via a visible control in the application and is returned to
the sign-in screen; they can no longer access authenticated pages or data without signing in
again.

**Why this priority**: Basic session hygiene expected of any authenticated application. The
capability already exists at the API level; it is simply not exposed anywhere in the UI today.

**Independent Test**: Can be fully tested by signing in, clicking sign out, and confirming the
user lands back on the sign-in screen and that reloading any previously-open page requires
signing in again.

**Acceptance Scenarios**:

1. **Given** a signed-in user, **When** they activate sign out, **Then** their session ends and
   they are shown the sign-in screen.
2. **Given** a user who has just signed out, **When** they attempt to load a page that requires
   authentication, **Then** they are required to sign in again rather than seeing prior content
   or data.

---

### User Story 4 - Delete a Diagram (Priority: P4)

A diagram's owner (or an admin) deletes it from within a project, after confirming the action.
The diagram immediately stops appearing in the project browser and search results and can no
longer be opened by the owner or any previously-shared collaborator, but remains recoverable by
an admin for a defined retention window before being permanently purged.

**Why this priority**: Diagram lifecycle management (the ability to remove one you created) is a
basic expectation, but it depends on diagrams and projects already existing (US1/US2 territory
conceptually, though independently deliverable), so it's ordered after the more foundational
editing gaps.

**Independent Test**: Can be fully tested by deleting a diagram as its owner, confirming it no
longer appears in the project browser for the owner or a collaborator it was shared with, and
confirming an admin can still recover it within the retention window.

**Acceptance Scenarios**:

1. **Given** a diagram the user owns, **When** they choose to delete it and confirm, **Then**
   it no longer appears in the project browser or in search results for them.
2. **Given** a diagram shared with another user, **When** the owner deletes it, **Then** the
   collaborator can no longer open it (consistent with existing access-denial behavior).
3. **Given** a diagram deleted within the retention window, **When** an admin restores it,
   **Then** it becomes visible and openable again for the owner and previously-shared
   collaborators, unchanged from its state at deletion.
4. **Given** a diagram deleted longer ago than the retention window, **When** anyone attempts to
   restore or open it, **Then** the system reports it is no longer available rather than
   silently failing or exposing stale data.
5. **Given** a pending delete confirmation, **When** the user cancels it, **Then** the diagram
   is untouched.

---

### User Story 5 - Broader Mermaid Flowchart DSL Compatibility (Priority: P5)

A user imports a hand-authored or externally-produced Mermaid flowchart diagram that uses the
"graph" header (an alias for "flowchart"), per-node `style` directives, and comment lines —
constructs the platform does not currently recognize — and the import succeeds instead of being
rejected.

**Why this priority**: Real-world Mermaid content (from documentation, AI-generated examples,
other tools) commonly uses these constructs. Import compatibility matters for adoption, but this
is the broadest and most open-ended of the five enhancements, so it's prioritized last.

**Independent Test**: Can be fully tested by importing a diagram using a "graph TD" header,
one or more `style` lines, and a `%%` comment line, and confirming it imports successfully with
the styled nodes visually reflecting their specified colors.

**Acceptance Scenarios**:

1. **Given** Mermaid text starting with "graph TD" (or LR/TB/RL/BT), **When** it is imported,
   **Then** it is recognized and parsed identically to an equivalent "flowchart" diagram.
2. **Given** Mermaid text containing a `style <nodeId> fill:#hexcolor` line, **When** it is
   imported, **Then** the import succeeds and the referenced node displays the specified fill
   color on the canvas.
3. **Given** Mermaid text containing a `%%` comment line, **When** it is imported, **Then** the
   comment is ignored and does not cause the import to fail.
4. **Given** Mermaid text using a flowchart construct the platform still does not support after
   this feature, **When** it is imported, **Then** the system reports specifically which
   construct could not be interpreted (per existing FR-019 behavior), never a silent partial
   import.

### Edge Cases

- What happens when a user deletes a shape whose connector had a label — does the labeled
  connector disappear along with the shape it was attached to?
- What happens when a diagram is soft-deleted while another collaborator has it open — do their
  next save/export attempts fail the same way an access-revocation would?
- What happens when someone tries to restore a diagram after its retention window has already
  elapsed and it has been purged?
- What happens when a `style` directive in imported Mermaid text references a node id that
  doesn't otherwise appear in the diagram?
- What happens when a user signs out while a diagram edit has not been saved — is the unsaved
  edit simply lost (consistent with no autosave existing today)?
- How does the system handle an import containing a still-unsupported construct alongside
  otherwise-valid "graph"/`style`/comment usage — does only the specific unsupported line get
  reported, or does the whole import fail?

## Requirements *(mandatory)*

### Functional Requirements

**Sign out**

- **FR-001**: The application MUST provide a visible, always-reachable control for a signed-in
  user to end their session.
- **FR-002**: Signing out MUST terminate the user's server-side session (reusing the existing
  session-termination capability) and return them to the sign-in screen.
- **FR-003**: After signing out, previously-authenticated pages and data MUST NOT be accessible
  without signing in again.

**Edit labels on shapes and connectors**

- **FR-004**: Users MUST be able to edit the label of any existing shape on the canvas after
  creation.
- **FR-005**: Users MUST be able to add, edit, or clear the label of any connector between two
  shapes.
- **FR-006**: Label changes (shape or connector) MUST be reflected immediately in both the
  visual canvas and the underlying Mermaid DSL.

**Delete shapes from the canvas**

- **FR-007**: Users MUST be able to select one or more shapes on the canvas and delete them.
- **FR-008**: Deleting a shape MUST also remove every connector attached to it, so the DSL never
  references a connector endpoint that no longer exists.
- **FR-009**: The system MUST require the user to confirm a shape deletion before it takes
  effect, since no undo capability exists for this action.
- **FR-010**: When deleting a shape leaves a group/container with no remaining member shapes,
  the system MUST automatically remove that now-empty group as well.

**Delete a diagram**

- **FR-011**: A diagram's owner, or an admin, MUST be able to delete it from within its project,
  after confirming the action.
- **FR-012**: Deleting a diagram MUST be a soft-delete: it is immediately hidden from the
  project browser, search, and every collaborator's access (consistent with existing
  access-denial behavior) without being permanently destroyed right away.
- **FR-013**: The system MUST retain a soft-deleted diagram, fully recoverable, for a defined
  retention window (see Assumptions) before it is eligible for permanent removal.
- **FR-014**: An admin MUST be able to restore a soft-deleted diagram within its retention
  window, returning it to normal visibility/access for its owner and prior collaborators
  unchanged from its state at deletion.
- **FR-015**: Attempting to restore or open a diagram past its retention window MUST produce a
  clear "no longer available" outcome, not a silent failure or stale data.
- **FR-020**: The admin-only view of soft-deleted diagrams MUST show only metadata (name, owner,
  project, deletion date) for each entry — not its full canvas/DSL content. Viewing the actual
  content requires restoring the diagram first.
- **FR-021**: Restoring a diagram MUST record which admin restored it and when, symmetrically
  with the existing deletion record (FR-011's "who deleted it"), for audit purposes.

**Broader Mermaid flowchart DSL compatibility**

- **FR-016**: The flowchart parser MUST accept "graph" as a header alias for "flowchart" (same
  directions: TD/LR/TB/RL/BT), producing an identical result to the equivalent "flowchart"
  header.
- **FR-017**: The flowchart parser MUST accept `style <nodeId> <property>:<value>[,<property>:
  <value>...]` directive lines and apply at least fill color and stroke color to the referenced
  node, without failing the import over that line.
- **FR-018**: The flowchart parser MUST accept `%%`-prefixed comment lines, ignoring them rather
  than treating them as unrecognized content.
- **FR-019**: Constructs still unsupported after this feature MUST continue to produce a
  specific, actionable error identifying the exact unrecognized content (per existing FR-005/
  FR-019 behavior from 001), never a silent or partial import.

### Key Entities *(extends 001's data model)*

- **Diagram** (extended): gains a lifecycle state distinguishing active from soft-deleted
  (with a deletion timestamp and who deleted it), an implicit retention/purge policy, and —
  symmetrically — a record of who restored it and when, for any diagram that has been restored.
- **DiagramNode / DiagramEdge** (from 001's shared model): no new fields required for label
  editing; deletion removes matching entries from the model's nodes/edges/containers arrays.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A signed-out user cannot load any previously-accessible diagram or project page
  without signing in again, verified with zero exceptions in testing.
- **SC-002**: A user can rename a shape or add/edit/clear a connector label directly on the
  canvas, with no need to hand-edit raw DSL, in under 10 seconds per label.
- **SC-003**: Deleting a shape (with confirmation) leaves zero dangling connector references in
  the resulting DSL, verified across repeated test scenarios.
- **SC-004**: A deleted diagram disappears from its owner's and every collaborator's view
  immediately, and is successfully recoverable by an admin in 100% of attempts made within the
  retention window.
- **SC-005**: At least 95% of a representative sample of hand-authored Mermaid flowchart
  diagrams using "graph" headers, `style` directives, and comment lines import successfully
  without modification.

## Assumptions

- The soft-delete retention window before a diagram becomes eligible for permanent purge is 30
  days; making this admin-configurable is a possible future enhancement, not required now.
- Only a diagram's owner or an admin may delete it; restoring a soft-deleted diagram within the
  retention window is an admin action in this iteration (no dedicated end-user "trash/recycle
  bin" UI is in scope here).
- Sign out ends only the current session; other active sessions for the same user (e.g., a
  different browser) are unaffected — a "sign out everywhere" capability is out of scope.
- Shape deletion requires confirmation (per this spec); connector-label edits and shape-label
  edits do not, since they are non-destructive and always overwritable.
- "Broader Mermaid compatibility" explicitly does not mean exhaustive coverage of Mermaid's
  entire flowchart grammar. Beyond the "graph" alias, `style` directive, and comments (all
  MUST-have per FR-016–FR-018), further constructs (e.g., `classDef`/`class` styling, additional
  node shapes, additional arrow/link styles) are addressed on a best-effort basis if time
  permits within this feature, and remain an ongoing compatibility effort afterward.
- Bulk/multi-diagram deletion, an undo system for shape or diagram deletion, and compatibility
  improvements to the other DSL families (C4/sequence/ERD/UML/architecture) are out of scope for
  this spec.
