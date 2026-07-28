# UI Design Brief — Canvas

**For**: Claude Design (or any designer producing a visual design for this app)
**From**: the engineer who will implement the result
**Status**: Draft for design kickoff
**Last updated**: 2026-07-27

---

## 1. What this document is

Canvas has working functionality and effectively **no visual design**. This brief asks for one.

It is written by the person who has to build the design, so alongside the usual context it
states the **hard constraints** the design must respect to be implementable against this
codebase, and the **specific artifacts** I need back in order to build it without guessing.
Sections 5 and 6 are the ones that will cause rework if skipped.

---

## 2. Product context

Canvas is a **governed diagramming platform for enterprise architects**. It is not a
general-purpose drawing tool — the differentiator is that an organization's admins define
diagramming *standards* (permitted shapes, colors, fonts, icon sets) and the system
machine-validates every diagram against them.

**Users** are four architect personas — Business, Enterprise, Solution, Technical — plus
platform **admins** who curate standards, users, and AI personas. These are professional,
repeat, desk-bound users doing focused work sessions, not casual or mobile visitors.

**Core loop**: open or create a diagram → arrange shapes and connectors on a canvas (by direct
manipulation, by editing Mermaid DSL text, or by asking an AI assistant in natural language) →
see standards violations flagged live → save → export to SVG/PNG.

**Tone**: this should read as a serious professional tool — closer to a technical IDE or an
enterprise admin console than to a consumer creativity app. Dense information, clear hierarchy,
low visual noise, no decorative flourish. Users will stare at it for hours.

---

## 3. Current state (the honest baseline)

There is **no stylesheet in the repository at all** — zero `.css` files. The entire UI is
browser-default rendering: Times New Roman, default blue links, native unstyled form controls,
everything stacked in document order. There are exactly 9 inline `style={{}}` usages in the
whole app, mostly a `display: flex` on the header and the editor's three-column row.

There is **no design system, no component library, no icon set, no color palette, and no
typography scale** to inherit or extend. This is a greenfield visual design over a complete,
working, tested application.

Practically: you are not redesigning something. You are designing it for the first time, and
the markup can be restructured fairly freely **within the constraints in section 5**.

---

## 4. Screens to design

Routing is query-parameter based (`?projectId=…`, `?admin=…`); there is no router library and
no client-side navigation animation to account for.

### 4.1 Global chrome

| Element | Current content |
|---|---|
| App header (`AppShell`) | Wordmark "Canvas", signed-in user's email, Sign Out button. Present on every authenticated screen. |

### 4.2 Primary screens

| Screen | Contents |
|---|---|
| **Login** | Email + password fields, submit, error message. The only unauthenticated screen. |
| **Home / project browser** | Three primary actions — *New Diagram*, *Import Diagram*, *Create via AI Chat* — plus a nested project→diagram tree (each diagram row has Open and Delete), plus admin nav links for admins. |
| **Diagram editor** | The heart of the app. See 4.3. |

### 4.3 Diagram editor (highest-value screen — design this first)

Currently three bare columns side by side, with a pile of controls stacked underneath. It
contains, all on one screen:

- **Shape palette** (left) — searchable icon library results, plus add-shape buttons for
  rectangle / rounded / circle / diamond.
- **Canvas** (center) — an SVG surface with draggable nodes, connectors, group containers,
  inline label editing, selection (single + shift multi-select), a connect mode toggle, group,
  and delete.
- **DSL panel** (right) — a live Mermaid-DSL textarea, bidirectionally synced with the canvas,
  with an Apply button and parse errors.
- **Below the fold**: Save button + save status, Export menu (SVG/PNG), Share, standards
  **violations panel**, **version history**, and the **AI chat panel**.

That "below the fold" list is the main structural problem: these are all co-equal siblings
dumped after the columns. Rationalizing this into a coherent layout (docked panels, tabs, an
inspector rail — your call) is the single biggest design win available.

### 4.4 Dialogs

New Diagram (type picker) · Import Diagram (file or paste) · Create via AI Chat (persona
dropdown grouped by category, name, description) · Share (email, access level, existing grants
list) · Confirm (destructive-action confirmation).

None are true modals today — they replace the content area. Making them real modals is fine and
probably better; see the focus-management requirement in 5.3.

### 4.5 Admin screens

Overview (four stat counters + links) · Standards editor (allowed/mandatory shape checkboxes,
color-palette role+hex rows, draft/publish/retire lifecycle) · Users (role dropdown, active
checkbox per row) · Deleted diagrams (restore) · AI personas (list grouped by category, create
form, archive, plus the global "Enable AI Chat" toggle).

These are dense table/form screens. They matter less aesthetically but need to not look broken.

---

## 5. Hard constraints (non-negotiable)

These come from the project constitution, the automated test suite, and the architecture. A
design that violates them cannot be shipped as-is.

### 5.1 Test identifiers are a contract

