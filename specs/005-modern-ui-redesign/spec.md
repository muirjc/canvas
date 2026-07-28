# Feature Specification: Modern UI Redesign

**Feature Branch**: `005-modern-ui-redesign`
**Created**: 2026-07-27
**Status**: Draft
**Input**: User description: "Modernize the Canvas user interface to a neutral IDE-like light theme, per docs/ui-design-spec.md. Covers global chrome, login, home project browser, dialogs, and the diagram editor. Introduces a design token system for color, typography, spacing, radius and elevation with contrast pre-verified against WCAG 2.1 AA. Restructures the diagram editor from bare columns plus a stack of controls below the fold into a document bar, a grouped palette rail, and a tabbed secondary rail for DSL, Chat, Issues and History. Converts dialogs to true modals with focus management, and defines empty, loading and error states for every panel. Diagram element rendering defaults and both renderers stay unchanged. Admin screens inherit tokens only."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A credible, consistent interface across the product (Priority: P1)

An architect opens Canvas and sees a considered, professional application: consistent
typography, a deliberate color palette, aligned spacing, and controls that look and behave the
same everywhere. Today they see unstyled browser defaults — serif body text, native form
widgets, and elements stacked in raw document order — which undermines confidence in a tool
meant to govern an organization's architecture standards.

**Why this priority**: This is the foundation every other story builds on, and it is the only
story that improves *every* screen at once, including the admin screens that receive no bespoke
layout work. It is independently valuable: even with no layout changes at all, a coherent visual
system materially changes how credible and usable the product feels.

**Independent Test**: Sign in and visit each screen. Confirm every screen uses one consistent
type scale, palette, and control style; that no screen renders in browser-default styling; and
that the automated accessibility audit still reports zero violations.

**Acceptance Scenarios**:

1. **Given** any screen in the product, **When** it is displayed, **Then** body text, headings,
   buttons, inputs, and links follow a single consistent visual system rather than browser
   defaults.
2. **Given** two different screens that each contain a primary action button, **When** both are
   compared, **Then** those buttons are visually identical in size, color, and treatment.
3. **Given** any screen, **When** it is audited for accessibility, **Then** no WCAG 2.1 A or AA
   violation is reported.
4. **Given** any text or control boundary, **When** its contrast is measured, **Then** it meets
   or exceeds the required WCAG 2.1 AA threshold.
5. **Given** an admin screen, **When** it is displayed, **Then** it inherits the new visual
   system and remains fully legible and usable, even though it receives no bespoke layout.

---

### User Story 2 - A focused diagram editing workspace (Priority: P2)

An architect working on a diagram sees the canvas as the dominant element, with the shape
palette to one side and supporting tools — the DSL view, the AI chat, standards violations, and
version history — organized into one secondary area they can switch between. Today those four
supporting tools are stacked underneath the canvas as co-equal blocks, so the architect must
scroll away from their diagram to reach any of them, and the canvas itself is squeezed.

**Why this priority**: This is where architects spend nearly all of their time, and it is the
single largest usability gain available. It depends on the visual foundation from Story 1 but
delivers the most visible workflow improvement.

**Independent Test**: Open any diagram. Confirm the canvas is the largest region, that saving,
exporting, and sharing are reachable without scrolling, and that each supporting tool can be
brought into view without leaving the diagram.

**Acceptance Scenarios**:

1. **Given** an open diagram at a standard desktop window size, **When** the editor is
   displayed, **Then** the diagram name, save control, save status, export, and share are all
   visible without scrolling.
2. **Given** an open diagram, **When** the editor is displayed, **Then** the canvas is the
   largest single region on screen.
3. **Given** an open diagram, **When** the architect wants the DSL view, the AI chat, the
   violations list, or version history, **Then** each can be brought into the secondary area by
   a single action, without scrolling and without leaving the diagram.
4. **Given** a diagram is opened, **When** the editor first appears, **Then** the DSL view is
   the secondary panel presented by default.
5. **Given** a diagram with standards violations, **When** the editor is displayed, **Then** the
   number of violations is visible without first opening the violations panel.
6. **Given** the shape palette, **When** it is displayed, **Then** shape, tool, and icon controls
   are visually grouped under labels rather than presented as one undifferentiated list.

---

### User Story 3 - Dialogs that preserve context (Priority: P3)

An architect creating, importing, or sharing a diagram sees the dialog appear over their current
screen, with their previous context still visible behind it. Today each dialog replaces the
whole content area, so the architect loses sight of where they were and what they were doing.

**Why this priority**: Affects five recurring flows and removes a genuine disorientation
problem, but each flow is short and currently completable, so it ranks below the workspace
itself.

**Independent Test**: Trigger each dialog. Confirm it overlays rather than replaces the screen,
that keyboard focus moves into it and stays within it, that Escape closes it, and that focus
returns to the control that opened it.

