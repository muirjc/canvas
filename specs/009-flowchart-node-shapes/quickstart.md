# Quickstart: Validating Additional Flowchart Node Shapes

How to confirm this feature works — and, as importantly, how to avoid the two ways it can look
finished while actually leaving a silent misparse or a canvas/export mismatch in place.

---

## Baseline before starting

```bash
npm run test --workspace=@canvas/diagram-core   # expect 154 passing
npm run test:e2e --workspace=@canvas/web        # expect 96 passing + 1 skipped
```

`apps/web` has no unit test suite (confirmed, not assumed — `vitest run` there exits 1 with "No
test files found"). This feature does not change that; verification here is diagram-core contract
tests plus Playwright E2E.

---

## The five regression tests that matter most

Before trusting any "shapes parse correctly" happy-path test, confirm the five collision-pair
cases from `contracts/dsl-grammar-contract.md` each have their own assertion:

| Input | Must produce | Must NOT produce |
|---|---|---|
| `A[[label]]` | `subroutine` | `rectangle` labeled `[label]` |
| `A([label])` | `stadium` | `rounded-rectangle` labeled `[label]` |
| `A(((label)))` | `double-circle` | `circle` labeled `(label)` |
| `A{{label}}` | `hexagon` | `diamond` labeled `{label}` |
| `A[/label/]` | `parallelogram` | `rectangle` labeled `/label/` |

A test suite that only checks "the new shape parses" and never checks "the old shape did NOT also
match" will pass even if `NODE_PATTERNS` insertion order is wrong (data-model.md) — the new pattern
matching correctly says nothing about whether an *earlier*, broader pattern would have matched
first if the new one weren't ordered ahead of it.

---

## The manual check that matters most

1. Open a flowchart, import Mermaid text containing all nine shape syntaxes (both orientations of
   parallelogram and trapezoid).
2. Confirm each renders as a visually distinct shape **on the canvas**.
3. Export to SVG (or PNG). Confirm the exported image shows the same nine distinct shapes — not a
   rectangle standing in for any of them.
4. Save, reload. Confirm every shape, and both orientations, are unchanged.
5. Switch to a non-flowchart diagram type (e.g. an ER diagram). Confirm the seven new toolbar
   buttons are **absent** — only the four universal shapes remain.
6. Switch to `business-capability-map` or another non-`flowchart`-id diagram type that shares
   `dslFamily: 'flowchart'` (per `apps/api/src/seed/diagram-types.seed.ts`). Confirm the seven new
   buttons **are** present there too — this is the check that would fail silently if the toolbar
   filter were wrongly keyed on `diagramTypeId` instead of `dslFamily` (research.md §4).

---

## Automated coverage this feature must add

### 1. `packages/diagram-core` contract tests

- Extend `round-trip.test.ts` with cases for all nine new shapes, including both orientations.
- Extend (or add alongside) `flowchart-style-directive.test.ts`-style files with the five
  collision-pair tests above.
- Extend `render-svg.test.ts` (if it asserts per-shape markup) or add a case confirming each new
  shape produces distinct SVG output, not the rectangle fallback.

### 2. E2E

- A flowchart's "Add Shape" toolbar shows all eleven buttons (4 existing + 7 new).
- A non-flowchart-family diagram type's toolbar shows only the 4 existing buttons.
- A `dslFamily: 'flowchart'` diagram type other than `id: 'flowchart'` itself also shows the 7 new
  buttons (the specific regression this feature must not introduce — see manual check step 6).
- Clicking each new toolbar button adds a node of the correct shape.
- The admin standards editor's allowed/mandatory-shape checkboxes include all nine new values.

---

## Full validation before calling it done

```bash
npm run test --workspace=@canvas/diagram-core   # 154 + new shape/round-trip/collision cases
npm run test:e2e --workspace=@canvas/web        # 96 + 1 skipped + new toolbar/standards coverage
```

Then confirm what automation may not fully cover:

- **FR-009** — open the exported SVG/PNG directly and eyeball it against the canvas; a screenshot
  diff is not required, but "the export looks the same as the screen" must be checked by a human
  at least once, not inferred from the tests passing.
- **SC-004** — `git diff` shows no weakened assertion in any existing test file.

---

## The two ways this looks done but isn't

1. **"The new shapes parse, ship it."** Without the five collision-pair tests specifically
   asserting the *wrong* shape wasn't produced, a `NODE_PATTERNS` ordering mistake (e.g. `stadium`
   accidentally placed after `rounded-rectangle`) can silently misparse and every happy-path test
   still passes, because the happy-path test never tried the shape whose pattern now shadows it.
2. **A shape that renders on export but not on canvas (or vice versa).** This is not hypothetical —
   `cylinder` already has exactly this gap today (research.md §3). Adding a `case` to only one of
   `svg-renderer.ts` / `shapes.tsx` reproduces that mistake for a *new* shape instead of fixing the
   old one. Check both files for every one of the nine new values before calling this done.
