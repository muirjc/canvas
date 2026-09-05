# Feature Specification: Sequence Diagram Lifeline Rendering

**Feature Branch**: `011-sequence-lifeline-rendering` (not yet created)
**Created**: 2026-09-05
**Status**: Draft
**Input**: canvas-7vs.1 — "Sequence diagrams have no lifeline/timeline layout or rendering at
all" (P1, the largest single finding of the canvas-7vs renderer-completeness audit). Every
sequence-diagram participant, message, activation, control-flow block, note, and box grouping
parses and models correctly (jmuir-dtu.4/.4.1), but both `parseSequence`'s own auto-placement and
both renderers treat a sequence diagram exactly like a flowchart: one flat horizontal row of boxes
at a fixed y, connected by straight lines. Confirmed live (a 2-participant Alice/John exchange
with activation): every message between the same two participants renders fully coincident —
overlapping, illegible, with no visible ordering — and activation markers float at arbitrary
positions unrelated to the participant they belong to. This is often *worse* than a generic
flowchart layout for the common back-and-forth shape, since a flowchart at least visually
separates distinct nodes.

## Clarifications

### Session 2026-09-05

- Q: Should manual drag-to-reposition remain a supported interaction for sequence diagrams once
  this ships, or is computed-only layout (no manual override) the right scope? → A: **Computed-only
  layout.** Participant column x-position and message/activation/block y-position are always
  derived from the DSL's own declaration/message order at render time — matching how this codebase
  already computes ER/UML table-row layout and icon-node layout from data rather than from a
  stored per-row position. Manual dragging is disabled for sequence-family nodes/containers
  (they remain selectable for other existing actions — edit, style, delete); reordering a
  participant or message means editing the DSL order, not dragging it on canvas. Existing
  `canvas.positions`/`canvas.containers` front-matter values for a sequence diagram are simply no
  longer read for layout purposes — no migration or error needed.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - View a sequence diagram as a real lifeline/timeline (Priority: P1)

An architect opens (or exports) any sequence diagram with two or more participants exchanging
multiple messages. Today, every message renders as a coincident, illegible line no matter how many
there are. This story makes each participant a distinct vertical lifeline and each message a
distinct, correctly-ordered horizontal line down that timeline, so the diagram is finally readable
as a sequence diagram rather than a malformed flowchart.

**Why this priority**: This is the confirmed, reported defect and the foundation every other story
in this feature depends on — activation bars, control-flow boxes, and notes all need real lifeline
geometry to anchor to.

**Independent Test**: Render a sequence diagram with 3 participants and at least 2 messages
between the same pair of participants. Every message is drawn as its own visually distinct line
(no pixel overlap with any other message), ordered top-to-bottom exactly matching declaration
order in the source DSL, and each participant has one distinct, non-overlapping vertical lifeline.

**Acceptance Scenarios**:

1. **Given** a sequence diagram declaring participants Alice, Bob, and Carol (in that order),
   **When** it is rendered, **Then** three non-overlapping vertical lifelines appear left-to-right
   in that same order.
2. **Given** four messages in declared order `Alice->>Bob`, `Bob-->>Alice`, `Alice->>Bob`,
   `Bob-->>Alice` (the Alice/John activation-example shape that previously collided), **When**
   rendered, **Then** the four messages appear as four distinct horizontal lines at four distinct
   vertical positions, top-to-bottom in declared order, each with its own legible label.
3. **Given** a message whose source and target participant are the same (a self-message),
   **When** rendered, **Then** it renders as a distinguishable loop/notch on that participant's own
   lifeline rather than collapsing into an invisible zero-length line.

---

### User Story 2 - See activation bars anchored to the right lifeline (Priority: P2)

An architect includes `activate`/`deactivate` statements (or the `+`/`-` arrow shorthand) in a
sequence diagram. Today each occurrence renders as a large, arbitrarily-positioned floating dashed
box, unrelated to the participant it activates. This story makes each activation render as a
narrow vertical bar segment on the correct participant's own lifeline, spanning the correct
message range.

**Why this priority**: Depends on User Story 1's lifeline geometry to exist at all; without it, an
activation bar has nothing correct to anchor to. Second-most load-bearing construct after the
core timeline itself — a very common real-world sequence-diagram feature.

**Independent Test**: Render a sequence diagram containing one participant with one
`activate`/`deactivate` pair around a message exchange. A narrow vertical bar appears directly on
that participant's lifeline, starting at the activate point and ending at the deactivate point,
and is visually distinguishable from a plain lifeline (e.g. a filled/outlined narrow rectangle,
not just a thin line).

**Acceptance Scenarios**:

1. **Given** `activate Bob` before a message and `deactivate Bob` after it, **When** rendered,
   **Then** a bar segment appears on Bob's lifeline spanning exactly that message's vertical
   range.
2. **Given** two nested `activate Bob` calls before a single `deactivate Bob` deactivates only the
   innermost, **When** rendered, **Then** two bar segments appear on Bob's lifeline, offset
   horizontally from each other so neither obscures the other.

