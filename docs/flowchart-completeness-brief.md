# Requirements Brief: A Complete Mermaid Flowchart Solution

**Status**: Ready for `/speckit-specify` (one grouping at a time — see §5)
**Created**: 2026-07-29
**Tracked as**: bead `jmuir-dzd` (P3 task), child of epic `jmuir-dtu` ("Mermaid DSL full-compliance
roadmap")

---

## 1. The problem

Feature 002 (User Story 5) added a **bounded, prioritized subset** of Mermaid flowchart grammar —
explicitly not full coverage, by its own Assumptions section:

> Beyond the "graph" alias, `style` directive, and comments (all MUST-have), further constructs
> (e.g., `classDef`/`class` styling, additional node shapes, additional arrow/link styles) are
> addressed on a best-effort basis if time permits, otherwise deferred.

Nothing has picked those up since. `jmuir-dzd` names some of them; direct inspection of
`packages/diagram-core/src/dsl/flowchart-parser.ts`,
`packages/diagram-core/src/dsl/flowchart-serializer.ts`, `packages/diagram-core/src/render/
svg-renderer.ts`, `apps/web/src/canvas/shapes.tsx`, and the shared `DiagramNode`/`DiagramEdge`/
`DiagramContainer` model in `packages/diagram-core/src/model/diagram-model.ts` finds more, beyond
what the bead's text lists. This brief catalogs all of it, grounded in the current code, so
whoever runs `/speckit-specify` next — on one grouping at a time, not all of it at once — starts
from a complete, accurate picture rather than rediscovering gaps mid-spec.

---

## 2. Measured current state

**Supported today** (all three: parses, serializes, and renders):

| Construct | Where |
|---|---|
| `flowchart`/`graph` header, directions TD/LR/TB/RL/BT | `flowchart-parser.ts:33` |
| `%%` comments | `flowchart-parser.ts:111` |
| Node shapes: rectangle `[..]`, rounded `(..)`, circle `((..))`, diamond `{..}`, cylinder `[(..)]` | `flowchart-parser.ts:13-19`, `svg-renderer.ts:23-56` |
| Edges: `-->` only, with or without a label (`-->\|label\|` or `-- label -->`) | `flowchart-parser.ts:27-29` |
| Inline node-shape-in-edge declarations (`A[Start] --> B`) | `flowchart-parser.ts:36-47` |
| `subgraph`/`end` nesting (no direction override) | `flowchart-parser.ts:30,124-144` |
| `style <nodeId> fill:#hex,stroke:#hex` — **fill/stroke only**, other properties silently ignored | `flowchart-parser.ts:206-216` |

**Not implemented at all** (confirmed by absence, not inference):

- Additional node shapes: stadium `([..])`, subroutine `[[..]]`, double-circle `(((...)))`,
  hexagon `{{..}}`, parallelogram `[/../]`/`[\..\]`, trapezoid `[/../\]`/`[\../]`, asymmetric
  `>...]`. `NodeShape` (`diagram-model.ts:36-43`) has no slot for any of them, so this is a model
  change, not just a parser one.
- Edge/link styles beyond `-->`: no-arrowhead `---`, dotted `-.->`/`-.-`, thick `==>`/`===`,
  bidirectional `<-->`, invisible `~~~`, chained edges on one line (`A --> B --> C`), fan-out via
  `&` (`A --> B & C`). `DiagramEdge` (`diagram-model.ts:68-85`) has no line-style field for
  flowchart (only an architecture-specific `arrow` field).
- `classDef`/`class` named style classes.
- `linkStyle` (per-edge or indexed style overrides).
- `click` node interactions (href/tooltip/callback).
- `subgraph` `direction` override.
- Multi-line labels (`<br/>` or literal newlines rendering as an actual line break — the *text*
  already round-trips today since label capture is a greedy `.+`, but `svg-renderer.ts` has no
  `<br/>`/`tspan` handling, so it would currently render as literal text, not a line break).

**A related, pre-existing limitation worth naming rather than silently working around**: parsed
`direction` is preserved for round-trip but does not drive initial auto-layout —
`nextAutoPosition()` (`flowchart-parser.ts:49-55`) lays out newly-seen nodes in a fixed left-to-right
grid regardless of the diagram's declared direction. Not part of `jmuir-dzd`, but anyone touching
subgraph direction should know the top-level direction isn't fully "live" today either.

**Interactive-canvas note**: only 4 of the 5 currently-supported shapes are user-addable from the
toolbar (`apps/web/src/canvas/shapes.tsx:60-64` — rectangle, rounded, circle, diamond; cylinder is
parse/render-only, not offered as an "Add Shape" button). Any new shape needs an explicit decision
about whether it also gets a toolbar button, not just parser/render support.

---

## 3. Why this keeps recurring rather than getting fixed once

Nothing here is a defect in what feature 002 shipped — it was scoped down on purpose. The pattern
so far has been "file a sub-issue if a real import hits a gap," which is reasonable but means the
gap list only grows one ad hoc discovery at a time. This brief is the one-time catch-up; after it,
`jmuir-dzd` (and its siblings under `jmuir-dtu`) can go back to that same discovery-driven model
for whatever this pass doesn't cover.

---

## 4. Constraints (apply to every grouping below)

- **Constitution Principle I (Diagram-as-Data)**: every new construct must round-trip losslessly.
  For constructs the canvas has no visual concept of yet (e.g., `click`), the front-matter escape
  hatch already used for position/style/icon data is the established pattern — not a new one to
  invent.
- **Constitution Principle IV (Test-First for Rendering & Export, NON-NEGOTIABLE)**: nearly
  everything below is a rendering change (a new shape, a new line style) or touches export
  fidelity. Contract tests for parse/serialize round-trip MUST exist and fail before
  implementation, per feature 003's precedent (`specs/003-parser-correctness-fixes/`).
- **Constitution Principle VI (Simplicity & Incremental Delivery)**: do not scope one giant
  "complete Mermaid flowchart" feature. Each grouping in §5 is independently valuable and
  independently shippable — that's the point of splitting them.
- **`packages/diagram-core/src/render/` changes are in scope** for this work (unlike feature 008,
  which was explicitly forbidden from touching it) — new shapes and line styles are only real once
  they render, not just parse.
- A security note, not a deferral: Mermaid's `click` directive has a *callback* form (`click id
  callback`) that historically maps to invoking a named JS function. If/when `click` is scoped,
  the href/tooltip form should be supported; the callback-name form should very likely be rejected
  or explicitly out of scope rather than implemented as "call whatever function this string
  names" — that is a code-execution vector, not a parsing nuance.

---

## 5. Proposed groupings — separate `/speckit-specify` passes, not one spec

Ordered by suggested sequence (highest value / most self-contained first), not by priority alone.

| # | Grouping | Touches | Why grouped this way |
|---|---|---|---|
| **A** | **Additional node shapes** — stadium, subroutine, double-circle, hexagon, parallelogram, trapezoid, asymmetric | model, parser, serializer, `svg-renderer.ts`, `Canvas.tsx` interactive rendering, `shapes.tsx` palette | Pure additive visual vocabulary; no new interaction model; same pattern as the 5 shapes already done. Best first spec — bounded, low-risk, high visible value. |
| **B** | **Additional edge/link styles** — dotted, thick, no-arrowhead, bidirectional, invisible, chained/`&`-fan-out edges | model (`DiagramEdge`), parser, serializer, renderer | Same shape as A but for edges. Could be combined with A or run right after it — both are "recognize more of the drawing vocabulary," no new semantics. |
| **C** | **`classDef`/`class` styling** | parser (classDef def + class assignment lines), maps onto existing `NodeStyle`/front-matter styles mechanism already used for `style` | Import-compatibility, same shape as feature 002's `style` directive work. Natural next step once A/B exist, since classes often style non-default shapes. |
| **D** | **`linkStyle` directive** | parser, maps onto edge style (new field from B) | Same idea as C, for edges. Depends on B existing (nothing to target styles at otherwise). |
| **E** | **`subgraph` `direction` override** | model (`DiagramContainer` gains a `direction` field), parser, serializer | Self-contained, but should note-in-spec the pre-existing top-level-direction-doesn't-drive-layout limitation (§2) so it isn't "fixed" as an accidental side effect nobody decided on. |
| **F** | **Multi-line labels** (`<br/>` → real line break) | `svg-renderer.ts` text rendering (`<tspan>` per line), `Canvas.tsx` on-canvas text rendering | Small, but purely a rendering fix — the text itself already parses/round-trips. |
| **G** | **`click` node interactions** | model (new field — href/tooltip only, per the security note in §4), parser, serializer, renderer, **export** (SVG hyperlink) | Deliberately last and likely its own careful spec: it is the one item here that is a genuinely new *capability* (clickable diagram output), not "recognize more existing vocabulary." Needs an explicit product decision on scope (href/tooltip only vs. any form of callback) before `/speckit-specify` should proceed. |

**Out of scope for all of the above** (separate epic children, not this brief):
- Gaps in the other five DSL families (sequence, ERD, UML, C4, architecture) — `jmuir-dtu.2`
  through `jmuir-dtu.6`.
- The ~24 entirely unimplemented Mermaid diagram types — `jmuir-dtu.7`.

---

## 6. Open questions for whichever grouping is specified first

1. **Shapes/edges (A/B): does every new construct also need an interactive "Add Shape"/"Add Edge
   Style" affordance**, or is parse+render+serialize sufficient for constructs a user would mostly
   encounter via import rather than draw from scratch? (Precedent: cylinder today is
   render-but-not-toolbar.)
2. **click (G): href/tooltip only, or is any callback-style support wanted at all**, even in a
   restricted form (e.g., only navigating to an in-app diagram id, never an arbitrary URL or named
   function)? This has real security-surface implications and shouldn't be decided implicitly by
   whoever happens to implement it.
3. **classDef/linkStyle (C/D): do these become the canonical persistence path**, replacing
   front-matter as the round-trip mechanism for style data, or does front-matter remain canonical
   with `classDef`/`class`/`linkStyle` treated purely as *import*-compatibility (parsed and folded
   into the existing `NodeStyle`/edge-style fields), exactly how `style` already works today per
   `flowchart-serializer.ts` (which never emits a `style` line back out)?
