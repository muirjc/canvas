# UI Contract: Additional Mermaid Flowchart Node Shapes

## The `data-testid` contract

Additions are fine; no existing identifier is removed or renamed. New toolbar buttons follow the
existing template exactly: `add-shape-${shape}` (`Canvas.tsx:336`), so the seven new buttons are
`add-shape-stadium`, `add-shape-subroutine`, `add-shape-double-circle`, `add-shape-hexagon`,
`add-shape-parallelogram`, `add-shape-trapezoid`, `add-shape-asymmetric` — seven, not nine;
`parallelogram-alt`/`trapezoid-alt` get no button at all (Clarifications).

New admin standards-editor checkboxes follow the existing template exactly:
`allowed-shape-${shape}` / `mandatory-shape-${shape}` (`StandardsEditor.tsx:93,107`) — nine new
pairs, including both orientation variants, since governance may reasonably restrict/require an
orientation even though only one is toolbar-reachable (research.md §5).

---

## Behavioral contract

### Toolbar scoping (FR-012/FR-013)

- The seven new shape buttons appear only when the diagram being edited has `dslFamily ===
  'flowchart'` — checked via a new `dslFamily` prop on `Canvas`, threaded from
  `DiagramEditor.tsx`'s existing `diagram.dslFamily` (research.md §4). **Not** a check on
  `diagramTypeId` — six diagram types share `dslFamily: 'flowchart'` and all six must show the new
  buttons, not just the one literally named `flowchart`.
- The four existing universal shapes (rectangle, rounded-rectangle, circle, diamond) continue to
  appear for every diagram type, unchanged (spec Assumptions) — this is an addition to the palette
  for flowchart-family diagrams, not a restructuring of what already exists elsewhere.
- Each new button, like the existing four, carries an accessible name and title
  (`aria-label`/`title="Add {label}"`) — no new accessibility pattern introduced.

### What each button produces

- Exactly one control per shape (seven), each calling `addNode(model, { shape })` with the shape's
  fixed default value — `parallelogram` and `trapezoid`, never their `-alt` counterparts
  (Clarifications, FR-012). `addNode` itself needs no change; it already accepts any `NodeShape`.

### Rendering (both renderers)

- Every one of the nine `NodeShape` values renders a real, distinct shape in **both**
  `svg-renderer.ts` (export) and `shapes.tsx` (on-canvas) — no silent fallthrough to the rectangle
  `default` case in either file (research.md §3). This is the one thing this feature must not get
  wrong the way the pre-existing `cylinder`/`person`/`icon` canvas-vs-export gap already does.
- Selection highlighting (`shapes.tsx`'s `SELECTION_STROKE` recolor) applies to the new shapes
  exactly as it does to existing ones — it's driven by the `selected` parameter already threaded
  through `renderNodeShape`, not per-shape logic.

### Admin standards governance

- All nine new values are selectable in both the "Allowed shapes" and "Mandatory shapes" checkbox
  groups (`StandardsEditor.tsx`'s `KNOWN_SHAPES`). No change to `validator.ts`/`schema.ts` — they
  are already generic over `NodeShape` (research.md §5).

---

## Preservation contract

- No existing `data-testid` removed, renamed, or merged.
- The five existing shapes' toolbar buttons, rendering, and standards-governance entries are
  byte-for-byte unchanged.
- No new frontend unit test convention introduced — verification is via Playwright E2E, matching
  how every other piece of `apps/web` behavior is already tested (research.md §6).
