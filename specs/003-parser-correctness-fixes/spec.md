# Feature Specification: Mermaid Parser Correctness Fixes

**Feature Branch**: `003-parser-correctness-fixes`
**Created**: 2026-07-26
**Status**: Draft
**Input**: User description: "Improve Mermaid DSL parsing correctness and coverage across the
diagram-core parsers, addressing gaps found in a syntax audit against the full Mermaid language
reference: (1) `%%` comments are only honored in the flowchart parser — add the same support to
sequence, class/UML, ER, C4, and architecture; (2) the architecture parser cannot parse arrowhead
edges (`-->`, `<--`) at all, a real defect against documented syntax; (3) ER diagrams cannot carry
attribute blocks, the single biggest real-world ER gap; (4) sequence diagrams lack notes and
control-flow blocks (`loop`/`alt`/`opt`/`par`/`critical`/`break`), used in the overwhelming
majority of real sequence diagrams. Out of scope: the expanded flowchart shape catalog,
classDef/linkStyle/click, additional flowchart edge variants, class diagram
members/generics/annotations/namespaces, additional C4 element kinds and C4Deployment, sequence
activation/boxes/autonumber/rect-highlighting, and the ~24 entirely-unsupported Mermaid diagram
types — all tracked as a longer-term roadmap, to be addressed in separate future features."

## Clarifications

### Session 2026-07-26

- Q: Should notes and control-flow blocks be visually rendered on the canvas in this feature, or is it parser/model/round-trip only? → A: Rendered visually via the existing generic labeled-boundary affordance (the same rendering path already used for flowchart subgraphs and C4 boundaries) — not a new bespoke UI element.
- Q: Should the multi-participant `Note over` form support an arbitrary number of participants, or is exactly two (the pair form) sufficient? → A: Arbitrary number of participants (`Note over A, B, C, ...`), matching Mermaid's actual grammar completely.
- Q: Should an unclosed ER attribute block get the same treatment as an unclosed sequence control-flow block (FR-013) — a structured error identifying the specific unclosed block — as an explicit requirement? → A: Yes, explicit requirement mirroring FR-013, for consistency and better debuggability than a generic fallback error.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Architecture diagrams with directional connections import correctly (Priority: P1)

An architect pastes or uploads a Mermaid architecture (cloud infrastructure) diagram that uses
standard directional connectors between services — the form shown in Mermaid's own documentation
— and expects it to import successfully, exactly like any other valid Mermaid diagram.

**Why this priority**: This is a defect, not a scope gap — documented, standard Mermaid syntax
fails outright today. Any architecture diagram using a directional connector (the common case) is
completely unusable via import. Fixing it restores baseline correctness for an entire diagram
family.

**Independent Test**: Import an architecture diagram containing `serviceA:R --> L:serviceB` and
`serviceA:R <-- L:serviceB` style connections; both must import successfully, and re-exporting the
result must preserve which endpoint(s) carried an arrowhead.

**Acceptance Scenarios**:

1. **Given** an architecture diagram with a `-->` connection between two services, **When** it is
   imported, **Then** the import succeeds and the connection appears between the correct services.
2. **Given** an architecture diagram with a `<--` connection, **When** it is imported, **Then** the
   import succeeds and the arrow's direction is preserved on export.
3. **Given** an architecture diagram using the existing plain `--` connector (already supported),
   **When** it is imported, **Then** it continues to import and round-trip exactly as before.
4. **Given** an architecture diagram with `:T`/`:B`/`:L`/`:R` directional anchor hints on either
   side of a connection, **When** it is imported and then exported, **Then** the same anchor hints
   are present in the output.

---

### User Story 2 - ER diagrams with attribute blocks import correctly (Priority: P2)

An architect pastes or uploads a Mermaid ER diagram that declares entity attributes (the typical
real-world form — types, names, and primary/foreign/unique key markers) and expects those
attributes to appear on the imported entity, not be silently dropped or rejected.

**Why this priority**: Attribute blocks are how most real-world ER diagrams are actually written;
without this, ER import is usable only for the rare diagram that omits attributes entirely.

**Independent Test**: Import an ER diagram containing an entity with an attribute block (types,
names, and PK/FK/UK markers); the imported entity must show every declared attribute with its
type, name, and key marker(s), and re-exporting it must preserve them.

**Acceptance Scenarios**:

1. **Given** an ER diagram with `CUSTOMER { string id PK, string name }`, **When** it is imported,
   **Then** the `CUSTOMER` entity shows both attributes with their types and the `PK` marker on
   `id`.
2. **Given** an attribute marked `FK` or `UK` (including an attribute with more than one marker),
   **When** imported, **Then** every declared marker is preserved.
3. **Given** an attribute line with a trailing quoted comment, **When** imported, **Then** the
   import succeeds (the comment does not block import, even if it is not required to reappear
   verbatim on export).
4. **Given** an ER diagram using the existing bare `ENTITY1 ||--o{ ENTITY2 : label` form with no
   attribute blocks, **When** imported, **Then** it continues to import and round-trip exactly as
   before.

---

