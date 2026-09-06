# Quickstart: Validating Sequence Diagram Lifeline Rendering

How to confirm this feature works — and, as importantly, how to avoid the two ways it can look
finished while actually leaving canvas/export disagreeing or a construct still floating.

---

## Baseline before starting

```bash
npm run test --workspace=@canvas/diagram-core   # confirmed 633 passing before this feature
npm run test:e2e --workspace=@canvas/web        # apps/web has no unit suite (feature 009's own
                                                  # precedent) — verification here is contract
                                                  # tests plus Playwright E2E
```

---

## The manual check that matters most

1. Open (or import) a sequence diagram shaped like the bug report's own reproduction: Alice/John,
   4 messages with `+`/`-` activation shorthand.
2. Confirm three things that were ALL broken before this feature:
   - Two distinct, non-overlapping vertical lifelines (Alice, John).
   - Four distinct, non-overlapping message lines, top-to-bottom in declared order — not
     coincident.
   - A visible activation bar on John's lifeline, not a large floating dashed box.
3. Add a `loop`/`alt` block wrapping two of the messages, and a `Note right of John: text`. Confirm
   the block's box spans only the two participants' lifelines (not wider than needed) and the
   note sits immediately beside John's lifeline at the correct row.
4. Export to SVG (or PNG). Confirm the exported image matches the canvas exactly — same lifeline
   x-positions, same message y-positions, same activation bar (SC-004).
5. Try to drag a participant or a message/block on the canvas. Confirm nothing moves (FR-013 —
   computed-only layout, per the Clarifications decision) while selecting/editing/deleting still
   works normally.
6. Save, reload. Confirm the diagram renders identically — no drift, no error, even though
   `canvas.positions`/`canvas.containers` are no longer written for this family (FR-014).

---

## The contract tests that matter most

`computeSequenceLayout()` (contracts/sequence-layout-contract.md) needs its own assertions,
independent of any end-to-end render test, for:

| Input | Must assert |
|---|---|
| 3 participants, declared in order Alice/Bob/Carol | Lifeline x-order is Alice < Bob < Carol |
| 4 messages between the same 2 participants | 4 distinct, strictly increasing y-values, in declared order |
| `activate Bob` ... `deactivate Bob` | Bar's `yStart`/`yEnd` match the activate/deactivate messages' own rows; `x` matches Bob's lifeline |
| Two nested `activate Bob` before one `deactivate Bob` | Two activation entries with different `laneOffset` |
| `loop` wrapping messages between Alice and Bob only (Carol also declared) | Block horizontal bounds cover only Alice/Bob's lifeline x-range, not Carol's |
| `alt`/`else` with two branches | A divider entry (or equivalent bound) at the second branch's starting row |
| `Note over Alice, Bob` | Note x-span covers from Alice's to Bob's lifeline |
| A self-message (`A->>A: text`) | `isSelfMessage: true`, distinct from an ordinary two-point message |
| An `activate` with no matching `deactivate` | Finite, well-formed bar geometry (extends to diagram bottom) — not `NaN`/`undefined` |

A test suite that only checks "the diagram renders without throwing" will pass even if every
message collapsed back onto the same y-value — assert actual numeric relationships (strictly
increasing y, correct x membership), not just "no exception."

---

## Automated coverage this feature must add

### 1. `packages/diagram-core` contract tests

- New `sequence-layout.test.ts` — the table above, written first and seen failing before
  `computeSequenceLayout()` exists (Constitution IV).
- Extend `sequence-notes-and-blocks.test.ts` — its existing note/box/block assertions currently
  check *label*/*role* only; add position assertions against the new computed geometry.
- Extend `render-svg.test.ts` — sequence-diagram SVG output now includes real lifeline lines and
  activation bars, not the generic node/container markup.
- Confirm every existing sequence round-trip test still passes unmodified (parse/serialize model
  shape is unchanged — only what happens to `position` after parsing, research.md §1).

### 2. E2E (`apps/web`)

- New `sequence-rendering.spec.ts`:
  - Lifelines render distinctly positioned per participant.
  - Multiple messages between the same pair render at distinct y-positions.
  - An activation bar renders on the correct participant, correct row range.
  - A `loop`/`alt` block's rendered box bounds match only its referenced participants.
  - Dragging a sequence-diagram node/container does not move it (FR-013 regression guard).
  - Exported SVG matches the canvas's own rendered positions for the same diagram.

---

## Full validation before calling it done

```bash
npm run test --workspace=@canvas/diagram-core   # 633 + new sequence-layout/render-svg/notes-blocks cases
npm run test:e2e --workspace=@canvas/web        # + new sequence-rendering.spec.ts
```

Then confirm what automation may not fully cover:

- **SC-002** — a person who has not read the DSL can correctly state message order from the
  rendered diagram alone; check this by eye at least once, not inferred from tests passing.
- **SC-004** — `git diff` on export vs. canvas shows no divergent hardcoded constant (e.g. a
  spacing value duplicated instead of imported from `sequence-layout.ts`).

---

## The two ways this looks done but isn't

1. **"It renders without throwing, ship it."** A test suite that only checks absence of an
   exception can pass even if every message silently collapsed back onto one shared y-value (the
   exact bug this feature exists to fix) — assert real numeric relationships between positions,
   not just successful render.
2. **A layout constant duplicated instead of shared.** If `Canvas.tsx` or `svg-renderer.ts` ends up
   with its own copy of a spacing/margin number instead of reading it from
   `computeSequenceLayout()`'s own output, the two WILL silently drift the next time either one is
   tuned — exactly the `cylinder` canvas/export mismatch history (feature 009 research §3) at
   whole-diagram scale. Check both files import geometry from the one shared function before
   calling this done.