**Acceptance Scenarios**:

1. **Given** any screen, **When** a dialog is opened, **Then** the dialog appears over the
   current screen and the previous context remains visible behind it.
2. **Given** an open dialog, **When** the architect presses Tab repeatedly, **Then** focus cycles
   only among controls inside the dialog.
3. **Given** an open dialog, **When** the architect presses Escape, **Then** the dialog closes
   and no change is applied.
4. **Given** a dialog that has just closed, **When** focus is examined, **Then** it has returned
   to the control that opened the dialog.
5. **Given** a dialog that performs a destructive action, **When** it is displayed, **Then** its
   confirming action is visually distinguished from a routine confirmation and names the object
   being affected.

---

### User Story 4 - Clear feedback in every state (Priority: P4)

An architect always understands what the interface is doing. A panel with nothing in it explains
why and what to do next; a panel that is fetching shows it is working; a panel that failed says
so and offers a way to retry. Today these situations render as bare text or an empty region,
leaving the architect unsure whether the product is broken, still loading, or genuinely empty.

**Why this priority**: Meaningfully reduces confusion and support burden, but the underlying
functions all work today — this is clarity rather than capability, so it ranks last.

**Independent Test**: For each of the project list, icon search, violations, version history, and
AI chat, force the empty, loading, and failed conditions and confirm each presents a specific,
appropriate message.

**Acceptance Scenarios**:

1. **Given** a panel or list with no content, **When** it is displayed, **Then** it explains why
   it is empty and, where an action would populate it, offers that action.
2. **Given** a panel awaiting data, **When** it is displayed, **Then** it visibly indicates work
   in progress rather than appearing empty or frozen.
3. **Given** a panel whose data failed to load, **When** it is displayed, **Then** it states that
   loading failed and offers a retry where retrying is meaningful.
4. **Given** an architect who has asked their operating system to reduce motion, **When** any
   animated indicator would appear, **Then** motion is suppressed.
5. **Given** any control, **When** the architect hovers it, focuses it by keyboard, activates it,
   or encounters it disabled, **Then** each of those states is visually distinct.

---

### Edge Cases

- **A diagram with a very long name** in the document bar must not push the save, export, or
  share controls off screen or wrap the bar to a second line.
- **A diagram with a very large number of standards violations** must not let the violation
  count badge distort the surrounding controls.
- **Admin-defined diagram colors that are pale, saturated, or near the interface accent color**
  must still render accurately and remain distinguishable from the interface around them.
- **Windows narrower than the supported minimum** must degrade predictably rather than
  overlapping or clipping controls.
- **An architect who wants the DSL view and the AI chat visible at the same time** cannot have
  both, because the secondary area presents one panel at a time. This is an accepted trade-off
  of the chosen layout — see Assumptions.
- **Long project, diagram, and persona names** in lists must truncate predictably rather than
  breaking row alignment.
- **A diagram open on a very large display** must not stretch the supporting panels to
  unusable widths at the expense of readability.
- **Keyboard-only operation of the canvas** must remain possible, including reaching the
  secondary panels and returning to the canvas.

## Requirements *(mandatory)*

### Functional Requirements

**Visual system**

- **FR-001**: Every screen MUST present a single consistent visual system covering typography,
  color, spacing, and control styling, replacing browser-default rendering.
- **FR-002**: Controls of the same kind MUST be styled and behave consistently wherever they
  appear in the product.
- **FR-003**: The product MUST present all copy in a legible typeface without depending on any
  resource fetched over the network.

**Accessibility**

- **FR-004**: All text MUST meet the WCAG 2.1 AA contrast threshold against its background, and
  all boundaries required to identify an interactive control MUST meet the AA non-text contrast
  threshold.
- **FR-005**: Every interactive element MUST present a clearly visible indicator when it receives
  keyboard focus.
- **FR-006**: The product MUST NOT use color as the only means of conveying information, state,
  or distinction.
- **FR-007**: Every control MUST remain reachable and operable by keyboard alone.
- **FR-008**: The redesign MUST NOT introduce any WCAG 2.1 A or AA violation on any screen
  covered by the existing accessibility audit.

**Editor workspace**

- **FR-009**: Document-level actions — save, save status, export, and share — MUST be presented
  in a persistent location visible without scrolling while a diagram is open.
- **FR-010**: The diagram canvas MUST be the largest region of the editor.
- **FR-011**: The DSL view, AI chat, standards violations, and version history MUST share a
  single secondary area in which the architect selects which one is shown, rather than being
  stacked below the canvas.
- **FR-012**: The DSL view MUST be the secondary panel presented by default whenever a diagram
  is opened.
- **FR-013**: The number of outstanding standards violations MUST be visible without opening the
  violations panel.
