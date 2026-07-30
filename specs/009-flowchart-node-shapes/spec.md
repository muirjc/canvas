# Feature Specification: Additional Mermaid Flowchart Node Shapes

**Feature Branch**: `009-flowchart-node-shapes`
**Created**: 2026-07-29
**Status**: Draft
**Input**: User description: "docs/flowchart-completeness-brief.md — Grouping A only: additional
flowchart node shapes (stadium, subroutine, double-circle, hexagon, parallelogram, trapezoid,
asymmetric). Do not scope groupings B–G." — Feature 002 added a bounded, prioritized subset of
Mermaid flowchart grammar (five node shapes: rectangle, rounded rectangle, circle, diamond,
cylinder), explicitly deferring "additional node shapes" as a named, expected follow-up. Direct
inspection confirms the model has no representation for seven further shapes Mermaid's own
flowchart grammar defines: stadium, subroutine, double-circle, hexagon, parallelogram, trapezoid,
and asymmetric ("flag"). A hand-authored or externally-produced Mermaid flowchart using any of
them either fails to import or is silently reinterpreted as a plain rectangle today.

## Clarifications

### Session 2026-07-29

- Q: Should these seven shapes get an on-canvas "Add Shape" control, and if so, where? → A: **Yes
  — but only shown when editing a flowchart-family diagram, not on every diagram type's canvas.**
  Today's "Add Shape" toolbar is a single flat list shared by every diagram type; these seven
  shapes carry no defined meaning outside flowchart and no other diagram family's exporter can
  serialize them, so the shape palette becomes diagram-type-aware for the first time rather than
  exposing them globally alongside the four generically-meaningful shapes already there.
- Q: Parallelogram and trapezoid each have two valid orientations. When a user creates a brand-new
  node via the toolbar (rather than importing text that already declared one), which orientation
  is produced? → A: **One toolbar button per shape (seven new buttons total), each producing a
  fixed default orientation.** Matches the "one button per shape" pattern every other shape in this
  feature follows — orientation only matters for faithfully reading text that already chose one;
  a user drawing a fresh node has no existing orientation to satisfy. The non-default orientation
  remains reachable via import or hand-edited DSL, exactly as today's five shapes offer no
  orientation choice at all.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Import a diagram that uses any of the seven additional shapes (Priority: P1)

An architect imports a hand-authored or externally-produced Mermaid flowchart that uses a stadium,
subroutine, double-circle, hexagon, parallelogram, trapezoid, or asymmetric shape for one or more
nodes. Today the import either fails outright or silently treats the node as a plain rectangle,
discarding the shape the original author chose. This story makes the import succeed and preserves
which shape was actually used.

**Why this priority**: This is the reported gap (feature 002's own deferred item, `jmuir-dzd`).
Nothing else in this feature matters if these seven shapes still cannot be read in.

**Independent Test**: Import Mermaid text containing one node of each of the seven shapes. The
import succeeds, and each node's shape (as recorded in the diagram's data) matches what the source
text declared.

**Acceptance Scenarios**:

1. **Given** Mermaid flowchart text containing a stadium-shaped node (`id([label])`), **When** it
   is imported, **Then** the import succeeds and that node is recorded as a stadium shape, not a
   rectangle.
2. **Given** the same text for each of subroutine (`id[[label]]`), double-circle
   (`id(((label)))`), hexagon (`id{{label}}`), parallelogram (`id[/label/]` or `id[\label\]`),
   trapezoid (`id[/label\]` or `id[\label/]`), and asymmetric (`id>label]`), **When** each is
   imported, **Then** the import succeeds and each node is recorded as its own distinct shape.
3. **Given** a node declared using one of these seven shapes the first time it appears as an edge
   endpoint (e.g. `A([Start]) --> B`), **When** the diagram is imported, **Then** that node's shape
   is recognized exactly as it would be from a standalone declaration line.
