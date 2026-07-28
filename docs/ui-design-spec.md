# UI Design Specification — Canvas

**Answers**: [ui-design-brief.md](ui-design-brief.md)
**Status**: Ready for implementation
**Last updated**: 2026-07-27

---

## 0. Locked decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Editor layout | **Top bar + right tabbed rail** |
| 2 | Scope | **Global chrome + login + home + dialogs + editor.** Admin screens inherit tokens only — no bespoke layout this pass. |
| 3 | Theme | **Light only for v1.** All colors authored as CSS custom properties so a dark theme is additive later. |
| 4 | Direction | **Neutral & precise, IDE-like.** Cool grays, one restrained blue, compact spacing, hairline borders, minimal elevation. |

**Design principle for this pass**: the diagram is the only thing on screen allowed to be
colorful. Chrome recedes to cool neutrals so that arbitrary admin-defined diagram palettes
always read as the foreground. Every accent use is functional (state, selection, focus), never
decorative.

---

## 1. Design tokens

Implement as CSS custom properties on `:root` in a single stylesheet. Values are literal and
final — no interpretation required.

### 1.1 Color

| Token | Value | Role |
|---|---|---|
| `--surface-base` | `#F7F8FA` | App background, behind panels |
| `--surface-raised` | `#FFFFFF` | Panels, cards, dialogs, table rows |
| `--surface-sunken` | `#EFF1F4` | Inset areas: DSL editor bg, code, disabled fields |
| `--surface-canvas` | `#FFFFFF` | The diagram drawing surface (see §5.1 — must stay white) |
| `--text-primary` | `#14181F` | Body copy, headings, control labels |
| `--text-secondary` | `#5A6472` | Supporting copy, table meta, placeholder-adjacent labels |
| `--text-tertiary` | `#646D79` | Timestamps, counts, low-emphasis meta |
| `--text-inverse` | `#FFFFFF` | Labels on accent/danger fills |
| `--accent` | `#2563EB` | Primary action, links, selection, focus |
| `--accent-hover` | `#1D4ED8` | Primary hover |
| `--accent-active` | `#1E40AF` | Primary pressed |
| `--accent-subtle` | `#EFF4FF` | Selected row tint, active tab tint, info callout bg |
| `--border-control` | `#7E8896` | **Form control boundaries** — inputs, selects, checkboxes, secondary buttons |
| `--border-default` | `#CBD2DB` | Panel edges, table rules (decorative) |
| `--border-subtle` | `#E3E6EA` | Faint internal dividers (decorative) |
| `--focus-ring` | `#2563EB` | Focus indicator |
| `--danger` | `#C81E1E` | Destructive actions, error text |
| `--success` | `#15803D` | Saved state, "no violations" |
| `--warning` | `#9A5B00` | Standards violations, cautions |
| `--canvas-grid-dot` | `#D8DDE4` | Canvas dot grid (decorative) |

### 1.2 Verified contrast

All pairs computed with the WCAG relative-luminance formula. **23/23 pass.**

| Pair | Ratio | Required | Result |
|---|---|---|---|
| text-primary / surface-base | 16.75 | 4.5 | PASS |
| text-primary / surface-raised | 17.79 | 4.5 | PASS |
| text-primary / surface-sunken | 15.73 | 4.5 | PASS |
| text-secondary / surface-base | 5.65 | 4.5 | PASS |
| text-secondary / surface-raised | 6.00 | 4.5 | PASS |
| text-tertiary / surface-raised | 5.24 | 4.5 | PASS |
| text-tertiary / surface-base | 4.93 | 4.5 | PASS |
| accent / surface-raised | 5.17 | 4.5 | PASS |
| accent / surface-base | 4.86 | 4.5 | PASS |
| text-inverse / accent | 5.17 | 4.5 | PASS |
| text-inverse / accent-hover | 6.70 | 4.5 | PASS |
| accent / accent-subtle | 4.69 | 4.5 | PASS |
| danger / surface-raised | 5.74 | 4.5 | PASS |
| text-inverse / danger | 5.74 | 4.5 | PASS |
| success / surface-raised | 5.02 | 4.5 | PASS |
| warning / surface-raised | 5.43 | 4.5 | PASS |
| border-control / surface-raised | 3.59 | 3 | PASS |
| border-control / surface-base | 3.38 | 3 | PASS |
| focus-ring / surface-raised | 5.17 | 3 | PASS |
| focus-ring / surface-base | 4.86 | 3 | PASS |
| focus-ring / surface-sunken | 4.57 | 3 | PASS |
| node stroke `#333333` / canvas | 12.63 | 3 | PASS |
| node selected `#2563EB` / canvas | 5.17 | 3 | PASS |

