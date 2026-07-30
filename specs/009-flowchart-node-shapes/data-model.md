# Phase 1 Data Model: Additional Mermaid Flowchart Node Shapes

No new entity, no persistence change. This document is the shape of the one thing that does
change — `NodeShape` — and the rendering technique each new value implies in both renderers.

---

## Changed: `NodeShape` (`packages/diagram-core/src/model/diagram-model.ts`)

Today:

```ts
export type NodeShape =
  | 'rectangle'
  | 'rounded-rectangle'
  | 'circle'
  | 'diamond'
  | 'cylinder'
  | 'person'
  | 'icon';
```

**Adds nine values** (research.md §1 — orientation is a distinct value, not a separate field):

| Value | Mermaid delimiter | Orientation of |
|---|---|---|
| `stadium` | `([label])` | — |
| `subroutine` | `[[label]]` | — |
| `double-circle` | `(((label)))` | — |
| `hexagon` | `{{label}}` | — |
| `parallelogram` | `[/label/]` | default |
| `parallelogram-alt` | `[\label\]` | alternate |
| `trapezoid` | `[/label\]` | default |
| `trapezoid-alt` | `[\label/]` | alternate |
| `asymmetric` | `>label]` | — |

No other field on `DiagramNode` changes. `DiagramEdge` and `DiagramContainer` are untouched —
grouping A is node-shape-only, per the brief's own boundary (groupings B/E cover edges and
containers respectively).

---

## Parser: `packages/diagram-core/src/dsl/flowchart-parser.ts`

`NODE_PATTERNS` gains nine entries. **Insertion order is a correctness requirement, not a style
preference** — see research.md §2 for the full collision table. Restated as the concrete array
shape (existing entries unmarked, new ones marked `NEW`):

```
1.  subroutine        [[..]]      NEW — before rectangle and before cylinder
2.  double-circle     (((..)))    NEW — before circle
3.  hexagon           {{..}}      NEW — before diamond
4.  stadium           ([..])      NEW — before rounded-rectangle
5.  cylinder          [(..)]      existing — already before rectangle
6.  parallelogram     [/../]      NEW — before rectangle
7.  parallelogram-alt [\..\]      NEW — before rectangle
8.  trapezoid         [/..\]      NEW — before rectangle
9.  trapezoid-alt     [\../]      NEW — before rectangle
10. asymmetric        >..]        NEW — no collision, order-independent
11. circle            ((..))      existing
12. diamond           {..}        existing
13. rounded-rectangle (..)        existing
14. rectangle         [..]        existing — must stay last; every other `[`/`(`-based pattern is
                                    a more specific superset of its delimiter
```

`SHAPE_SUFFIX` (the inline edge-endpoint token regex, `flowchart-parser.ts:24`) needs the same nine
alternatives added, so a node using any of these shapes is recognized identically whether declared
standalone or inline at an edge endpoint (FR-008).

## Serializer: `packages/diagram-core/src/dsl/flowchart-serializer.ts`

`SHAPE_DELIMITERS` gains nine entries, each an `[open, close]` pair matching the table above
exactly — this is what makes FR-010 (round-trip) hold: `serializeNode` already applies whatever
pair `SHAPE_DELIMITERS[node.shape]` returns with no shape-specific logic, so adding entries is the
entire serializer change.

## Both renderers: `svg-renderer.ts` and `shapes.tsx`

Each new shape needs a real `case`, in **both** files (research.md §3 — no silent fallthrough to
the rectangle `default`, unlike the pre-existing `cylinder`/`person`/`icon` gap this feature does
not fix). Rendering technique per shape — a category, not final geometry, left to implementation:

| Shape | Technique |
|---|---|
| `stadium` | `<rect>` with `rx`/`ry` equal to half the node height (fully rounded ends), vs. `rounded-rectangle`'s fixed small radius |
| `subroutine` | `<rect>` plus two short vertical `<line>` insets near the left/right edges |
| `double-circle` | Two concentric `<ellipse>` elements, small radius gap between them |
| `hexagon` | `<polygon>`, 6 points |
| `parallelogram` / `-alt` | `<polygon>`, 4 points, slanted one way / mirrored |
| `trapezoid` / `-alt` | `<polygon>`, 4 points, slanted the other way / mirrored |
| `asymmetric` | `<polygon>` approximating Mermaid's flag/notch shape |

`DEFAULT_NODE_SIZE` (140×60, present in both files independently) is reused unchanged for all nine
— no shape gets a bespoke bounding box. This matches existing behavior: `diamond` already doesn't
get extra room for its point-to-point text area today, so introducing per-shape sizing now would
be a new convention this feature doesn't need to establish.

## Toolbar: `apps/web/src/canvas/shapes.tsx` + `Canvas.tsx`

`ADDABLE_SHAPES` (flat array) is replaced by a function of `dslFamily` (research.md §4):

```ts
const UNIVERSAL_SHAPES = [rectangle, rounded-rectangle, circle, diamond]; // unchanged, every diagram type
const FLOWCHART_ONLY_SHAPES = [stadium, subroutine, double-circle, hexagon,
                                parallelogram, trapezoid, asymmetric]; // 7 buttons, not 9 —
  // parallelogram-alt/trapezoid-alt get NO button (Clarifications: one control per shape,
  // fixed default orientation only)

getAddableShapes(dslFamily: string) =>
  dslFamily === 'flowchart' ? [...UNIVERSAL_SHAPES, ...FLOWCHART_ONLY_SHAPES] : UNIVERSAL_SHAPES
```

`Canvas` gains a `dslFamily: string` prop; `DiagramEditor.tsx` passes `diagram.dslFamily` through
(already in scope there, per research.md §4).

## Admin standards editor: `apps/web/src/admin/StandardsEditor.tsx`

`KNOWN_SHAPES` gains all nine new values (research.md §5), including both orientation variants —
an admin can govern either orientation even though only the default is toolbar-reachable.

## Unchanged

- `packages/diagram-core/src/standards/{schema,validator}.ts` — already generic over `NodeShape`.
- `DiagramEdge`, `DiagramContainer` — no field changes.
- `addNode()` (`diagram-ops.ts`) — already accepts any `NodeShape`, no change needed.
- Every other DSL family's parser/serializer (sequence, ERD, UML, C4, architecture) — the shared
  `NodeShape` union grows, but nothing outside the flowchart family produces or consumes the nine
  new values (spec Assumptions).
