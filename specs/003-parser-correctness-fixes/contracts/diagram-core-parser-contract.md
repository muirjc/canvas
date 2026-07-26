# Contract: `diagram-core` parser/serializer extensions

All functions below are pure (no I/O), consistent with 001/002's existing DSL parser contracts.
`ParseError` keeps its existing `{ line, content, message }` shape throughout.

## Architecture parser (`packages/diagram-core/src/dsl/architecture.ts`)

- **`parseArchitecture`** accepts `-->`, `<--`, and `--` connections between services, groups,
  and junctions, each optionally prefixed/suffixed with a `:T`/`:B`/`:L`/`:R` anchor hint on
  either side, in any combination (FR-001, FR-002). The resulting edge's `arrow` field is
  `'target'` for `-->`, `'source'` for `<--`, and `'none'`/undefined for `--`.
- **Invariant**: A diagram using only the pre-existing plain `--` form parses to a model
  identical to today's (FR-004) — `arrow` is undefined, not explicitly `'none'`, for these edges
  (no observable difference to existing consumers).
- **`serializeArchitecture`** emits `-->`/`<--`/`--` matching each edge's `arrow` field, and
  reproduces the anchor hints present on import (FR-003). `parse(serialize(model))` round-trips
  to an equal model.
- **Invariant**: Anchor hints are never validated for graph-theoretic sense (e.g., the same side
  referenced at both ends still parses) — they are positional metadata only.
- **Comments**: lines whose trimmed content starts with `%%` are skipped before any other
  pattern matching (FR-015, FR-016) — never reach the "unrecognized line" error path.

## ER parser (`packages/diagram-core/src/dsl/erd.ts`)

- **`parseErd`** accepts an entity's attribute block — one or more `type name [PK|FK|UK[,...]]
  ["comment"]` lines between `{`/`}` following an entity's declaration (FR-005). Each attribute
  is appended to that `DiagramNode`'s `attributes` array with its `type`, `name`, and recognized
  `keys` (`PK`/`FK`/`UK`, order-preserving).
- **Invariant**: An unrecognized constraint keyword, or a trailing quoted comment, does not
  block the import — the attribute still appears with its type/name, just without that
  particular unrecognized keyword in `keys` (FR-007).
- **Invariant**: An entity's attribute block opened (`{`) but never closed (`}`) before
  end-of-input produces a `ParseError` identifying the specific entity and its opening line
  (FR-018) — not a generic or silent failure.
- **Invariant**: A diagram using only the pre-existing bare `entity relationship : label` form
  (no attribute blocks) parses to a model identical to today's (FR-008).
- **`serializeErd`** emits each entity's attribute block reproducing every attribute's `type`,
  `name`, and `keys` (FR-006). `parse(serialize(model))` round-trips to an equal model (trailing
  comments on individual attribute lines are the one disclosed exception — see spec Assumptions).
- **Comments**: same `%%` handling as the architecture parser above (FR-015, FR-016).

## Sequence parser (`packages/diagram-core/src/dsl/sequence.ts`)

- **`parseSequence`** accepts `Note left of X`, `Note right of X`, and `Note over X[, Y, Z, ...]`
  lines (FR-009), producing a `DiagramContainer` with `role: 'note'`, `attachedNodeIds` listing
  every referenced participant, and an explicit small `size` (not the generic 300×200 fallback).
- **`parseSequence`** accepts `loop`/`alt`/`opt`/`par`/`critical`/`break` blocks with an optional
  label after the opening keyword (FR-010), producing a `DiagramContainer` with `role` set to the
  keyword. `alt`'s `else`, `par`'s `and`, and `critical`'s `option` sub-sections produce **child**
  containers (via `parentContainerId`) with `role` set to their own keyword.
- **Invariant**: Blocks nest to arbitrary depth via the existing `parentContainerId` chaining —
  no depth limit is enforced (FR-011).
- **Invariant**: A control-flow block opened but never closed with a matching `end` before
  end-of-input produces a `ParseError` identifying the specific block and its opening line
  (FR-013) — not a silent misparse.
- **Invariant**: A diagram using only the pre-existing bare `participant` + message form parses
  to a model identical to today's (FR-014).
- **`serializeSequence`** reproduces every note, every control-flow block's grouping/label/
  nesting, and the messages/notes/nested blocks within each, in their original interleaved order
  — using each edge's/container's `sequenceOrder` field to sort elements sharing a scope before
  emitting them (FR-012; data-model.md). `parse(serialize(model))` round-trips to an equal model.
- **Comments**: same `%%` handling as above (FR-015, FR-016).

## Class/UML and C4 parsers (`packages/diagram-core/src/dsl/uml.ts`, `c4.ts`)

- **Comments only**: both parsers gain the same `%%` line-skip as the other three (FR-015,
  FR-016). No other behavior changes — member/generics/annotation/namespace support (UML) and
  additional element kinds/`C4Deployment` (C4) remain explicitly out of scope for this feature
  (tracked as `jmuir-dtu.2`/`jmuir-dtu.3`).

## Canvas rendering (no source change — verified by contract)

- **Invariant**: `apps/web/src/canvas/Canvas.tsx`'s existing generic container rendering (used
  today for flowchart subgraphs and C4 boundaries) renders any `DiagramContainer` regardless of
  its new `role`/`attachedNodeIds` fields — satisfying FR-017 with zero changes to that file.
  Confirmed by one new E2E test importing a sequence diagram containing a note and a `loop`
  and asserting both appear as visible container elements on the canvas.