**On the decorative borders**: `--border-default` (1.52), `--border-subtle` (1.25), and
`--canvas-grid-dot` (1.37) do **not** clear 3:1 and are not required to. WCAG 1.4.11 governs
boundaries *required to identify a control*. These three are purely decorative separators and
must never be the only thing delineating an interactive control. **Every form control uses
`--border-control` (3.59:1).** This distinction is load-bearing — do not substitute
`--border-default` on an input to soften it.

### 1.3 Typography

```
--font-sans: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
--font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
```

No webfonts — satisfies the self-contained-export constraint and removes a network dependency.
The sans stack intentionally matches the export renderer's existing family so canvas labels and
chrome agree.

| Token | Size / line-height / weight | Used for |
|---|---|---|
| `--text-display` | 24px / 32px / 600 | Login heading, page title |
| `--text-title` | 18px / 26px / 600 | Screen headings, dialog titles |
| `--text-heading` | 15px / 22px / 600 | Panel headers, section headings |
| `--text-body` | 14px / 21px / 400 | Default body, inputs, buttons |
| `--text-body-strong` | 14px / 21px / 500 | Emphasized rows, active tab |
| `--text-small` | 13px / 18px / 400 | Table meta, helper text |
| `--text-caption` | 12px / 16px / 500, `letter-spacing: 0.04em`, uppercase | Rail/section labels ("SHAPES", "ICONS") |
| `--text-mono` | 13px / 20px / 400 | DSL editor, element ids, hex values |

### 1.4 Spacing, radius, elevation

```
--space-1: 4px;   --space-2: 8px;   --space-3: 12px;  --space-4: 16px;
--space-5: 20px;  --space-6: 24px;  --space-8: 32px;  --space-10: 40px;

--radius-sm: 4px;    /* checkboxes, tags, tight controls */
--radius-md: 6px;    /* buttons, inputs, selects */
--radius-lg: 8px;    /* panels, cards */
--radius-xl: 12px;   /* modal dialogs */

--border-width: 1px;

--shadow-sm:    0 1px 2px rgba(20, 24, 31, 0.06);
--shadow-md:    0 4px 12px rgba(20, 24, 31, 0.10);
--shadow-modal: 0 16px 48px rgba(20, 24, 31, 0.18);
--overlay-scrim: rgba(20, 24, 31, 0.45);
```

Spacing intent: `--space-2` within a control, `--space-3` between related controls,
`--space-4` between groups, `--space-6` between sections, `--space-8` between major regions.

### 1.5 Layout dimensions

```
--app-header-h:   48px;   /* global AppShell header */
--doc-bar-h:      52px;   /* editor document bar */
--rail-left-w:   240px;   /* shape/icon palette */
--rail-right-w:  340px;   /* tabbed secondary panel */
--canvas-min-w:  480px;
--app-min-w:    1280px;
```

---

## 2. Global chrome

### 2.1 App header (`AppShell`) — 48px, sticky

```
┌──────────────────────────────────────────────────────────────────────┐
│  ◈ Canvas                                    user@example.com  [Sign out] │
└──────────────────────────────────────────────────────────────────────┘
```

- Background `--surface-raised`, 1px bottom border `--border-default`, `--shadow-sm`.
- Wordmark: `--text-body-strong`, `--text-primary`. The `◈` is an inline SVG diamond glyph in
  `--accent`, 16×16 — the app's only decorative mark. Provided in §7.
- Email `--text-small` / `--text-secondary`, right-aligned, `--space-4` before the button.
- Sign out is a **secondary button** (§4.1), not a bare link.

---

## 3. Screen layouts

### 3.1 Login

Centered card, 400px wide, on `--surface-base`. Vertically centered, offset 8vh above true
center so it sits optically correct.

