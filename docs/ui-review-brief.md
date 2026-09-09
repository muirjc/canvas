# Requirements Brief: Post-005 UI Consistency Review

**Status**: Ready for `/speckit-specify` (one grouping at a time — see §5)
**Created**: 2026-07-31
**Source**: Design-quality audit of everything shipped in `apps/web` since the 005 redesign
(features 004, 006, 007, 008, 009, plus the standalone container/icon/edge/multiline/back-nav
fixes), verified against the locked `docs/ui-design-spec.md` tokens/patterns and against the
running app, not assumed.

---

## 1. Method

`docs/ui-design-spec.md` locked chrome tokens and layout for **global chrome, login, home,
dialogs, and the editor** only (§0.2) — admin screens were explicitly scoped to "inherit tokens,
no bespoke layout." Everything shipped afterward (feature 004's chat/personas, 007's project
chooser, 008's shared-diagrams section, 009's shape toolbar, and the standalone container/icon/
multiline-label/back-nav work) was built by an engineer reusing existing classes as a best guess,
with no design pass of its own. `docs/authoring-and-admin-brief.md` (2026-07-28) already caught
and specified fixes for six items from that gap; this brief checks whether those fixes actually
landed, then looks at everything past that brief's scope.

Verified two ways, per this repo's own house style: (1) direct source inspection with file/line
citations, and (2) a disposable Playwright script driving the real dev server (`localhost:5173`/
`localhost:3000`), logged in as `admin@example.com`, to screenshot actual rendering — home, all
four editor rail tabs, the shape toolbar, a multi-line node label, a real icon-artwork node, and
all five admin screens. The script and its two scratch diagrams were deleted afterward; nothing
here required or left behind a code or database change.

---

## 2. The six authoring-and-admin-brief items: all confirmed fixed

None of these needed re-opening. Listed for completeness since the previous brief's own
recommendation was to verify before assuming.

| # | Item | Verified fix |
|---|---|---|
| 1 | Label-edit discoverability | A pencil-icon affordance now renders on node/edge hover **and** selection/focus (keyboard-reachable, not pointer-only) — `Canvas.tsx:358-375` (`renderEditAffordance`), wired at `Canvas.tsx:762-769` (nodes) and `:689-697` (edges). |
| 2 | Container authoring | Full op set now exists — `addContainer`/`updateContainerLabel`/`moveContainer`/`resizeContainer`/`assignNodeToContainer`/`removeContainer` in `packages/diagram-core/src/model/diagram-ops.ts:137-247` — wired to real "Add Container" toolbar button and a resize handle (`container-resize-*`) in `Canvas.tsx`. |
| 3 | Admin screens pushed flush-left | All five now render inside `AdminShell`'s centered `admin__page` container with persistent nav (`apps/web/src/ui/AdminShell.tsx`) — confirmed on screen for Overview, Standards, Users, Deleted Diagrams, AI Personas. |
| 4 | Version history: last 5 + search | `VersionHistory.tsx:18-19,89-108` — a `version-search` input, a `hasMore`-driven "Showing the N most recent" notice, and per-version `Restore`. |
| 5 | Standard name/description/retirement date | `standard-name-input` / `standard-description-input` fields (`StandardsEditor.tsx:82-100`); history rows show `Created …` and, conditionally, `· Retired …` (`StandardsEditor.tsx:174-183`). |
| 6 | Admin nav on every screen + a way back | `AdminShell`'s nav bar (five links + "Back to diagrams") renders identically on all five destinations. |

---

## 3. New findings from this pass

Ordered roughly by severity. Every row is something I directly reproduced, not inferred.

