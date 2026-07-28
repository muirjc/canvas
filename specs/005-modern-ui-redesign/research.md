# Phase 0 Research: Modern UI Redesign

Grounded in direct inspection of `apps/web/src`, the E2E suite, and the export renderer. Each
decision records what was chosen, why, and what was rejected.

---

## 1. How the visual system is delivered

**Decision**: Plain global CSS — four files under `apps/web/src/styles/`, imported once from
`main.tsx`. Design tokens as CSS custom properties on `:root`. No CSS framework, no CSS-in-JS,
no CSS Modules, no build-tool change.

| File | Contents |
|---|---|
| `tokens.css` | All custom properties: color, type, spacing, radius, elevation, layout dimensions |
| `base.css` | Reset + **bare element styling**: `body`, headings, `button`, `input`, `select`, `textarea`, `table`, `a` |
| `components.css` | Shared classes: `.btn` variants, `.card`, `.field`, `.panel`, `.tabs`, `.modal`, states |
| `layout.css` | Screen-level layout: app shell, editor grid, rails, canvas container |

**Rationale**: `base.css` styling *bare elements* is what makes FR-029 (admin screens inherit
the visual system with no bespoke work) true essentially for free — the five admin screens are
plain `<table>`, `<input>`, `<select>`, and `<button>` markup, so element-level rules transform
them without touching their files at all. That property only exists with global CSS.

**Alternatives rejected**:
- *CSS Modules* (Vite supports natively, no dependency): scoping is real, but it cannot style
  bare elements in files we are not editing, so admin screens would need per-file work —
  directly defeating the chosen scope. Would also mean running two styling systems at once.
- *Tailwind or any framework*: a new runtime/build dependency the brief rules out, and utility
  classes would have to be applied to every admin element individually — same problem.
- *Extending the existing inline `style={{}}` usage*: cannot express hover, focus-visible, media
  queries, or `prefers-reduced-motion`, all of which are hard requirements here.

---

## 2. Secondary rail: mounting strategy for inactive panels

**Decision**: **Lazy-mount, then keep alive.** A panel is not mounted until first selected;
once mounted it stays mounted and is hidden with `display: none` when another tab is active.

**Rationale**: This is not a cosmetic choice — the panels have side effects on mount, verified
by reading them:

| Panel | Behavior on mount |
|---|---|
| `ChatPanel` | `useEffect` → `GET /diagrams/:id/chat/messages` |
| `VersionHistory` | `useEffect` → `GET /diagrams/:id/versions` |
| `Palette` | `useEffect` → icon search (left rail, always mounted — unaffected) |
| `DslPanel` | none (pure props) |

- *Mount all four eagerly* would fire two extra network requests on **every** diagram open, even
  for architects who never open those tabs.
- *Unmount on switch away* would refetch on every return, and — worse — **discard an unsent chat
  message and the chat scroll position**, a real data-loss-shaped bug.

Lazy-mount-then-keep-alive avoids both: nothing extra is fetched on open, and nothing is lost on
switch. DSL is the default tab (FR-012) and has no fetch, so opening a diagram costs exactly what
it costs today.

**Test consequence**: a panel that has never been selected is genuinely absent from the DOM, so
the four spec files that reach into a non-default panel need a tab activation first. This is
already quantified in the design spec's change manifest (4 files, ~7 lines, no assertion
changes).

---

## 3. Dialogs: native `<dialog>` rather than a hand-rolled focus trap

**Decision**: Use the native `<dialog>` element with `showModal()`, wrapped in a thin `Modal`
component. Preserve each dialog's existing `role`/`aria-label`.

**Rationale**: `showModal()` provides, natively and correctly: focus moved into the dialog, focus
trapped while open, background content made inert, `Escape` dismissal, and a `::backdrop`
pseudo-element for the scrim. That is the whole of FR-017 without hand-written key handling.
Per Constitution VI, the correct move is to use the platform capability rather than build an
abstraction over it.

**Details that matter**:
- `<dialog>` carries an implicit `role="dialog"`, so `getByRole('dialog', { name })` keeps
  working. `ConfirmDialog` currently uses **`role="alertdialog"`** — that role must be set
  explicitly on the element to preserve it, along with its `aria-modal` and `aria-label`.
- Native `Escape` fires a `cancel` event; the wrapper must handle it to keep React state in sync,
  otherwise the element closes while state still says "open".
- Focus restoration to the invoking control is native behavior, satisfying FR-017's last clause.

**Alternatives rejected**:
- *Hand-rolled focus trap hook*: ~60 lines of focusable-selector querying, Tab interception, and
  restore logic — all of it a reimplementation of what the browser already does, and a classic
  source of subtle accessibility bugs.
- *A focus-trap npm package*: a new runtime dependency for behavior the platform provides.

**Risk noted**: `jsdom` does not implement `showModal()`. This is a non-issue here — `apps/web`
has no unit tests (its `vitest` run finds no test files); all web testing is Playwright against
real Chromium.

---

## 4. Icons

**Decision**: A single `Icon` component holding a name → SVG-path map, rendering inline
`<svg>` with `stroke="currentColor"` and `aria-hidden="true"`.