```
                    ┌────────────────────────────┐
                    │  ◈ Canvas                  │   card:
                    │                            │   - surface-raised
                    │  Sign in                   │   - radius-lg
                    │                            │   - border-default
                    │  Email                     │   - shadow-md
                    │  ┌──────────────────────┐  │   - padding space-8
                    │  │                      │  │
                    │  └──────────────────────┘  │
                    │  Password                  │
                    │  ┌──────────────────────┐  │
                    │  │                      │  │
                    │  └──────────────────────┘  │
                    │  ┌──────────────────────┐  │
                    │  │      Sign in         │  │   full-width primary
                    │  └──────────────────────┘  │
                    │  ⚠ Invalid credentials     │   error, role="alert"
                    └────────────────────────────┘
```

- "Sign in" heading `--text-display`. Field labels `--text-small` / `--text-secondary`,
  `--space-1` above the input.
- Error: `--danger`, `--text-small`, with a `⚠` inline SVG. Keeps `role="alert"`.
- No app header on this screen (user is unauthenticated).

### 3.2 Home / project browser

```
┌──────────────────────────────────────────────────────────────────────┐
│  ◈ Canvas                                  user@example.com [Sign out]│
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│   Diagrams                                                           │
│   ┌────────────────┐ ┌────────────────┐ ┌────────────────┐          │
│   │ ＋ New Diagram │ │ ⤓ Import      │ │ ✦ Create with  │          │
│   │                │ │   Diagram      │ │   AI           │          │
│   └────────────────┘ └────────────────┘ └────────────────┘          │
│     primary            secondary          secondary                  │
│                                                                      │
│   ┌────────────────────────────────────────────────────────────┐    │
│   │ ▾ Smoke Test                                    3 diagrams │    │
│   │   ┌──────────────────────────────────────────────────────┐ │    │
│   │   │ ◈  Order Flow                        Open   Delete  │ │    │
│   │   │ ◈  Untitled Diagram                  Open   Delete  │ │    │
│   │   └──────────────────────────────────────────────────────┘ │    │
│   └────────────────────────────────────────────────────────────┘    │
│                                                                      │
│   Admin ·  Overview   Standards   Users   Deleted   AI Personas      │
└──────────────────────────────────────────────────────────────────────┘
```

- Content column: max-width 1100px, centered, `--space-8` top padding.
- Three action buttons in a row, `--space-3` gap. New Diagram is primary; the other two
  secondary. Each 180px min-width, 40px tall, with a leading inline-SVG icon.
- Project tree: card (`--surface-raised`, `--radius-lg`, `--border-default`). Project header row
  has `--surface-sunken` background, `--text-heading`, a disclosure caret, and a right-aligned
  diagram count in `--text-tertiary`.
- Diagram rows: 44px tall, separated by `--border-subtle`. Hover fills `--accent-subtle`. The
  row title is `--text-body`; actions are right-aligned and appear at full opacity always (not
  hover-only — hover-only actions fail keyboard discoverability).
- **Delete is a tertiary-danger button** (§4.1), not a plain link.
- Admin links: a single row at the bottom, `--text-small`, `--accent`, separated by `·`. Visible
  to admins only, unchanged in behavior.

### 3.3 Diagram editor

The primary screen. Replaces the current three-bare-columns + below-the-fold pile.

```
┌───────────────────────────────────────────────────────────────────────────┐
│  ◈ Canvas                                     user@example.com [Sign out] │  48px
├───────────────────────────────────────────────────────────────────────────┤
│  ◈ Order Flow            ● Saved          [⤒ Export ▾]  [Share]           │  52px  doc bar
├──────────────┬────────────────────────────────────────┬───────────────────┤
│ SHAPES       │                                        │ DSL │Chat│⚠ 2│⟲   │  tab bar 40px
│ ┌──────────┐ │                                        ├───────────────────┤
│ │▭ ▢ ○ ◇  │ │                                        │ flowchart TD      │
│ └──────────┘ │            ·   ·   ·   ·   ·           │   a[Start]        │
│              │                                        │   b{Check}        │
│ TOOLS        │         ┌─────────┐                    │   a --> b         │
│ ┌──────────┐ │         │  Start  │                    │                   │
│ │⇢ Connect │ │         └────┬────┘                    │                   │
│ │⧉ Group   │ │              │                         │                   │
│ │🗑 Delete │ │         ┌────▼────┐                    │                   │
│ └──────────┘ │         │  Check  │                    │                   │
│              │         └─────────┘                    │                   │
│ ICONS        │                                        │                   │
│ ┌──────────┐ │            ·   ·   ·   ·   ·           ├───────────────────┤
│ │🔍 search │ │                                        │      [Apply]      │
│ └──────────┘ │                                        │                   │
│ ▪ ▪ ▪ ▪      │                                        │                   │
├──────────────┴────────────────────────────────────────┴───────────────────┤
│  240px fixed          flexible (min 480px)              340px fixed        │
└───────────────────────────────────────────────────────────────────────────┘
```