### User Story 3 - Sequence diagrams with notes and control-flow blocks import correctly (Priority: P3)

An architect pastes or uploads a Mermaid sequence diagram that includes explanatory notes and
control-flow structure (loops, conditional branches, parallel actions, critical sections, or
early-exit blocks) and expects that structure to appear on import and survive being edited and
re-exported, not be silently stripped down to a flat list of messages.

**Why this priority**: Notes and control-flow blocks appear in the large majority of real
hand-written sequence diagrams; without them, sequence import is usable only for the simplest
message-only diagrams.

**Independent Test**: Import a sequence diagram containing a `Note over` line and a `loop`
containing two messages; both the note and the loop's boundary/grouping must appear on import, and
re-exporting the diagram must reproduce the same note and loop structure.

**Acceptance Scenarios**:

1. **Given** a sequence diagram with `Note right of Alice: some text`, **When** imported, **Then**
   the note is associated with Alice and appears on the canvas.
2. **Given** a sequence diagram with `Note over Alice, Bob, Carol: some text`, **When** imported,
   **Then** the note is associated with all three participants.
3. **Given** a sequence diagram with a `loop`, `alt`/`else`, `opt`, `par`/`and`,
   `critical`/`option`, or `break` block wrapping one or more messages, **When** imported, **Then**
   the block's grouping and its optional label are preserved, and the messages inside it are
   parsed normally.
4. **Given** a control-flow block nested inside another control-flow block, **When** imported,
   **Then** both levels of nesting are preserved.
5. **Given** a sequence diagram using only the existing bare `participant` + message form,
   **When** imported, **Then** it continues to import and round-trip exactly as before.

---

### User Story 4 - Comments are ignored consistently across every diagram type (Priority: P4)

An architect pastes or uploads a Mermaid diagram of any supported type that includes `%%` comment
lines (a common habit carried over from writing DSL by hand) and expects the comments to be
silently ignored, not treated as invalid content that blocks the import.

**Why this priority**: Broad in reach (affects every diagram type) but lower severity per
occurrence than the above defects/gaps (only diagrams that happen to include a comment are
affected, and the fix is mechanical — the same behavior already exists for flowcharts).

**Independent Test**: Import a sequence, class, ER, C4, or architecture diagram containing a `%%`
comment line anywhere in its body; the import must succeed and the comment must have no effect on
the resulting diagram.

**Acceptance Scenarios**:

1. **Given** a sequence, class/UML, ER, C4, or architecture diagram with a `%%` comment line
   anywhere in the body, **When** it is imported, **Then** the import succeeds and the comment
   line has no effect on the resulting diagram.
2. **Given** a flowchart diagram with a `%%` comment (existing behavior), **When** imported,
   **Then** behavior is unchanged.

### Edge Cases

- What happens when a sequence control-flow block is opened but never closed with a matching
  `end`? The import must fail with a structured error citing the specific unclosed block, not a
  silent misparse or a generic failure.
- What happens when an ER entity's attribute block (`{`) is opened but never closed with a
  matching `}`? The import must fail with a structured error citing the specific unclosed entity,
  not a generic or silent failure.
- What happens when an ER attribute has more than one key marker (e.g., both `PK` and `UK`)? All
  declared markers are recognized and preserved.
- What happens when an architecture edge's directional anchor hints seem contradictory (e.g., the
  same side referenced at both ends)? The hints are treated as cosmetic anchor-point information,
  not validated for graph-theoretic correctness — the connection still imports.
- What happens when a control-flow block has no label text (e.g., a bare `loop` with nothing
  after it)? It imports as an unlabeled block.
- What happens when `%%` appears after other content on the same line (not as the first
  non-whitespace character)? Only whole-line comments are recognized, matching the existing
  flowchart behavior — trailing same-line text after other content is not treated as a comment.
- What happens to an ER attribute whose type or constraint keyword isn't one this platform
  specifically models? It is accepted and its type text is preserved; only `PK`/`FK`/`UK` are
  understood as key markers, but an unrecognized constraint keyword must not block the import.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The architecture diagram parser MUST accept `-->`, `<--`, and `--` connections
  between services, groups, and junctions, matching Mermaid's documented syntax.
- **FR-002**: The architecture diagram parser MUST accept the optional `:T`/`:B`/`:L`/`:R`
  directional anchor hint on either or both sides of a connection, for all three connector forms.
- **FR-003**: The architecture diagram serializer MUST preserve, through an import→export
  round-trip, which endpoint(s) of a connection carried an arrowhead and which anchor hints were
  present.
- **FR-004**: Architecture diagrams using only the pre-existing plain `--` connector form MUST
  continue to import and round-trip exactly as before (no regression).
- **FR-005**: The ER diagram parser MUST accept an entity's attribute block, in the form of one or
  more lines declaring a type, a name, and zero or more key constraints (`PK`, `FK`, `UK`,
  combinable) per attribute.
- **FR-006**: The ER diagram serializer MUST preserve each attribute's type, name, and key
  constraint(s) through an import→export round-trip.
- **FR-007**: An ER attribute line with an unrecognized constraint keyword, or a trailing quoted
  comment, MUST NOT cause the import to fail.