---

### User Story 3 - See control-flow blocks as correctly-bounded boxes (Priority: P3)

An architect uses `loop`/`alt`/`opt`/`par`/`critical`/`break` (and `rect` background highlights) to
group part of a sequence diagram's messages. Today each renders as a floating dashed box wherever
the flat auto-layout happened to place it, with no relationship to the messages it actually
contains. This story makes each block render as a bounding box that tightly spans the vertical
range of the messages/nested blocks it contains and the horizontal range of only the participant
lifelines actually involved, with a role-appropriate corner label and (for `alt`/`par`/`critical`)
a divider line between each `else`/`and`/`option` branch.

**Why this priority**: Depends on User Story 1 for the message y-positions a block's bounds are
computed from. Lower priority than activation bars — control-flow blocks are common but a
diagram missing this is still far more legible than today's floating-box baseline once User Story
1 alone ships.

**Independent Test**: Render a sequence diagram with a `loop` block wrapping two messages between
two of three declared participants. The rendered box's vertical span covers exactly those two
messages, its horizontal span covers only the two involved participants' lifelines (not the third,
uninvolved one), and it is labeled distinctly from a note or box grouping.

**Acceptance Scenarios**:

1. **Given** a `loop Every minute` block wrapping two messages between Alice and Bob only (Carol
   also declared but not referenced inside the block), **When** rendered, **Then** the box spans
   only Alice's and Bob's lifelines horizontally, not Carol's.
2. **Given** an `alt`/`else` block with two branches, **When** rendered, **Then** a horizontal
   divider line separates the two branches' message ranges within the outer box, at the correct
   vertical position.
3. **Given** a `loop` nested inside an `alt` branch, **When** rendered, **Then** the inner box
   renders fully inside the outer box's bounds.

---

### User Story 4 - See notes and box groupings positioned against real lifelines (Priority: P4)

An architect uses `Note left of`/`Note right of`/`Note over` or a `box ... end` participant
grouping. Today these render as floating boxes unrelated to the participant(s) they reference.
This story positions them correctly relative to the real lifeline geometry introduced by this
feature — adjacent to (or spanning) the correct lifeline(s), at the correct vertical position in
the timeline.

**Why this priority**: Lowest priority — least disruptive to leave positioned-only for now.
Deliberately narrow in scope: this story fixes *position* only. A visually distinct style for
notes/boxes (vs. the same generic dashed rectangle every other container role uses) is tracked
separately as canvas-7vs.8; drawing an explicit connector line from a note to its attached
participant is tracked separately as canvas-7vs.9. Both of those depend on this story's lifeline
geometry but are not delivered by it.

**Independent Test**: Render a sequence diagram with a `Note right of Bob: text` after a message.
The note box appears immediately to the right of Bob's lifeline, at the correct vertical position
in the timeline (not floating at an unrelated location).

**Acceptance Scenarios**:

1. **Given** `Note over Alice, Bob: text`, **When** rendered, **Then** the note box spans
   horizontally across both Alice's and Bob's lifelines at the correct vertical position.
2. **Given** a `box Team Alpha ... end` grouping containing Alice and Bob (Carol declared outside
   it), **When** rendered, **Then** a bounding box appears behind Alice's and Bob's lifelines for
   their full height, not including Carol's.

---

### Edge Cases

- What happens when a sequence diagram has only participants and no messages at all? Lifelines
  still render (full diagram height), just with no message lines crossing them.
- What happens when the same two participants exchange many (10+) messages? Each still gets its
  own row; diagram height grows accordingly (existing `computeBounds`/canvas-scroll handling
  already accommodates a taller canvas — canvas-0s3).
- What happens with a participant declared but never referenced by any message, note, or block?
  It still renders as an idle lifeline with no messages touching it (matches real Mermaid).
- What happens when `autonumber` is on? Each message shows its running number alongside its label,
  consistent with the existing `sequenceAutonumber` start/step fields.
- What happens to a `create`/`destroy`'d participant's lifeline — does it start/stop partway down
  the timeline instead of spanning the full height? **Out of scope for this pass** (see
  Assumptions) — its lifeline still spans the full diagram height like any other participant.
- What happens to `canvas.positions`/`canvas.containers` values already saved in an existing
  sequence diagram's front matter? They are simply no longer read for this family (see
  Clarifications) — no error, no migration step, the diagram just renders correctly the next time
  it's opened.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST render each sequence-diagram participant/actor as one distinct vertical
  lifeline, ordered left-to-right by that participant's first-declaration order in the source DSL,
  spanning the full vertical height of the diagram.
- **FR-002**: System MUST position every message strictly by its declared timeline order
  (`DiagramEdge.sequenceOrder`), each on its own distinct vertical position, so that two or more
  messages between the same pair of participants never visually overlap.
- **FR-003**: System MUST render a self-message (source and target participant are the same) as a
  visibly distinct loop/notch shape on that participant's own lifeline, not an invisible
  zero-length line.