**Document bar (52px)** — `--surface-raised`, bottom border `--border-default`.
- Left: diagram name, `--text-title`. Click-to-rename is *not* in scope this pass.
- Center: save status pill — a colored dot + label. `Saved` = `--success`;
  `Saving…` = `--text-secondary`; `Unsaved changes` = `--warning`; `Error` = `--danger`.
  **The Save button sits immediately right of the status**, primary style.
- Right: Export (secondary, with dropdown caret) and Share (secondary), `--space-2` gap.

**Left palette rail (240px fixed)** — `--surface-raised`, right border `--border-default`,
scrolls independently. Three labeled sections using `--text-caption`: SHAPES, TOOLS, ICONS.
- Shape buttons: a 4-across grid of 48×48 icon buttons, each an inline SVG of the actual shape,
  with a tooltip and an accessible name.
- Tools: full-width rows with leading icon + label. **Connect is a toggle** — when active it
  gets `--accent-subtle` background, `--accent` text, and `aria-pressed="true"`.
- Icons: search input, then results as a 4-across grid of 48×48 tiles.

**Canvas (flexible, min 480px)** — see §5.

**Right tabbed rail (340px fixed)** — `--surface-raised`, left border `--border-default`.
- Tab bar 40px: `DSL` · `Chat` · `Issues` · `History`. Issues shows a count badge when
  violations exist (`--warning` fill, `--text-inverse`); History uses a `⟲` glyph.
- **DSL is the default active tab on every editor open.** This is non-negotiable — see §6.
- Active tab: `--text-body-strong`, `--text-primary`, 2px `--accent` bottom border. Inactive:
  `--text-secondary`, no border.
- Tabs are a real tablist: `role="tablist"` / `role="tab"` / `role="tabpanel"`, arrow-key
  navigable, `aria-selected` maintained.

**Rail panel contents**
- *DSL*: `--font-mono` textarea on `--surface-sunken`, filling the panel; a footer strip with a
  right-aligned Apply (primary, small). Parse errors render above the footer in `--danger`.
- *Chat*: scrollable message list; user messages right-aligned with `--accent-subtle` bubbles,
  assistant left-aligned with `--surface-sunken` bubbles, both `--radius-md`; composer pinned to
  the bottom (textarea + Send).
- *Issues*: list of violations, each with a `⚠` in `--warning`, the element id in `--font-mono`,
  the rule name in `--text-caption`, and the message in `--text-small`. Empty state per §4.4.
- *History*: version rows — sequence number, timestamp `--text-tertiary`, Restore button.

**Resize behavior**: both rails are fixed width; the canvas absorbs all change. Below 1280px the
window scrolls horizontally rather than collapsing rails — desktop-only is an accepted
constraint (brief §5.9).

### 3.4 Dialog pattern

All five dialogs become true overlay modals.

```
        ╔══════════════════════════════════════╗
        ║  New Diagram                      ✕  ║   header: text-title,
        ╠══════════════════════════════════════╣   border-bottom subtle
        ║                                      ║
        ║  Diagram type                        ║   body: padding space-6
        ║  ◉ Flowchart                         ║
        ║  ○ Sequence                          ║
        ║  ○ ER Diagram                        ║
        ║                                      ║
        ╠══════════════════════════════════════╣
        ║               [Cancel]  [Create]     ║   footer: right-aligned,
        ╚══════════════════════════════════════╝   border-top subtle
```