The E2E suite (33 Playwright tests across 16 spec files) selects elements almost exclusively via
`data-testid`.
The command below returns 108 entries, of which 28 are dynamic prefixes completed at runtime
(e.g. `node-{id}`, `persona-row-{id}`).

- **Every `data-testid` must survive on an element that behaves equivalently.** Restyling,
  rewrapping, and reordering are fine. Deleting a control, or merging two controls into one, is
  not — unless you explicitly call it out so I can update the corresponding tests.
- Enumerate them yourself with:
  ```bash
  grep -rhoP 'data-testid=\{?[`"]\K[^`"$]*' apps/web/src --include=*.tsx | sort -u
  ```
- Several tests also depend on **semantics**, not just testids — e.g. `role="dialog"` with an
  accessible name, `role="alert"` on errors, `<optgroup>` grouping in the persona dropdown.
  Keep the roles.

### 5.2 Accessibility is a build gate, not an aspiration

`axe-core` runs against **7 screens** in CI at WCAG 2.1 A + AA, and the test asserts
**zero violations**. The constitution independently mandates WCAG 2.1 AA for keyboard
navigation and contrast. This means:

- Every color pair must meet **4.5:1** for normal text, **3:1** for large text and for UI
  component / graphical boundaries. Please state the measured ratio for each token pair — see
  6.2. I will not be able to ship a palette I have to fix after the fact.
- **Visible focus indicators on every interactive element**, meeting 3:1 against adjacent
  colors. Do not remove native outlines without a stronger replacement.
- Color must never be the sole carrier of meaning (violation severity, save status, persona
  status all currently rely on text — keep it that way).
- Every control needs an accessible name; icon-only buttons need visible text or a label.

### 5.3 Keyboard and focus

The canvas already has keyboard affordances (`Delete` removes selection; the canvas root is
focusable). Dialogs must be reachable and dismissible by keyboard. If you convert dialogs to
overlay modals, specify focus-trap and restore-on-close behavior, and an Escape affordance.

### 5.4 The canvas has two renderers that must stay visually consistent

This is the subtlest constraint and the easiest to get wrong.

Diagram elements are drawn **twice by separate code**:

| Renderer | File | Used for |
|---|---|---|
| Screen | `apps/web/src/canvas/shapes.tsx` | The interactive canvas |
| Export | `packages/diagram-core/src/render/svg-renderer.ts` | SVG + PNG export |

The constitution requires exports to faithfully match canvas state, and contract tests enforce
export fidelity. So:

- **Chrome around the canvas** (toolbars, panels, rails, backgrounds) — style freely, screen-only.
- **The diagram elements themselves** (node fills/strokes, connector lines, arrowheads,
  container dashes, label typography) — any change must be specified once and applied to **both**
  renderers. Treat changes here as expensive and justify them.

### 5.5 Diagram element colors are governed data, not design tokens

Node fill/stroke/font come from `node.style`, which is populated from **admin-defined standards**
per diagram type. The design must not hardcode or override diagram element colors. You may
specify the **fallback defaults** used when a standard says nothing (currently `#ffffff` fill,
`#333333` stroke, 14px label) and the **selection highlight** (currently `#1168bd`, 2px).

Corollary: the app chrome palette must look correct sitting next to *arbitrary* admin-chosen
diagram colors. Avoid a chrome accent that fights with common diagram palettes.

### 5.6 Exports must remain self-contained

Exported SVG/PNG must embed **no external network references** — no remote fonts, no linked
images, no `@import`. This is constitution-level and test-enforced. The export renderer already
uses a system font stack:

```
system-ui, -apple-system, "Segoe UI", Roboto, sans-serif
```

If you want a different typeface **for diagram labels**, it must be a system-available stack,
not a webfont. App chrome typography is less constrained but see 5.7.

### 5.7 No new runtime dependencies without justification

Current web runtime deps are exactly: `react`, `react-dom`, `@canvas/diagram-core`. No CSS
framework, no component library, no icon package, no CSS-in-JS runtime.

- Assume I implement with **plain CSS** (a stylesheet plus CSS custom properties for tokens).
  Design accordingly; don't assume Tailwind utility semantics or a specific component library's
  behavior.
- **Icons must be inline SVG** I can paste in, not an icon-font or npm package. If your design
  uses icons, deliver the actual SVG paths.
- Webfonts are discouraged (offline/self-contained bias, and an extra network dependency). If
  one is genuinely important, flag it explicitly with a fallback stack and I'll raise it.

### 5.8 Canvas interaction performance

A perf test asserts the canvas sustains **>50fps while dragging among 300 elements**. Avoid
per-element effects that are expensive during drag — box-shadows, filters, blurs, or
transitions on every node. Hover/transition effects on *chrome* are fine; on *canvas nodes*,
keep them cheap or omit them.

### 5.9 Viewport