| # | Area | What exists today | What's wrong |
|---|---|---|---|
| 1 | **AI Personas admin screen** (`apps/web/src/ai/PersonaAdminPage.tsx`) | Entirely unstyled markup — bare `<div>`/`<h3>`/`<ul>`/`<li>`, **zero `className` anywhere in the file** | Visually broken, not just unremarkable: each persona's `<textarea cols={50}>` (an inline-level replaced element with no container/flex layout around it) overlaps the next category's `<h3>` heading and crowds its own `Archive` button. Screenshotted directly — category labels and prompt boxes visibly collide. This is a step below the "flush-left, unremarkable" problem the previous brief fixed for the other four screens; `AdminShell`'s centering wrapper (item 6 above) does wrap this screen, but the *content* inside it was never given even the tokens-only pass the others got. |
| 2 | **Unsaved-changes confirm dialogs** | Two identical instances: `project-switch-confirm` (`App.tsx:351`) and the newly-added `home-nav-confirm` (`App.tsx:375`) | Both are a plain `<div role="alertdialog">` with no `Modal` wrapper — no overlay scrim, no centering, no `--shadow-modal`/`--radius-xl` panel. Renders as raw text pinned to the bottom-left of the viewport, unlike every one of the five real dialogs (which all go through `ui/Modal.tsx` and match `ui-design-spec.md` §3.4 exactly). This isn't a new regression from the back-nav feature — `home-nav-confirm` was written to deliberately mirror the pre-existing `project-switch-confirm`, so it inherited the same gap rather than introducing one. Both need the fix together. |
| 3 | **Deleted Diagrams admin screen** (`DeletedDiagramsPage.tsx`) | Table renders `diagram.ownerId` and `diagram.projectId` directly (`:46-47`) — raw UUIDs, no name resolution | An admin cannot tell whose diagram this was or which project it came from without a separate UUID lookup — the same "can't identify what I'm governing" gap the previous brief flagged for unnamed standards (§1, item 5 there), recurring here. Compounding it: the table has **no cap and no search** — unlike `VersionHistory.tsx`, which got exactly this treatment. The dev DB already has 30+ accumulated rows (mostly test-run debris, confirmed pre-existing and unrelated to this review) with no way to filter them; this will only get worse as an admin's real workload grows. |
| 4 | **Icon palette surfaces the "generic" library's basic-shape aliases** (`Palette.tsx`, `packages/diagram-core/src/libraries/generic.ts`) | Every diagram type's `default_palette_library_ids` includes `generic` (confirmed via DB: `flowchart → {generic}`, `cloud-infrastructure → {generic,azure-icons,aws-icons}`), and `generic`'s five entries (Rectangle, Rounded Rectangle, Circle, Diamond/Decision, Cylinder/Data Store) always appear in icon search results, verbatim-duplicating four of the eleven buttons already in the SHAPES toolbar directly above (screenshotted side by side: `07-left-rail-detail` equivalent). | Worse than mere duplication: `generic`'s `assetRef` values are non-visual sentinels (`shape:rectangle`, `shape:cylinder`, …, `generic.ts:8-12`) with no real SVG behind them. Adding one via the Icon panel produces a `shape: 'icon'` node that resolves to **no artwork at all** — verified by adding "Cylinder / Data Store" to a canvas: it rendered as a bare bordered rectangle with only the text label, no cylinder shape, no icon glyph, indistinguishable from clicking a plain "Rectangle" shape button. `Canvas.tsx:733-739` has nothing to draw because `iconArtwork` never resolves a real SVG for a `shape:*` assetRef. A user searching "storage" gets a real Azure icon *and* this broken-looking impostor side by side with no visual cue which is which until placed. |
| 5 | **Icon node visual treatment** (real icon artwork case) | `DEFAULT_NODE_SIZE` is 140×60 (`shapes.tsx:3`); icon size is `min(width,height) * 0.6 = 36px` (`Canvas.tsx:735`), vertically nudged up 8px, with the label rendered *below* the icon at 12px instead of centered (`Canvas.tsx:740-743`) | Screenshotted with a real Azure icon ("Azure Data Lake Storage Gen1"): the 36px glyph sits inside a much larger, unshrunk 140×60 bordered box clearly built for a text-only rectangle, and the label — often two lines for real icon names, which run long — overflows past the box's bottom edge rather than being contained by it. Reads as unfinished/cramped next to how Azure/AWS diagrams conventionally present icon+caption (no bounding box at all, or a box sized to the content). This is rendering-correctness work (canvas-8n7) that was never given a visual pass, and it's shared by both renderers (`svg-renderer.ts` has the identical geometry per its own code comment), so any fix here is a two-renderer change per the constitution. |
| 6 | **Export control** (`ExportMenu.tsx`) | Three always-visible, unstyled `<button>` elements: "Export MERMAID", "Export SVG", "Export PNG" (no `className` on any of them — they only look acceptable because of the global `button` element reset in `base.css:128-156`) | `ui-design-spec.md` §3.3 specifies a single secondary **"Export ▾"** button with a dropdown caret, holding SVG/PNG (Mermaid export didn't exist when the spec was written, but the pattern generalizes). Today's doc bar instead permanently spends ~3× the width on three flat buttons with no visual grouping beyond a `role="group"` `aria-label` that gives no visible cue. Minor relative to the others, but a clear, easy-to-fix chrome-scope drift. |
| 7 | **Accessibility gate never touches two of the five admin screens** | `accessibility.spec.ts` audits exactly: login, home, editor toolbar, admin **standards**, admin **users**, admin **deleted-diagrams**, the delete-confirm dialog, and home-with-shared-diagrams (`:53-78` for the three admin ones) | Admin **Overview** and admin **AI Personas** are never in the audited set. This is a process gap, not just a visual one: the one admin screen this review found to be actually broken (finding #1) is also the one the axe gate has never once run against, so nothing would have caught it even after a fix regressed. |

### Areas checked and found fine — worth stating explicitly, not just omitting

- **"Back to Diagrams" button and its `icon--flip` CSS trick** (`DiagramEditor.tsx:127-137`, `layout.css:509-512`) — reads correctly at a glance as a left-pointing "back" chevron next to the label; no issue. The flip technique is a reasonable, low-cost way to avoid a new icon asset.
- **Chat panel** (`ChatPanel.tsx`) and **Create-via-AI-Chat dialog** (`CreateViaChatDialog.tsx`) — both fully styled, reuse the same `panel`/`chat-bubble`/`field` classes as the rest of the editor, and match `ui-design-spec.md` §4.4's empty/thinking/error states exactly (sparkle icon + example prompt when empty; three animated dots while sending; danger-toned error bubble with Retry).
- **Shared-diagrams home section** (`SharedDiagramsList.tsx`) — reuses `card`/`row`/`section-label` classes identically to `ProjectBrowser`; no bespoke, inconsistent styling.
- **Project chooser** (`ProjectPicker.tsx`) — renders as a real `<select>` once more than one project exists (confirmed live: multiple pre-existing dev-DB projects triggered the dropdown path, not the single-project text fallback); keyboard-operable native control, no issue.
- **Multi-line labels** (`<br/>` → line break) — confirmed rendering correctly on the live canvas (a two-line node label split into stacked lines as designed).
- **Shape toolbar** (feature 009) — all 11 shapes (4 original + 7 added) render as icon-only 48×48 buttons matching the spec's grid pattern; the only issue is the separate ICONS-section duplication in finding #4 above, not the toolbar itself.

---

## 4. Proposed breakdown

Six independently deliverable stories, ordered by suggested sequence.

| # | Story | Addresses | Why this priority |
|---|---|---|---|
| **US1 (P1)** | Style the AI Personas admin screen | Finding #1 | The one actual visual defect (overlapping elements) in this whole review, on a screen real admins use today to manage who can author diagrams via AI. Smallest-scope, highest-visibility fix. |
| **US2 (P1)** | Give both unsaved-changes confirmations the same `Modal` treatment as every other dialog | Finding #2 | A one-component fix (wrap both in `ui/Modal.tsx`, same as the five existing dialogs) that resolves two instances of the same gap at once. Cheap, and it's the most jarring visual moment in the whole app today — the confirmation prompt for discarding real work. |
| **US3 (P2)** | Resolve owner/project to names and add a cap+search to Deleted Diagrams | Finding #3 | Same governance-identifiability problem the previous brief already fixed for standards; same fix shape (`VersionHistory`'s cap+search pattern) already exists to copy. |
| **US4 (P2)** | Stop the icon palette from offering broken "generic" shape-alias entries | Finding #4 | Either exclude `generic` from diagram types that already carry a real icon library, or give shape-alias entries real, resolvable artwork so they aren't silently worse than the toolbar buttons they duplicate. Needs a product decision (see §6) before a spec can commit to one. |
| **US5 (P3)** | Size icon nodes to their artwork instead of the default text-node box | Finding #5 | Real visual polish, but lower urgency than the broken-looking case in US4 — a real icon *does* render, it's just cramped. Touches both renderers per the constitution, so it's appropriately sequenced after the higher-priority items. |
| **US6 (P4)** | Consolidate Export into a single dropdown; extend the axe gate to Overview and AI Personas | Findings #6, #7 | Bundled because both are small, mechanical, and low-risk — a chrome-only control change plus two added test cases, no product decision required. |

**On the ordering**: US1 and US2 could be swapped freely (both P1, independent, similar size). US4
is the one item here that needs an explicit product decision before implementation — see below.

---

## 5. Out of scope

- Any change to diagram element rendering defaults, the DSL grammar, or standards/validation
  (unaffected by everything in this brief).
- Re-litigating the six items already fixed in §2.
- A full bespoke layout pass for admin screens beyond what's needed for US1/US3 — the previous
  brief's centered-container decision stands; this isn't proposing to revisit it.
- Dark mode, mobile/tablet layouts — both remain explicitly out of scope per `ui-design-spec.md`
  §0.3/§8's precedent.

---

## 6. Open questions

1. **US4's actual fix shape** — three options, not mutually exclusive: (a) drop `generic` from
   `default_palette_library_ids` for diagram types that already have a real icon library (leaves
   `generic` as the sole option only for types like plain `flowchart` that have nothing else);
   (b) give `generic`'s five entries real single-shape SVG artwork so they render like any other
   icon instead of a bare box; (c) visually mark shape-alias results in search (e.g. a distinct
   tile style) so a user isn't fooled before placing one. (a) is cheapest and matches the
   toolbar's existing "shapes are for authoring flowcharts, icons are for everything else"
   intent; (b) is the more principled fix if shape-aliases are meant to keep working through the
   icon path at all diagram types.
2. **US1's scope** — is a full bespoke layout worth designing for AI Personas (cards per persona,
   grouped visually by category), or is the minimum bar just "stop the overlap" (a flex/grid
   wrapper around the existing markup, reusing `card`/`row` primitives already used elsewhere)?
   The latter is far cheaper and would already resolve the actual defect.
3. **Deleted Diagrams' name resolution (US3)** — does `GET /diagrams/deleted` need a join to
   return `ownerName`/`projectName` directly, or is a client-side lookup against already-fetched
   project/user lists acceptable? The former is more correct if a diagram's project or owner can
   itself be deleted/renamed; the latter is cheaper if not.