- Scrim `--overlay-scrim` over the full viewport; panel `--surface-raised`, `--radius-xl`,
  `--shadow-modal`, width 440px (Share and Import 560px), max-height 80vh with the body
  scrolling.
- Keeps `role="dialog"`, `aria-modal="true"`, and its accessible name.
- **Focus management** (required by brief §5.3): on open, focus the first interactive element;
  trap Tab within the dialog; `Escape` closes; on close, restore focus to the trigger.
- Footer: Cancel secondary, confirm primary (or danger for destructive), right-aligned,
  `--space-2` gap. Destructive confirms use the danger button and name the object.

### 3.5 Admin screens (tokens only)

Per decision 2, admin screens get **no bespoke layout**. They inherit the reset, typography,
color, button, input, and table-row styles automatically. Expected result: legible, consistent,
unremarkable. Bespoke admin layouts are a follow-up.

---

## 4. Components

### 4.1 Buttons

Height 36px (compact variant 28px), padding `0 --space-4`, `--radius-md`, `--text-body`
weight 500, inline-flex, `--space-2` gap for a leading icon.

| Variant | Default | Hover | Active | Disabled |
|---|---|---|---|---|
| **Primary** | bg `--accent`, text `--text-inverse`, no border | bg `--accent-hover` | bg `--accent-active` | bg `--accent`, opacity .45, `cursor: not-allowed` |
| **Secondary** | bg `--surface-raised`, text `--text-primary`, 1px `--border-control` | bg `--surface-sunken` | bg `#E4E7EC` | opacity .45 |
| **Tertiary** | transparent, text `--accent`, no border | bg `--accent-subtle` | bg `#E2EBFE` | opacity .45 |
| **Danger** | bg `--danger`, text `--text-inverse` | `#B01818` | `#991414` | opacity .45 |
| **Tertiary-danger** | transparent, text `--danger` | bg `#FDECEC` | bg `#FBDCDC` | opacity .45 |

**Focus-visible (all variants)**: `outline: 2px solid var(--focus-ring); outline-offset: 2px`.
Never remove it. Disabled buttons keep `aria-disabled` and remain focusable where the control
communicates *why* it is disabled.

### 4.2 Text inputs, textareas, selects

- Height 36px (textarea auto), padding `0 --space-3`, `--radius-md`, 1px `--border-control`,
  bg `--surface-raised`, `--text-body` / `--text-primary`.
- Placeholder `--text-tertiary` (4.93:1 — passes; do not lighten).
- **Hover**: border `#6B7480`. **Focus-visible**: border `--accent` + `outline: 2px solid
  var(--focus-ring); outline-offset: 1px`.
- **Disabled**: bg `--surface-sunken`, text `--text-tertiary`, border `--border-default`.
- **Invalid**: border `--danger`, `aria-invalid="true"`, message below in `--danger`
  `--text-small`.
- Selects use a custom inline-SVG caret; keep the native `<select>` element and its `<optgroup>`
  structure (a test depends on the grouping).

### 4.3 Checkboxes, radios, links, tabs, rows

- **Checkbox/radio**: 16×16, 1px `--border-control`, `--radius-sm` (radios full round).
  Checked: `--accent` fill with a white inline-SVG check/dot. Focus-visible ring as above.
  Label `--text-body`, clickable, `--space-2` gap.
- **Link**: `--accent`, no underline at rest, underline on hover, focus ring on focus-visible.
- **Tab**: see §3.3. Focus-visible ring inset 2px.
- **Table/list row**: 44px, `--border-subtle` separators. Hover `--accent-subtle`. Selected
  `--accent-subtle` + 2px `--accent` left border. Focus-visible ring inset.

### 4.4 Empty, loading, and error states

Every one of these exists in the app today and currently renders as bare text.

| Surface | Empty | Loading | Error |
|---|---|---|---|
| Project tree | Centered `--text-secondary` "No diagrams yet" + a primary New Diagram button | 3 skeleton rows, `--surface-sunken`, subtle pulse | `--danger` message + Retry (tertiary) |
| Palette icon search | "No icons match *term*" `--text-secondary`, centered | 8 skeleton tiles | inline `--danger` text |
| Issues tab | `✓` in `--success` + "No standards violations" | — | — |
| History tab | "No saved versions yet" `--text-secondary` | 3 skeleton rows | `--danger` + Retry |
| Chat tab | `✦` + "Describe a change to this diagram" + one example prompt, all `--text-secondary` | assistant bubble with 3 animated dots | error bubble, `--danger` text on `#FDECEC`, with Retry |

