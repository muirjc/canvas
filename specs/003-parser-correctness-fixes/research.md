# Phase 0 Research: Mermaid Parser Correctness Fixes

## 1. Sequence control-flow blocks (and their branches): model representation

**Decision**: A control-flow block (`loop`/`alt`/`opt`/`par`/`critical`/`break`) is modeled as a
`DiagramContainer` — the same generic grouping/boundary entity flowchart subgraphs and C4
boundaries already use — with a new optional `role` field (mirroring `DiagramNode.role`) set to
the block's keyword (`loop`, `alt`, `opt`, `par`, `critical`, `break`). A block's sub-sections
(`alt`'s `else`, `par`'s `and`, `critical`'s `option`) are modeled as **child** containers nested
via the existing `parentContainerId` field, each with their own `role` (`else`/`and`/`option`).
Messages and notes that belong to a block (or one of its branches) reference it via the existing
`containerId` field on `DiagramEdge`/the note container, exactly like a node nested in a
subgraph today.
**Rationale**: Reuses a model concept and a rendering path (both the SVG export renderer's
`renderContainer` and `apps/web/src/canvas/Canvas.tsx`'s container rendering) that already exist
and are fully generic — neither needs any code change for FR-017's visual-rendering requirement
to be satisfied. Nesting via `parentContainerId` already supports arbitrary depth (used today for
nested flowchart subgraphs), which directly satisfies FR-011's nesting requirement with no new
mechanism.
**Alternatives considered**: A new, sequence-specific `ControlFlowBlock` entity on
`DiagramModel` — rejected; it would need its own rendering support in both the SVG renderer and
the canvas editor (duplicating what `DiagramContainer` already does) for no behavioral gain, and
would violate Constitution VI (no new abstraction where an existing one already fits).

## 2. Sequence notes: model representation

**Decision**: A note (`Note left of`/`Note right of`/`Note over`) is also modeled as a
`DiagramContainer`, with `role: 'note'`, no children, and a new optional `attachedNodeIds`
field listing the participant id(s) it annotates (one id for `left of`/`right of`, one or more
for `over`). The parser assigns it a small explicit `size` (not the renderer's generic
`300×200` fallback used for subgraphs/boundaries) sized to the note text, so it renders as a
small annotation rather than an oversized empty box.
**Rationale**: Same reuse argument as Decision 1 — a note is visually just a small labeled box,
which is exactly what the existing generic container rendering already draws. Giving it an
explicit small `size` is a purely parser-side data decision (the field already exists on
`DiagramContainer`); no renderer change is needed for correct-looking output.
**Alternatives considered**: A new `notes: DiagramNote[]` array on `DiagramModel` — rejected for
the same reason as Decision 1's rejected alternative: it would require new, duplicate rendering
support instead of reusing what's already generic and working.

## 3. Preserving message/note/block interleaving order on round-trip

**Decision**: Add an optional `sequenceOrder?: number` field to both `DiagramEdge` and
`DiagramContainer`, populated only by the sequence parser (undefined/unused for every other
diagram family) as a monotonically increasing counter assigned in the order each message, note,
or block boundary is encountered in the source text. The serializer sorts all elements sharing a
scope (top-level, or a given block's children) by this field before emitting them, interleaving
messages and notes exactly as they appeared in the original DSL.
**Rationale**: Messages live in `DiagramModel.edges` and notes/blocks live in
`DiagramModel.containers` — two separate arrays with no inherent shared ordering between them.
Today's flowchart/C4 serializers don't have this problem because they only ever interleave nodes
within containers (both drawn from a single array's own insertion order — see
`flowchart-serializer.ts`'s `serializeContainer`); sequence diagrams are the first case in this
codebase where two *different* top-level arrays need to interleave correctly, so a shared
ordering key is required for lossless round-trip (Constitution I; FR-012).
**Alternatives considered**: Re-deriving order from array insertion position across both arrays
combined — rejected as fragile and implicit (correctness would depend on insertion order
matching across two unrelated arrays, an easy invariant to accidentally break in future edits);
an explicit field is self-documenting and directly testable.

## 4. ER entity attributes: model representation

**Decision**: Add an optional `attributes` field to `DiagramNode`:
`{ type: string; name: string; keys: string[] }[]`. `keys` holds whichever of `PK`/`FK`/`UK` were
declared (order-preserving, so `PK, UK` round-trips distinctly from `UK, PK` — though no
behavioral difference exists between the two, this preserves the diagram exactly as authored).
An attribute with an unrecognized constraint keyword still parses (FR-007): the keyword is simply
not added to `keys`, and the containing entity's import is not blocked.
**Rationale**: The simplest possible extension — a field only ER diagrams populate, with no
interaction with any other diagram family's use of `DiagramNode`.
**Alternatives considered**: A separate `Attribute` model type with its own array on
`DiagramModel`, keyed by entity id — rejected as needless indirection; attributes have no
identity or behavior independent of the entity they belong to, so nesting them directly on the
node is simpler and matches how the ER diagram's own grammar nests them syntactically.

## 5. Architecture edge arrowhead/direction: model representation

**Decision**: Add an optional `arrow?: 'none' | 'source' | 'target'` field to `DiagramEdge`,
populated only by the architecture parser (default/undefined for every other diagram family,
preserving today's behavior exactly). `-->` sets `'target'` (arrowhead at the target end), `<--`
sets `'source'`, and `--` sets `'none'` (or leaves it undefined — equivalent).
**Rationale**: Architecture diagrams have exactly three connector forms (no bidirectional form
exists in the documented `architecture-beta` grammar, unlike flowcharts' `<-->`), so a 3-value
field fully captures the feature's scope (FR-001–FR-003) without over-generalizing into a
flowchart-style arrow-type system this feature doesn't need.
**Alternatives considered**: Reusing/generalizing a single shared "arrow style" concept across
all diagram families now (anticipating future flowchart edge-variant work from the roadmap
backlog, `jmuir-dtu`) — rejected per Constitution VI: that work is explicitly out of scope for
this feature and tracked separately; building shared infrastructure for it now would be
speculative generalization for a feature that doesn't exist yet.

## 6. Universal `%%` comment support

**Decision**: Apply the exact same one-line fix already proven in the flowchart parser (feature
002) — `if (line.startsWith('%%')) continue;` immediately after the blank-line check, before any
other line-matching — individually to `sequence.ts`, `uml.ts`, `erd.ts`, `c4.ts`, and
`architecture.ts`.
**Rationale**: Mechanical, low-risk, already validated in production for one parser; no reason
to design something new for the other five.
**Alternatives considered**: A shared helper function extracted to a common module — considered,
but each parser's line-processing loop has a slightly different shape (some have a `headerSeen`
gate before the main loop, others don't), so a shared helper would save four single-line
insertions at the cost of an extra abstraction layer for five call sites. Given Constitution VI,
the duplication is judged cheaper than the abstraction; each is one line.

## 7. Structured errors for unclosed blocks (sequence control-flow *and* ER attribute blocks)

**Decision**: Both parsers maintain an explicit stack of "currently open" blocks (recording the
opening keyword/entity id and the line number where it was opened). If the input ends with a
non-empty stack, a `ParseError` is emitted per remaining open entry, citing its specific opening
line and identifier (e.g., `"Unclosed 'loop' block opened at line 4"` /
`"Unclosed attribute block for entity 'CUSTOMER' opened at line 2"`) rather than a generic
end-of-input or "unrecognized content" error.
**Rationale**: Directly satisfies FR-013/FR-018 and the corresponding edge cases; matches this
codebase's existing convention of reporting structured, line-specific errors rather than generic
failures (e.g., `flowchart-parser.ts`'s existing `"end" with no matching "subgraph"` handling for
the reverse case — an `end`/`}` with nothing open).
**Alternatives considered**: A generic "unexpected end of input" error with no further detail —
rejected; the clarification (Q3) explicitly chose the structured, identifying form over this.

---

All Technical Context items are resolved above; no `NEEDS CLARIFICATION` markers remain in
`plan.md`.