- **FR-004**: System MUST render each `activate`/`deactivate` pair (whether from explicit
  statements or the `+`/`-` arrow shorthand) as a narrow vertical bar segment on the correct
  participant's lifeline, spanning from the activation's message position to the deactivation's.
- **FR-005**: System MUST offset nested/stacked activation bars on the same participant
  horizontally from each other so overlapping activations remain individually visible.
- **FR-006**: System MUST render each `loop`/`alt`/`opt`/`par`/`critical`/`break` block as a
  bounding box whose vertical span covers exactly the range of the messages/nested blocks it
  contains and whose horizontal span covers only the lifelines of participants actually referenced
  by something inside it, labeled with a role-appropriate corner tab (e.g. "loop", "alt").
- **FR-007**: System MUST render a horizontal divider (with its own label, if given) between each
  `else`/`and`/`option` branch inside its parent `alt`/`par`/`critical` block, at the vertical
  position separating that branch's messages from the next.
- **FR-008**: System MUST continue to render a `rect <color> ... end` block's existing fill-color
  behavior (canvas-7vs.2), now positioned/sized per FR-006's bounding rule instead of a
  floating, arbitrarily-placed box.
- **FR-009**: System MUST position `Note left of`/`Note right of`/`Note over` containers adjacent
  to (or, for `over` with multiple participants, spanning across) the lifeline(s) named in their
  `attachedNodeIds`, at the vertical position matching their declared order in the timeline.
- **FR-010**: System MUST render a `box ... end` participant grouping as a bounding box behind the
  full-height lifelines of exactly the participants declared inside it.
- **FR-011**: When `autonumber` is enabled, system MUST render each message's running number
  alongside it, consistent with the existing `sequenceAutonumber` start/step semantics.
- **FR-012**: The interactive canvas and the export (SVG/PNG) renderer MUST compute
  participant/message/block/note/box layout from one single shared calculation, so the two can
  never visually disagree for the same diagram (matches this codebase's established
  canvas/export-parity convention).
- **FR-013**: System MUST NOT allow manual drag-to-reposition of sequence-family nodes or
  containers (layout is always computed per the Clarifications decision); other existing
  interactions on those elements (select, edit label/style, delete) remain available and
  unaffected.
- **FR-014**: An existing sequence diagram's already-saved `canvas.positions`/`canvas.containers`
  front-matter values MUST simply stop being read for layout purposes going forward — opening one
  requires no migration, error, or user action, and it renders correctly under the new computed
  layout immediately.

### Key Entities

- **DiagramNode** (participant/actor): unchanged shape; now interpreted as a lifeline column
  rather than a freestanding box positioned by its stored `position`.
- **DiagramEdge** (message): unchanged shape; `sequenceOrder` becomes the sole driver of its
  vertical position.
- **DiagramContainer** (block/branch/rect/note/box/activate/deactivate): unchanged shape;
  `sequenceOrder`/`parentContainerId`/`attachedNodeIds` together drive its computed bounds instead
  of its stored `position`/`size`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For any sequence diagram with 2+ messages between the same pair of participants,
  every message renders as a distinct line with zero pixel overlap with any other message.
- **SC-002**: A person viewing a rendered sequence diagram (participants, activation, one
  control-flow block, one note) can correctly state the order messages occurred without reading
  the underlying DSL.
- **SC-003**: 100% of existing sequence-diagram parse/serialize contract tests continue to pass
  unmodified — this feature changes computed layout/rendering only, not the parsed model shape.
- **SC-004**: The interactive canvas and the exported SVG/PNG render pixel-equivalent layout for
  the same sequence diagram model.
- **SC-005**: Every sequence-family construct already modeled today (participant/actor, all 10
  arrow variants, activate/deactivate, loop/alt/opt/par/critical/break with else/and/option
  branches, rect, note-left/right/over, box, autonumber) has a defined, visually distinguishable
  rendering — none render as an unpositioned floating box anymore.

## Assumptions

- Manual drag-to-reposition is out of scope for sequence-family elements (Clarifications) —
  participant/message/block/note/box position is always computed from DSL order.
- A `create`/`destroy`'d participant's lifeline visually starting/ending partway down the timeline
  (instead of spanning the full diagram height like every other participant) is deliberately out
  of scope for this pass, matching this project's established convention of disclosing rather than
  silently attempting a narrower gap; can be filed as its own follow-up if wanted.
- Giving notes/box groupings a visually distinct style (not the same generic dashed rectangle every
  container role uses today) is out of scope — tracked separately as canvas-7vs.8, which this
  feature's lifeline geometry unblocks but does not itself deliver.
- Drawing an explicit connector line from a note or activation marker to the participant it
  annotates is out of scope — tracked separately as canvas-7vs.9 (sequence portion), which this
  feature's lifeline geometry unblocks but does not itself deliver.
- Existing sequence DSL parse/serialize behavior (jmuir-dtu.4/.4.1) is correct and out of scope for
  change — only how the already-correctly-modeled diagram is computed-laid-out and drawn changes.
- No new DSL syntax is introduced by this feature; every construct addressed here already parses
  and round-trips correctly today.