Skeleton pulse: `opacity .6 → 1`, 1.4s ease-in-out. Respect
`@media (prefers-reduced-motion: reduce)` — disable pulse and all transitions.

---

## 5. Canvas

### 5.1 Surface

- Background stays `#FFFFFF`. **Not tinted.** Admin-defined node fills are frequently pale, and
  a tinted canvas destroys their contrast. This also keeps screen and export visually identical.
- A **dot grid** overlay: 1px dots, `--canvas-grid-dot`, on a 16px lattice, rendered as a CSS
  `radial-gradient` background on the canvas *container* — **not** inside the `<svg>`. Keeping
  it out of the SVG is what stops it leaking into exports.
- The canvas container gets a 1px `--border-default` inset edge so the drawing surface reads as
  a distinct plane against `--surface-base`.

### 5.2 Node and connector treatment — unchanged defaults

**No change to diagram element rendering defaults.** Fill `#ffffff`, stroke `#333333`, label
14px, connector `#333333` with the existing arrowhead, container dashed `#888888` all stay
exactly as they are.

This is deliberate: the brief (§5.4) flags that every such change costs a coordinated edit
across *two* renderers plus export-fidelity test updates, and (§5.5) that these are
admin-governed anyway. Spending the budget there buys nothing a user notices. **The visible
transformation comes entirely from the chrome.**

### 5.3 Selection, hover, connect mode

| State | Treatment |
|---|---|
| Hover (screen only) | stroke `--accent`, `stroke-width: 1.5` |
| Selected | stroke `--accent`, `stroke-width: 2` (current behavior; recolored `#1168bd` → `#2563EB` for palette consistency, 5.17:1 on canvas) |
| Multi-select | identical per node — no additional bounding box |
| Connect mode armed | canvas `cursor: crosshair`; the Connect tool shows its active toggle state |
| Connect source chosen | source node stroke `--accent`, `stroke-dasharray: 4 2` |

**Performance (brief §5.8)**: these are stroke-color and stroke-width changes only. No
box-shadow, filter, blur, or transition on any node — nothing that would jeopardize the >50fps
drag gate at 300 elements. Hover is a screen-only affordance and must not be written into the
model or the export.

---

## 6. Change manifest

Per brief §6.5 — every structural change, with its test impact. I verified each claim by
grepping the E2E suite.

### 6.1 Structural changes

| # | Change | Testid impact |
|---|---|---|
| 1 | `AppShell` header restyled | None. `sign-out` preserved. |
| 2 | Home actions become styled buttons; project tree becomes a card | None. `new-diagram`, `import-diagram-button`, `create-via-ai-chat`, `project-browser`, `project-node-*`, `open-diagram-*`, `delete-diagram-*` all preserved. |
| 3 | Editor: Save/status/Export/Share move into a document bar | None. `save-diagram`, `save-status`, `export-*`, `open-share-dialog` all preserved, just relocated. |
| 4 | **Editor: DSL, Chat, Issues, History become a tabbed rail** | **Real impact — see 6.2.** Only the active tab's panel is mounted. |
| 5 | Canvas gains a container with a dot-grid background | None. `diagram-canvas`, `canvas-root`, `node-*`, `edge-*`, `container-*` unchanged. |
| 6 | Dialogs become overlay modals with focus trap | None. All dialog testids and `role="dialog"` preserved. |
| 7 | Palette groups into labeled sections | None. `add-shape-*`, `palette-search`, `palette-results`, `palette-icon-*`, `connect-mode-toggle`, `group-selected`, `delete-selected` preserved. |
| 8 | New stylesheet + CSS custom properties; `index.html` gains nothing external | None. |

**No control is removed, merged, or renamed anywhere in this design.**

### 6.2 The real test impact

A tabbed rail means only the active panel is mounted. Measured by classifying **every** spec
file by which rail panel it touches:

