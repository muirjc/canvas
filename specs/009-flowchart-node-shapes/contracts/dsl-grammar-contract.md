# Grammar Contract: Nine New Flowchart Node Shapes

No API, no schema — the contract here is the DSL grammar itself: what text the parser must accept,
what the serializer must produce back, and what must not regress.

---

## Recognized syntax

| Shape | Syntax | Notes |
|---|---|---|
| `stadium` | `id([label])` | |
| `subroutine` | `id[[label]]` | |
| `double-circle` | `id(((label)))` | |
| `hexagon` | `id{{label}}` | |
| `parallelogram` | `id[/label/]` | default orientation |
| `parallelogram-alt` | `id[\label\]` | alternate orientation |
| `trapezoid` | `id[/label\]` | default orientation |
| `trapezoid-alt` | `id[\label/]` | alternate orientation |
| `asymmetric` | `id>label]` | |

**Contract requirements**

- MUST be recognized on a standalone declaration line (FR-001–007).
- MUST be recognized identically as an inline shape-in-edge declaration, e.g.
  `A([Start]) --> B` (FR-008) — `SHAPE_SUFFIX` gains the same nine alternatives as
  `NODE_PATTERNS`, not a separately-maintained list that could drift from it.
- MUST NOT be misidentified as an existing shape due to delimiter overlap — see the five
  collision-pair tests below. This is not optional hardening; without correct `NODE_PATTERNS`
  ordering (data-model.md), several of these WILL silently misparse (research.md §2).
- A construct still unrecognized after this feature MUST continue to produce today's specific,
  per-line parse error (FR-011) — verify against `parse-errors.test.ts`'s existing pattern, not a
  new error format.

## Round-trip contract

- `parse(serialize(model)) === model` for every diagram containing any of these nine shapes
  (FR-010), verified the same way `round-trip.test.ts` already verifies the twelve existing
  shapes — add cases to that file, not a new one, so the same normalization/comparison helper is
  reused.
- Parallelogram/trapezoid orientation MUST survive the round-trip as which of the two `NodeShape`
  values (`parallelogram` vs `parallelogram-alt`, same for trapezoid) was originally parsed —
  never normalized to the other.

## Required regression tests (five collision pairs — data-model.md's ordering table)

Each of these needs its own assertion that the WRONG shape was NOT produced, not just that A shape
was produced:

1. `id[[label]]` → `subroutine`, never `rectangle` with label `[label]`
2. `id([label])` → `stadium`, never `rounded-rectangle` with label `[label]`
3. `id(((label)))` → `double-circle`, never `circle` with label `(label)`
4. `id{{label}}` → `hexagon`, never `diamond` with label `{label}`
5. `id[/label/]` (and the other three parallelogram/trapezoid delimiter pairs) → the correct
   shape, never `rectangle` with a label containing a leading/trailing slash

## Explicitly unchanged

- The five existing shapes (`rectangle`, `rounded-rectangle`, `circle`, `diamond`, `cylinder`) —
  every existing parser/serializer/round-trip test involving them must keep passing unmodified.
- Everything about edges, containers, `style`, `%%` comments, and the `graph`/`flowchart` header
  alias — none of it is touched by this feature.
- No other DSL family (`sequence`, `erd`, `uml`, `c4`, `architecture`) recognizes or produces any
  of these nine values.