4. **Given** a diagram using only the five previously-supported shapes, **When** it is imported,
   **Then** nothing about its import changes.

---

### User Story 2 - See the shape actually drawn, not a generic placeholder (Priority: P1)

Once a diagram carries one of these seven shapes, it must look like that shape everywhere the
diagram is shown or exported — on the canvas, and in every exported SVG/PNG — not a rectangle
standing in for it. A shape that parses correctly but renders as something else has not actually
been preserved; it has been silently flattened one step later.

**Why this priority**: Equal to User Story 1. The product's own foundational rule is that the DSL
is the single source of truth and the rendered view must reflect it exactly — an import that
"succeeds" but displays a different shape than the source declared has not really succeeded.

**Independent Test**: Open an imported diagram containing all seven shapes. Each one is visually
distinct from the others and from the five existing shapes, both on screen and in an exported
image.

**Acceptance Scenarios**:

1. **Given** a diagram containing one node of each of the seven new shapes, **When** it is opened
   in the editor, **Then** each node renders as its own visually distinct shape.
2. **Given** that same diagram, **When** it is exported to SVG or PNG, **Then** the exported image
   shows the same distinct shapes as the on-screen canvas.
3. **Given** a diagram is saved after being opened, **When** it is reopened, **Then** every one of
   the seven shapes is exactly the same as before saving — including which of the two orientations
   was used for parallelogram and trapezoid.

---

### User Story 3 - Draw one of the new shapes directly, not only via import (Priority: P2)

An architect starting a diagram from scratch wants to add a node in one of these seven shapes
without first writing or pasting Mermaid text by hand.

**Why this priority**: Secondary to reading existing diagrams correctly (User Stories 1–2), which
is the reported problem — but confirmed in scope (see Clarifications): these shapes should be
authorable from scratch, not only reachable via import.

**Independent Test**: From a blank flowchart, add a node in one of the seven shapes using an
on-canvas control, without typing DSL by hand.

**Acceptance Scenarios**:

1. **Given** an architect editing a flowchart, **When** they look at the "Add Shape" toolbar,
   **Then** all seven new shapes are offered as controls alongside the existing four — exactly one
   control per shape, including parallelogram and trapezoid (each produces a fixed default
   orientation; the other orientation remains reachable only via import or hand-edited DSL).
2. **Given** an architect editing any other diagram type (sequence, ER, UML, C4, architecture),
   **When** they look at that diagram's "Add Shape" toolbar, **Then** none of these seven
   flowchart-specific shapes appear — the toolbar's contents depend on which diagram type is open.

---

### Edge Cases

- A diagram using only the five previously-supported shapes must import and render completely
  unchanged (no regression).
- A node declared in one of the seven new shapes the first time it appears as an edge endpoint
  (rather than on its own line) must be recognized exactly as if it had been declared standalone.