| Panel touched | Spec files | Consequence |
|---|---|---|
| **DSL only** | 7 — `ai-create-diagram`, `canvas-performance`, `create-export`, `delete-shapes`, `edit-labels`, `import`, `persona-diagram-types` | **Zero** — DSL is the default active tab |
| **Chat only** | 1 — `ai-chat-history` | Needs tab activation |
| **Issues only** | 1 — `standards-enforcement` | Needs tab activation |
| **History only** | 1 — `organize-version` | Needs tab activation |
| **DSL *and* Chat, interleaved** | 1 — `ai-edit-diagram` | See the conflict below |
| No rail panel | 5 | Zero |

(16 spec files, 33 tests in total.)

Making DSL the default tab is what keeps the largest group (7 files) untouched.

**The one genuine design conflict.** `ai-edit-diagram.spec.ts` alternates ~8 times between
reading the DSL panel (to assert node positions survived) and sending chat messages. A tabbed
rail makes DSL and Chat mutually exclusive, so that workflow — *and any user who wants to watch
the DSL update as they chat* — cannot see both at once. This is a genuine ergonomic cost of the
tabbed layout, not merely a test artifact, and it is worth knowing about.

It is cheap to absorb in the tests because that spec already funnels **all** DSL reads through
one `getDslPosition()` helper and **all** chat sends through one `sendChatMessage()` helper — so
it is 2 inserted lines, not 16. Total suite impact:

| File | Insertions |
|---|---|
| `ai-edit-diagram.spec.ts` | 2 (one inside each existing helper) |
| `ai-chat-history.spec.ts` | ~3 |
| `standards-enforcement.spec.ts` | 1 |
| `organize-version.spec.ts` | 1 |

**4 files, ~7 lines.** No test logic or assertion changes — only tab activation.

If the ergonomic cost proves unwelcome in use, the smallest fix that preserves this layout is to
let the rail split vertically so DSL and Chat can be pinned open together; that is a additive
change and does not invalidate anything else in this spec.

New testids introduced: `rail-tab-dsl`, `rail-tab-chat`, `rail-tab-issues`,
`rail-tab-history`, `doc-bar`, `canvas-surface`.

### 6.3 Accessibility work this creates

- Focus-visible styles for every control (§4) — required by the axe gate.
- Tablist keyboard semantics for the rail.
- Focus trap, Escape handling, and focus restore for modals.
- Re-run `accessibility.spec.ts` (7 screens, zero violations) after implementation. The palette
  is pre-verified (§1.2), so failures should be structural, not chromatic.

### 6.4 Explicitly not changing

Diagram element rendering defaults, both renderers, the DSL grammar, standards/validation, the
export pipeline, admin screen layouts, and every route.

---

## 7. Assets

Icons are inline SVG, 16×16, `stroke="currentColor"`, `stroke-width="1.5"`, `fill="none"`,
`stroke-linecap="round"`, so they inherit color from their button variant. Required set:

`diamond` (wordmark) · `plus` (New) · `download` (Import) · `sparkle` (AI) · `upload` (Export) ·
`share` · `search` · `trash` · `arrow-right` (Connect) · `group` · `chevron-down` ·
`chevron-right` · `close` · `check` · `warning` · `history` · `send`

Wordmark glyph:

```svg
<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
  <path d="M8 1.5 14.5 8 8 14.5 1.5 8Z" fill="currentColor"/>
</svg>
```

Every icon is decorative and paired with a text label or an `aria-label`; all get
`aria-hidden="true"`.

---

## 8. Implementation order

1. **Foundation** — stylesheet with tokens, CSS reset, base typography, `AppShell`. Verify no
   axe regression.
2. **Components** — buttons, inputs, selects, checkboxes, rows, dialogs (incl. focus trap).
   Admin screens visibly improve here for free.
3. **Login + home** — the two simplest full layouts.
4. **Editor** — document bar, palette rail, canvas container, tabbed rail. Largest step; do the
   3 test insertions from §6.2 with it.
5. **States** — empty/loading/error across the five surfaces in §4.4.
6. **Verify** — full suite: 115 diagram-core, 80 API, 33 E2E tests (16 files), including the
   axe and perf gates.

Steps 1–3 are independently shippable and carry no test risk.