- **FR-014**: Shape, tool, and icon controls MUST be presented in labeled groups.
- **FR-015**: The active state of a mode control, such as connect mode, MUST be visually evident
  and exposed to assistive technology.

**Dialogs**

- **FR-016**: Dialogs MUST overlay the current screen rather than replacing its content.
- **FR-017**: When a dialog opens, keyboard focus MUST move into it; while open, focus MUST
  remain within it; it MUST be dismissible with Escape; and on close, focus MUST return to the
  control that opened it.
- **FR-018**: A dialog confirming a destructive action MUST distinguish that action visually from
  a routine confirmation and MUST name the object affected.

**Feedback states**

- **FR-019**: Every list or panel that can be empty MUST explain why it is empty and offer the
  action that would populate it, where such an action exists.
- **FR-020**: Every region that loads data asynchronously MUST visibly indicate work in progress.
- **FR-021**: Every region whose data can fail to load MUST report the failure and offer a retry
  where retrying is meaningful.
- **FR-022**: Every interactive control MUST visually distinguish its resting, hover, keyboard
  focus, active, and disabled states.
- **FR-023**: Any motion or animation MUST be suppressed when the architect has requested reduced
  motion.

**Preservation of existing behavior**

- **FR-024**: All existing functionality MUST remain available and behave identically; no control
  may be removed, merged, or renamed by this redesign.
- **FR-025**: The visual appearance of diagram elements themselves — shapes, connectors, labels,
  and containers — MUST remain unchanged, except that the selection highlight MAY be recolored to
  match the new palette.
- **FR-026**: Exported diagrams MUST continue to match what is shown on the canvas, and MUST
  remain free of any reference that would be fetched over a network.
- **FR-027**: Admin-defined diagram colors MUST continue to render exactly as configured and MUST
  remain the visually dominant color on the canvas.
- **FR-028**: Canvas interaction responsiveness MUST NOT degrade relative to the current product.

**Scope boundary**

- **FR-029**: Admin screens MUST inherit the visual system without receiving bespoke layout work
  in this feature.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The automated accessibility audit reports **zero** WCAG 2.1 A/AA violations across
  all audited screens — the same standard the product meets today.
- **SC-002**: Every color pairing used in the interface meets its required contrast threshold,
  verified by measurement rather than judgement, with **100%** of pairs passing.
- **SC-003**: The complete existing automated test suite passes, with **no changes to any test's
  assertions or logic** — the only permitted edits are navigation steps where a panel became
  selectable rather than always present.
- **SC-004**: Exporting an unchanged diagram produces output **identical** to that produced
  before the redesign, confirming diagram rendering was untouched.
- **SC-005**: Canvas interaction sustains the existing responsiveness threshold while dragging
  among 300 diagram elements.
- **SC-006**: At the primary supported window size, **all** document actions and **all four**
  secondary panels are reachable without scrolling, compared with none of the four today.
- **SC-007**: At the primary supported window size, the canvas occupies at least **half** the
  editor's width.
- **SC-008**: **100%** of interactive controls present a visible keyboard focus indicator.
- **SC-009**: **100%** of panels that can be empty, loading, or failed present a specific message
  for each of those conditions, with no blank or unexplained regions.
- **SC-010**: An architect can reach any supporting tool for an open diagram in **one action**,
  versus scrolling the page today.

## Assumptions

- **Desktop-only.** Architects use this at a desk on a large display. A standard laptop/desktop
  window is the primary target; narrower windows degrade gracefully but are not designed for.
  Phone and tablet layouts are out of scope.
- **Light appearance only for this feature.** A dark appearance is deliberately deferred: it
  would double the contrast-verification effort against a zero-violation gate, and because
  diagram colors are admin-defined, a dark canvas risks rendering an organization's configured
  palette unreadable. Colors are to be defined so a dark appearance can be added later without
  rework.
- **The secondary area shows one panel at a time.** This is an accepted trade-off of the chosen
  layout: it maximizes canvas space and keeps the interface simple, at the cost of not being able
  to watch the DSL update while chatting. Allowing two panels open together is a possible later
  enhancement and would not invalidate anything in this feature.
- **Admin screens receive the visual system only.** They improve automatically and remain fully
  usable, but bespoke admin layouts are follow-up work.
- **No new third-party dependency** is required; any imagery is embedded rather than fetched.
- **Diagram rendering is deliberately untouched.** Diagram element appearance is governed by
  admin-defined standards and is produced by two separate paths that must agree for exports to
  match the canvas; changing it would cost coordinated work in both plus export-fidelity
  verification, for no benefit an architect would notice. All visible change comes from the
  interface around the diagram.
- **The existing automated test suite's element identifiers are treated as a contract** and are
  preserved, so the redesign can be verified against the current tests.
- **`docs/ui-design-spec.md` is the authoritative visual reference** for this feature, and
  `docs/ui-design-brief.md` records the constraints it was designed against.