- A rectangle-shaped node whose label happens to start or end with a `/` or `\` character must not
  be misidentified as a parallelogram or trapezoid.
- A subroutine-shaped node (`id[[label]]`) must not be misidentified as a rectangle whose label
  happens to contain a leading/trailing bracket character — the double-bracket delimiter takes
  precedence.
- Parallelogram and trapezoid each have two valid orientations in Mermaid's own grammar; a diagram
  using either orientation of either shape must preserve which orientation was used through a
  save/reload cycle, not silently normalize to one of them.
- A flowchart construct still unrecognized after this feature must continue to produce today's
  specific, per-line parse error — never a silent partial import (matching feature 002's FR-019
  precedent).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST recognize a stadium-shaped node (`id([label])`) on import, without
  rejecting the import or reinterpreting it as a different shape.
- **FR-002**: The system MUST recognize a subroutine-shaped node (`id[[label]]`) on import.
- **FR-003**: The system MUST recognize a double-circle-shaped node (`id(((label)))`) on import.
- **FR-004**: The system MUST recognize a hexagon-shaped node (`id{{label}}`) on import.
- **FR-005**: The system MUST recognize a parallelogram-shaped node in either of its two valid
  orientations (`id[/label/]` and `id[\label\]`) on import, and MUST preserve which orientation was
  used.
- **FR-006**: The system MUST recognize a trapezoid-shaped node in either of its two valid
  orientations (`id[/label\]` and `id[\label/]`) on import, and MUST preserve which orientation was
  used.
- **FR-007**: The system MUST recognize an asymmetric ("flag") shaped node (`id>label]`) on import.
- **FR-008**: Each of these seven shapes MUST be recognized both as a standalone node-declaration
  line and as an inline shape declaration at an edge endpoint, consistent with how the five
  existing shapes already work.
- **FR-009**: Each of these seven shapes MUST render as its own visually distinct shape — never as
  a generic rectangle or as any other existing shape — on the canvas and in exported SVG and PNG.
- **FR-010**: A diagram containing any of these seven shapes MUST round-trip losslessly through a
  save/reload cycle: the shape, and for parallelogram/trapezoid the orientation, MUST be identical
  before and after.
- **FR-011**: A flowchart construct still unrecognized after this feature MUST continue to produce
  a specific, per-line parse error identifying the unrecognized content, never a silent partial
  import.
- **FR-012**: Users MUST be able to add a node in any of these seven shapes directly from an
  on-canvas control while editing a flowchart-family diagram — exactly one control per shape
  (seven total), including parallelogram and trapezoid. Each of those two produces a fixed default
  orientation; neither gets a second control for its other orientation.
- **FR-013**: These seven shapes MUST NOT appear as an on-canvas "Add Shape" option while editing
  any other diagram type (sequence, ER, UML, C4, architecture) — the set of shapes offered depends
  on which diagram type is currently open.

### Key Entities

- **Node Shape**: The closed set of visual shapes a flowchart node may take. Gains seven new
  members (stadium, subroutine, double-circle, hexagon, parallelogram, trapezoid, asymmetric)
  alongside the five that already exist (rectangle, rounded rectangle, circle, diamond, cylinder).
  Parallelogram and trapezoid each carry one of two orientations as part of their identity.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: At least 95% of a representative sample of hand-authored Mermaid flowchart diagrams
  using any of the seven additional shapes import successfully without modification — mirroring
  feature 002's own bar for the constructs it added (SC-005).
- **SC-002**: Every one of the seven new shapes is visually distinguishable, at a glance, from
  every other supported shape, both on screen and in an exported image.
- **SC-003**: 100% of diagrams using any of these seven shapes are pixel-for-pixel/data-identical
  after a save/reload cycle, including parallelogram/trapezoid orientation.
- **SC-004**: Every pre-existing automated check continues to pass unmodified — no existing test
  assertion is weakened or removed to accommodate this feature.

## Assumptions

- The seven shapes are named per Mermaid's own terminology (stadium, subroutine, double circle,
  hexagon, parallelogram, trapezoid, asymmetric) — no new naming scheme is introduced.
- This feature is scoped to the flowchart DSL family only. The shared node-shape vocabulary may
  gain these seven values at the model level, but no other diagram family's parser or serializer
  (sequence, ER, UML, C4, architecture) is changed to produce or consume them.
- Accessibility treatment (keyboard operability, accessible names) for any new on-canvas control
  follows the same pattern already used for the existing four toolbar shape buttons — no new
  convention is introduced.
- The existing four toolbar shapes (rectangle, rounded rectangle, circle, diamond) continue to
  appear for every diagram type, unchanged — only the seven new shapes are diagram-type-scoped.
  This feature does not retroactively restrict what already exists.
- Groupings B through G of `docs/flowchart-completeness-brief.md` (additional edge/link styles,
  `classDef`/`class`, `linkStyle`, `subgraph` direction, multi-line labels, `click` interactions)
  are explicitly out of scope for this feature and will be specified separately.