**Rationale**: Satisfies the no-new-dependency constraint and the self-contained requirement
(nothing fetched). `currentColor` means one icon definition works on every button variant without
per-variant assets. `aria-hidden` keeps icons out of the accessibility tree — every icon here
accompanies a visible text label or a labelled control, so exposing them would only add noise.

**Alternatives rejected**: an icon npm package (new dependency); an icon font (network fetch,
poor a11y semantics); individual `.svg` files imported as URLs (extra requests, cannot inherit
`currentColor`).

---

## 5. Canvas dot grid without contaminating exports

**Decision**: Render the dot grid as a CSS `radial-gradient` background on the **container
`<div>` wrapping** the canvas `<svg>` — never as SVG content.

**Rationale**: The constitution forbids exported SVG/PNG from containing anything fetched
externally, and export fidelity requires the export to match the canvas. Anything added *inside*
the `<svg>` would be picked up by the screen renderer's markup and confuse that relationship. A
CSS background on the wrapper is purely presentational, cannot appear in `renderToSvg` output
(a separate code path entirely), and needs no image asset.

---

## 6. The testid and ARIA contract

**Decision**: Treat both the `data-testid` set and the existing ARIA roles as a contract. No
identifier is removed, renamed, or merged; new identifiers are additive only.

**Verified inventory** (108 identifiers, 28 of them dynamic prefixes). Existing roles that must
survive, found by inspection:

| Role | Where | Note |
|---|---|---|
| `alertdialog` | `ConfirmDialog` | **Not** `dialog` — must be preserved explicitly |
| `dialog` | `NewDiagramDialog`, `ImportDialog`, `ShareDialog`, `CreateViaChatDialog` | each with `aria-label` |
| `toolbar` | `Canvas` — "Diagram tools" | tools relocate into the palette rail; the role and its accessible name travel with them |
| `group` | `ExportMenu` — "Export diagram" | |
| `status` | `ViolationsPanel`, `DeletedDiagramsPage` | polite live regions |
| `alert` | 7 error messages | assertive live regions |

**New identifiers introduced**: `rail-tab-dsl`, `rail-tab-chat`, `rail-tab-issues`,
`rail-tab-history`, `doc-bar`, `canvas-surface`.

**New ARIA introduced**: `tablist` / `tab` / `tabpanel` for the secondary rail, with arrow-key
navigation and maintained `aria-selected`; `aria-pressed` on the connect-mode toggle (FR-015).

---

## 7. Verifying contrast by measurement, not judgement

**Decision**: Contrast ratios are computed with the WCAG relative-luminance formula and checked
against thresholds before any color ships. This was already done for the palette: **23/23 pairs
pass**. The check script is retained so the palette can be re-verified if a token changes.

**Rationale**: The accessibility gate asserts *zero* violations, so a palette that fails is a
build failure, not a review comment. Measuring first is far cheaper than discovering it later.
This already paid for itself — the first palette draft had **three** failures (a text token at
4.46 against a 4.5 requirement, and two border tokens below 3:1) that no visual inspection would
reliably have caught.

**Consequence for borders**: WCAG 1.4.11 governs boundaries *required to identify a control*, not
decorative dividers. The tokens are therefore split: `--border-control` (3.59:1) for form control
boundaries, and lower-contrast `--border-default` / `--border-subtle` restricted to decorative
separators. Substituting a decorative border on an input would silently break the gate.

---

## 8. Motion and `prefers-reduced-motion`

**Decision**: All transitions and animations are opt-out via a single global
`@media (prefers-reduced-motion: reduce)` block that reduces durations to near-zero, plus
suppression of the loading-skeleton pulse.

**Rationale**: FR-023, and one global rule covers every animation added anywhere, so it cannot be
forgotten per-component.

**Performance interaction**: the canvas performance gate (>50fps dragging 300 elements) means no
transition, shadow, filter, or blur may be applied to *diagram nodes*. Chrome transitions are
unaffected — nodes are the only elements that re-render during a drag.

---

## 9. Proving diagram rendering and exports are unchanged (SC-004)

**Decision**: Verify by construction plus the existing suite: (a) no file under
`packages/diagram-core/src/render/` is modified — checkable with a diff; (b) the existing
`render-svg`, `round-trip`, and export contract tests pass unchanged.

**Rationale**: The screen renderer (`apps/web/src/canvas/shapes.tsx`) and the export renderer
(`packages/diagram-core/src/render/svg-renderer.ts`) are separate code. This feature touches the
former only, and only for the selection highlight and a hover affordance — neither of which
exists in the export path at all (`#1168bd` appears in `shapes.tsx` and nowhere else; exports
never render selection). Exports are therefore unchanged because the code producing them is
untouched.

**Alternative rejected**: a full-string SVG snapshot test. It would restate what a diff already
proves, and would become a brittle obstacle to legitimate future rendering work.

---

## 10. How admin screens improve without being edited

**Decision**: Admin screens receive no file changes. They inherit `base.css` element styling.

**Rationale**: All five are plain semantic markup — `<table>`, `<input>`, `<select>`,
`<button>`, `<h2>` — so element-level rules restyle them entirely. This is what makes FR-029
nearly free, and it is the direct payoff of choosing global CSS in §1.

**Consequence**: their *layout* stays as-is. That is the accepted scope boundary, not an
oversight.
