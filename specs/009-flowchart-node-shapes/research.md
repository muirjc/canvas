# Phase 0 Research: Additional Mermaid Flowchart Node Shapes

Grounded in direct inspection of the parser, both renderers, the toolbar, and the admin standards
editor. Each decision records what was chosen, why, and what was rejected.

---

## 1. `NodeShape` gains nine values, not seven — orientation is a distinct shape identity

**Decision**: Add nine new `NodeShape` values: `stadium`, `subroutine`, `double-circle`, `hexagon`,
`parallelogram`, `parallelogram-alt`, `trapezoid`, `trapezoid-alt`, `asymmetric`.

**Rationale**: `NodeShape` (`diagram-model.ts:36-43`) is a flat string union with no per-shape
metadata fields anywhere in `DiagramNode` — there is no existing precedent for a "variant" or
"orientation" field alongside `shape`. Introducing one now, for exactly two of nine new shapes,
would be a new cross-cutting concept the rest of the model doesn't have, to save adding two enum
values. A flat value per orientation is simpler and consistent with how every other shape-like
distinction in this codebase already works.

This is purely an internal representation choice — the spec correctly never mentions it, and nothing
about a `parallelogram-alt` value is user-facing. The UI and DSL both still talk about "parallelogram"
and "trapezoid" as one shape with two orientations (spec Clarifications); `-alt` is just which of
the two.

**Alternatives rejected**: a new `orientation?: 'default' | 'alt'` field read only for these two
shapes (introduces a field that means nothing for the other ten shape values, and duplicates
information the shape value itself can encode for free).

---

## 2. Parser regex ordering: three more collision pairs beyond the one the spec already names

**Decision**: Insert new shape patterns into `NODE_PATTERNS` (`flowchart-parser.ts:13-19`) in an
order where every new delimiter pair is checked **before** any existing pattern whose delimiter it
is a superset of. Concretely, before implementation, the required relative ordering is:

| New shape | Delimiter | Must be checked before | Because |
|---|---|---|---|
| `subroutine` | `[[..]]` | `rectangle` (`[..]`) | *(already named in spec Edge Cases)* |
| `stadium` | `([..])` | `rounded-rectangle` (`(..)`) | `A([text])` would otherwise match rounded-rectangle's `\((.+)\)$`, capturing label `[text]` |
| `double-circle` | `(((..)))` | `circle` (`((..))`) | `A(((text)))` would otherwise match circle's `\(\((.+)\)\)$`, capturing label `(text)` |
| `hexagon` | `{{..}}` | `diamond` (`{..}`) | `A{{text}}` would otherwise match diamond's `\{(.+)\}$`, capturing label `{text}` |
| `parallelogram`/`-alt`/`trapezoid`/`-alt` | `[/../]`, `[\..\]`, `[/..\]`, `[\../]` | `rectangle` (`[..]`) | *(already named in spec Edge Cases)* |

**Rationale**: This is exactly the same discipline the current file already applies once —
`cylinder` (`[(..)]`) is checked before `rectangle` (`[..]`) for the identical reason (research
confirmed by reading the array order in `flowchart-parser.ts:13-19`). Three more instances of the
same class exist among the seven new shapes and were not obvious from the spec's two named
examples alone; each needs its own regression test, matching Constitution IV.

**Test requirement, stated explicitly because it is easy to under-scope**: five collision-pair
tests are needed (subroutine/rectangle, stadium/rounded-rectangle, double-circle/circle,
hexagon/diamond, parallelogram-or-trapezoid/rectangle) — not one. A single "new shapes parse
correctly" happy-path test suite would not catch any of these; each requires an assertion that the
*wrong* shape was specifically **not** produced.

**Alternatives rejected**: a single combined regex with named groups disambiguating all twelve
shapes at once (harder to read, harder to add a thirteenth shape to later than five distinct,
independently-ordered patterns).

---

## 3. Two renderers exist, and one already has a live example of them disagreeing

**Decision**: Implement matching `case` branches in both `packages/diagram-core/src/render/
svg-renderer.ts` (canonical export renderer) and `apps/web/src/canvas/shapes.tsx` (interactive
on-canvas renderer) for all nine new shape values, kept visually equivalent.

**Rationale**: These are two independent implementations, not one shared function.
`shapes.tsx`'s own comment states the requirement plainly: "Node fill, stroke, and label styling
are untouched — those come from admin-defined standards and are produced by both renderers, which
must agree for exports to match the canvas." Checking `shapes.tsx`'s actual `switch` shows it
**does not** honor that today for every shape: `cylinder` (and `person`, `icon`) fall through to
the plain-rectangle `default` case on canvas, while `svg-renderer.ts` renders a true cylinder for
export. A saved cylinder-shaped diagram already looks different on screen than in its own
exported SVG.