- **FR-008**: ER diagrams using only the pre-existing bare `entity relationship : label` form MUST
  continue to import and round-trip exactly as before (no regression).
- **FR-009**: The sequence diagram parser MUST accept `Note left of`, `Note right of`, and
  `Note over` lines, including the multi-participant `Note over` form with an arbitrary number of
  comma-separated participants (`Note over A, B, C, ...`), associating the note text with every
  referenced participant.
- **FR-010**: The sequence diagram parser MUST accept `loop`, `alt`/`else`, `opt`, `par`/`and`,
  `critical`/`option`, and `break` control-flow blocks, including an optional label after the
  opening keyword.
- **FR-011**: Control-flow blocks MUST support nesting (a block containing another block), to an
  arbitrary depth.
- **FR-012**: The sequence diagram serializer MUST preserve, through an import→export round-trip,
  every note, every control-flow block's grouping and label, and the messages/notes/nested blocks
  contained within each block — none of this structure may be silently flattened or dropped on
  export.
- **FR-013**: An unclosed control-flow block (opened but with no matching `end`) MUST produce a
  structured parse error identifying the specific unclosed block, not a silent misparse.
- **FR-014**: Sequence diagrams using only the pre-existing bare `participant` + message form MUST
  continue to import and round-trip exactly as before (no regression).
- **FR-015**: The sequence, class/UML, ER, C4, and architecture parsers MUST each skip any line
  whose first non-whitespace content is `%%`, treating it as a comment with no effect on the
  parsed diagram — matching the flowchart parser's existing behavior.
- **FR-016**: A `%%` comment line MUST NOT be treated as unrecognized/invalid content and MUST NOT
  block an otherwise-valid import, in any of the five diagram families named in FR-015.
- **FR-017**: Sequence notes and control-flow blocks MUST be visually rendered on the canvas,
  using the platform's existing generic labeled-boundary visual affordance (the same rendering
  path already used for flowchart subgraphs and C4 boundaries) — not a bare parse-and-store with
  no visual representation.
- **FR-018**: An unclosed ER attribute block (an entity's `{` opened but never closed with a
  matching `}`) MUST produce a structured parse error identifying the specific unclosed entity,
  not a generic or silent failure — mirroring FR-013's treatment of unclosed sequence control-flow
  blocks.

### Key Entities *(include if feature involves data)*

- **Sequence Control-Flow Block**: A labeled grouping construct (`loop`, `alt`, `opt`, `par`,
  `critical`, `break`) that contains an ordered sequence of messages, notes, and/or nested
  control-flow blocks; carries an optional label.
- **Sequence Note**: A text annotation attached to one or more participants (`left of`/`right
  of`/`over`, the latter supporting an arbitrary number of participants), independent of any
  message.
- **ER Attribute**: A named, typed field belonging to an entity, with zero or more key constraints
  (`PK`, `FK`, `UK`).
- **Architecture Edge Endpoint**: The anchor point where a connection meets a service, group, or
  junction — carries an optional directional side hint (`T`/`B`/`L`/`R`) and an optional
  arrowhead.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user pasting a Mermaid architecture diagram that uses standard directional
  connectors succeeds on the first import attempt — none of this previously-failing, valid,
  documented syntax is rejected.
- **SC-002**: A user pasting a Mermaid ER diagram that declares entity attributes succeeds on
  import and sees every declared attribute, with its type and key marker(s), on the imported
  entity.
- **SC-003**: A user pasting a Mermaid sequence diagram containing notes and/or control-flow
  blocks succeeds on import, and re-exporting the result reproduces the same notes and block
  structure with no loss.
- **SC-004**: A user pasting any of the five affected diagram types with `%%` comment lines
  succeeds on import 100% of the time — comments never cause an import failure.
- **SC-005**: Every diagram that imported successfully before this feature continues to import
  successfully afterward, with an unchanged result (zero regressions).

## Assumptions

- Round-trip fidelity is required for every new construct in this feature (control-flow blocks,
  notes, ER attributes, architecture edge arrowheads) — consistent with this platform's existing
  principle that the Mermaid DSL is the editable source of truth, not merely a one-way import
  format. None of these are modeled as "import-only, dropped on export."
- ER attribute trailing comments are accepted during import (do not block it) but are not
  guaranteed to reappear byte-for-byte on export, consistent with this codebase's existing,
  disclosed pattern of accepting-but-not-fully-modeling minor textual details (e.g., sequence
  diagram arrow style and ER cardinality symbols today).
- Only whole-line `%%` comments are recognized (a line whose first non-whitespace character is
  `%`); trailing same-line comments after other content are out of scope, matching the existing
  flowchart parser's behavior established in the prior feature.
- No new Mermaid diagram types are introduced by this feature — scope is strictly correctness and
  coverage improvements to the six diagram families already supported (flowchart, sequence,
  class/UML, ER, C4, architecture).
- Architecture diagram edges gain no new cardinality/multiplicity concept — "arrowhead" here means
  only the presence/absence and side of a directional marker (`-->`/`<--`/`--`), not a new
  relationship-strength concept.
