# Contract: `diagram-core` shared library

This is the most constitutionally-critical contract in the system (Principles I, II, IV, V) and
is used identically by `apps/web` (live editing) and `apps/api` (save-time validation, import,
server-side export input). Any change here requires round-trip and validation contract tests to
be updated/added before implementation, per Constitution IV.

## `parse(dsl: string, hint?: DiagramTypeId): ParseResult`

- **Input**: Raw Mermaid DSL text (optionally including the platform's front-matter metadata
  block described in research.md §1), and an optional expected DiagramType hint (used on import,
  User Story 5, when the type isn't already known).
- **Output**: `ParseResult = { model: DiagramModel } | { errors: ParseError[] }`. `ParseError`
  entries MUST include enough location/content information to satisfy FR-005 and FR-019 ("clearly
  report ... rather than silently discarding").
- **Invariant**: `parse` MUST NOT throw for any input; all failure modes are represented in
  `ParseError[]`.

## `serialize(model: DiagramModel): string`

- **Output**: Mermaid DSL text (+ front-matter metadata) that a subsequent `parse()` call
  reconstructs into a model equal to the input, per the round-trip invariant below.
- **Invariant (Round-Trip, Constitution I)**: For all diagrams expressible in the editor,
  `parse(serialize(model)).model` MUST be deep-equal to `model` (ignoring only fields explicitly
  documented as non-semantic, e.g., internal UI selection state). This is the primary property
  tested by the round-trip contract tests required before any diagram-type work begins.

## `validate(model: DiagramModel, standard: Standard): Violation[]`

- **Output**: `Violation[]` as defined in data-model.md (`elementId`, `rule`, `message`,
  `severity: "warning"`). Empty array means fully compliant.
- **Invariant**: Pure function of `(model, standard)` — no I/O, no hidden state — so the same
  result is produced whether called from the browser (live feedback while drawing) or the server
  (save-time re-check, FR-013/FR-024). This is what makes "machine-checked, not advisory"
  (Constitution II) actually consistent across client and server.

## `renderToSvg(model: DiagramModel): string`

- **Output**: Self-contained SVG markup (no external font/network references — constitution's "no
  telemetry / no external network calls in exports" constraint applies here directly).
- Used by: the editor canvas (visual rendering), SVG export (FR-004), and as the input to
  server-side PNG rasterization (research.md §4).

## Library loading contract

## `loadLibrary(manifest: IconShapeLibraryManifest): IconShapeLibrary`

- **Input**: A manifest (icon/shape metadata + asset references) matching the `IconShapeLibrary`
  shape in data-model.md.
- **Invariant (Constitution V)**: Adding a new library or a new version of an existing one is
  exactly one `loadLibrary` call with a new manifest — no changes to `parse`, `serialize`,
  `validate`, or `renderToSvg` are required to support a new icon set.