This is a real, pre-existing gap — but fixing `cylinder`'s inconsistency is not part of grouping A
and is not this feature's job (Constitution VI: don't scope-creep into unrelated pre-existing
issues). What this feature must not do is repeat the mistake for the nine *new* values: every one
of them needs a real `case` in both files, not a silent fallthrough to `default`.

**Alternatives rejected**: fixing `cylinder`/`person`/`icon` in `shapes.tsx` as part of this work
(out of scope — file a follow-up bead instead, since it's a real gap this research surfaced but
not one grouping A asked for).

---

## 4. The shape palette becomes diagram-family-aware via a prop, not a client-side lookup

**Decision**: `Canvas` gains a new `dslFamily: string` prop, threaded from `DiagramEditor.tsx`
(which already holds `diagram.dslFamily` — used today for `getDslFamily(diagram.dslFamily)` and
`useDslSync(...)`). The addable-shapes list becomes a function of that value:
`getAddableShapes(dslFamily)` returning the four universal shapes always, plus the nine new ones
only when `dslFamily === 'flowchart'`.

**Rationale — and the wrinkle that makes `diagramTypeId` the wrong check**: `Canvas` currently
receives only `model: DiagramModel`, which carries `diagramTypeId`, not `dslFamily`. It would be a
mistake to filter on `model.diagramTypeId === 'flowchart'` directly: the seed catalog
(`apps/api/src/seed/diagram-types.seed.ts`) shows **six** diagram types share `dslFamily:
'flowchart'` — `flowchart`, `business-capability-map`, `value-stream`, `application-landscape`,
`roadmap`, and `solution-architecture` — while only one of them has `id: 'flowchart'`. Filtering by
id would wrongly hide these shapes from five of the six flowchart-family diagram types the spec's
"flowchart-family diagram" language is meant to include.

`dslFamily` is cheap to thread down: `DiagramEditor` already has it in scope for the exact same
reason (`useDslSync` needs it to pick a parser/serializer), so passing it one level further to
`Canvas` follows the same existing pattern rather than inventing a new one (e.g., an async
`/diagram-types` lookup inside `Canvas`, which would need to handle a loading state this feature
has no other reason to introduce).

**Alternatives rejected**: filtering on `diagramTypeId === 'flowchart'` (wrong — hides the shapes
from five real flowchart-family diagram types); having `Canvas` fetch diagram-type metadata itself
(adds an async dependency and a loading state for information the caller already has).

---

## 5. Standards enforcement needs zero validator changes — but the admin UI has its own hardcoded list

**Decision**: No change to `packages/diagram-core/src/standards/{schema,validator}.ts`. Add the
nine new shape values to `KNOWN_SHAPES` in `apps/web/src/admin/StandardsEditor.tsx`.

**Rationale**: `allowedShapeIds`/`mandatoryShapeIds` are already typed `NodeShape[]` and validated
generically (`validator.ts:12-32` does a plain `.includes(node.shape)` check) — extending the
`NodeShape` union automatically extends what an admin standard *can* express, with no code change
needed there. This is Constitution Principle II working as designed: shape governance is
data-driven, not hardcoded per shape.

But `StandardsEditor.tsx` renders its allowed/mandatory-shape checkboxes from its own hardcoded
`KNOWN_SHAPES` array (`StandardsEditor.tsx:4`), independent of the `NodeShape` type — nothing
enforces that list stays in sync with the type it's populated from. Without adding the nine new
values there, an admin could never actually permit or require any of them in a standard, even
though the schema and validator already fully support it. Both orientation variants
(`parallelogram`/`parallelogram-alt`, `trapezoid`/`trapezoid-alt`) need their own entries — an
admin may reasonably want to govern either orientation even though only the default is reachable
from the toolbar (the other remains reachable via import, per Clarifications).

**Alternatives rejected**: deriving `KNOWN_SHAPES` from the `NodeShape` type automatically (a
larger refactor of a working, if slightly redundant, pattern — not something this feature's scope
calls for; noted as a small follow-up worth its own bead rather than bundled in here).

---

## 6. No new frontend unit test — this stays E2E, matching how `apps/web` already tests everything

**Decision**: Verify the diagram-family-scoped toolbar (research.md §4) via Playwright E2E
assertions on rendered button testids, not a new unit test for `getAddableShapes()`.

**Rationale**: `apps/web` has no unit test suite at all today (`vitest run` there exits 1 with "No
test files found" — confirmed directly, not assumed). Every existing behavior in this app is
verified through Playwright E2E and axe, including far more intricate logic than a shape filter
(e.g., the entire unsaved-changes-confirmation flow). Introducing the first-ever `apps/web` unit
test for one small pure function would be a new testing convention for this one feature to carry,
rather than following the one already established.

**Alternatives rejected**: adding `apps/web`'s first unit test file (inconsistent with how every
other piece of frontend logic in this app is verified).