Desktop-first, and desktop-only is acceptable. Real users are on large screens with a mouse.
Design for **1440×900 as the primary target**, degrade gracefully to ~1280 wide. Tablet/mobile
layouts are explicitly out of scope (see section 8) — but please don't produce a layout that
*breaks* catastrophically below 1280; graceful is enough.

---

## 6. What I need delivered

The design is only actionable if I can translate it to CSS without inventing values. Please
provide all of the following.

### 6.1 Layout specifications

- Full-screen compositions for: **login**, **home/project browser**, **diagram editor**, and at
  least **one admin screen** (Standards editor is the most complex — good stress test).
- Composition for **one dialog**, establishing the pattern for all five.
- The **diagram editor layout resolved explicitly** — where Save/status, Export, Share,
  violations, version history, and the AI chat panel live relative to palette/canvas/DSL. Include
  what happens when the AI chat panel and DSL panel would both want the same space.
- Stated **grid/spacing system** and how the editor's regions resize when the window does
  (fixed rail widths vs. flexible canvas, min-widths, whether panels are collapsible).

### 6.2 A token table with literal values

A single table I can transcribe into CSS custom properties. Not descriptive names — **actual
values**:

- **Color**: every token as a hex value, with its intended role (surface, surface-raised,
  border, text-primary, text-secondary, accent, focus-ring, danger, success, warning). For every
  foreground/background pairing that occurs in the design, **state the measured contrast ratio**
  and which WCAG threshold it clears.
- **Typography**: font stack(s), and each step as `font-size` / `line-height` / `font-weight`,
  with where each step is used.
- **Spacing**: the scale (e.g. 4/8/12/16/24/32) and which step applies to which relationship.
- **Radius, border widths, and shadows** (if any) as literal values.

### 6.3 Component states

For every interactive component — buttons (primary/secondary/danger), text inputs, textareas,
selects, checkboxes, links, table rows, tabs/panels if introduced — specify **default, hover,
focus-visible, active, and disabled**. Focus-visible is the one most often omitted and it is
gate-blocking here (5.2).

Also specify the **empty, loading, and error** presentation for: the project tree, palette
search results, violations panel, version history, and the AI chat panel. These states all exist
in the app today and currently render as bare text.

### 6.4 Canvas-specific decisions

- Canvas background treatment (flat, grid, dots?) and its color — remembering it sits behind
  arbitrary admin-chosen diagram colors.
- Node **selection** and **hover** treatment, and the connect-mode affordance.
- Whether you are changing the diagram element defaults (fill/stroke/label) — and if so, say so
  loudly, because it costs a coordinated change across both renderers per 5.4.

### 6.5 A change manifest

A short list of any place the design requires **structural markup change or control
add/remove/merge**, so I can assess test impact before building. Restyling needs no manifest
entry; changing what controls exist does.

---

## 7. Open decisions for you (product owner)

I have deliberately not decided these. Defaults I'd recommend are marked.

| # | Decision | Options | My recommendation |
|---|---|---|---|
| 1 | **Scope of first pass** | (a) All screens (b) Global chrome + editor only, admin later | **(b)** — the editor is where users live and where the value is; admin screens can inherit tokens later with little rework. |
| 2 | **Dark mode** | (a) Light only (b) Light + dark | **(a) light only for v1** — dark mode doubles the contrast-verification work against a hard axe gate, and diagram element colors are admin-controlled so a dark canvas can render admin palettes unreadable. Worth doing deliberately later. |
| 3 | **Visual direction** | Neutral/IDE-like · Warm/approachable · High-contrast/dense | **Neutral, IDE-like** — matches the professional-tool positioning in section 2. |
| 4 | **Dialogs** | Keep as content-replacement · Convert to overlay modals | **Convert to modals** — content-replacement loses the user's place; but this adds focus-management work (5.3). |

---

## 8. Explicitly out of scope

- Mobile and tablet layouts.
- Dark mode (unless decision 2 above is overridden).
- Any change to diagram **semantics** — what a shape or connector *means*, the DSL grammar, the
  standards model, or the validation rules.
- Rebranding beyond the "Canvas" wordmark (no logo work requested).
- Marketing / landing / onboarding surfaces — none exist and none are planned here.
- New features. This is a visual design pass over existing functionality; if the design implies a
  new capability, flag it in the change manifest (6.5) rather than assuming it.

---

## 9. Reference

| Thing | Where |
|---|---|
| Frontend source | `apps/web/src/` |
| Canvas screen renderer | `apps/web/src/canvas/shapes.tsx` |
| Canvas export renderer | `packages/diagram-core/src/render/svg-renderer.ts` |
| E2E tests (the testid contract) | `apps/web/tests/e2e/` |
| Accessibility gate | `apps/web/tests/e2e/accessibility.spec.ts` |
| Perf gate | `apps/web/tests/e2e/canvas-performance.spec.ts` |
| Project principles | `.specify/memory/constitution.md` |
| Running it locally | `RUNBOOK.md` |
