---
description: "Task list for feature implementation"
---

# Tasks: Modern UI Redesign

**Input**: Design documents from `/specs/005-modern-ui-redesign/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/ui-contract.md, quickstart.md

**Tests**: Included and REQUIRED. This feature changes a working, fully-tested product, so its
risk is regression rather than new-capability failure. Every new behavior (rail tabs, modal focus
management, panel states) gets an E2E test written **before** its implementation, and the
existing suite must pass with no assertion or logic changes (SC-003). Two automated gates —
axe-core WCAG 2.1 AA on 7 screens and the 300-element canvas drag threshold — are treated as
build failures, not review comments.

**Organization**: Tasks are grouped by user story (spec.md priorities P1–P4). This is a
frontend-only change confined to `apps/web`. `packages/diagram-core/` and `apps/api/` are not
touched at all, and `apps/web/src/admin/` is deliberately never edited — those five screens
inherit bare-element styling instead (research §10).

**Visual reference**: [`docs/ui-design-spec.md`](../../docs/ui-design-spec.md) holds every literal
value — colors, type scale, spacing, layout dimensions, component states. Tasks below reference
its sections rather than restating values.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no unmet dependencies)
- **[Story]**: Maps to US1–US4 from spec.md
- File paths are relative to the repository root

---

## Phase 1: Setup

- [X] T001 Establish a green baseline before any change: run `npm run test --workspace=@canvas/diagram-core`, `npm run test --workspace=@canvas/api`, and `npx playwright test` in apps/web; record the passing counts (expected 115 / 80 / 33) to compare against at T037
- [X] T002 [P] Add a WCAG contrast verification script at apps/web/scripts/check-contrast.mjs that computes relative-luminance ratios for every token pair in docs/ui-design-spec.md §1.2 and exits non-zero on any failure (makes SC-002 repeatable rather than a one-off)

---

## Phase 2: Foundational (Blocking Prerequisites)

**⚠️ CRITICAL**: Blocks all four user stories — nothing can be styled until the token layer exists
and is loaded.

- [X] T003 Create apps/web/src/styles/tokens.css declaring every design token from docs/ui-design-spec.md §1 as CSS custom properties on `:root` (color, typography, spacing, radius, elevation, layout dimensions)
- [X] T004 Create apps/web/src/styles/base.css with a CSS reset and **bare-element** styling for `body`, headings, `a`, `button`, `input`, `select`, `textarea`, `table`, `fieldset` — element selectors only, no classes, since this is what restyles the five untouched admin screens (FR-029, research §10) (depends on T003)
- [X] T005 Import tokens.css and base.css from apps/web/src/app/main.tsx (depends on T003, T004)
- [X] T006 [P] Create apps/web/src/ui/Icon.tsx — a name-to-inline-SVG map rendering `stroke="currentColor"` with `aria-hidden="true"`, covering the 17 icons listed in docs/ui-design-spec.md §7
- [X] T007 Add a global `@media (prefers-reduced-motion: reduce)` block to apps/web/src/styles/base.css that neutralizes all transition and animation durations, so no later task can introduce unguarded motion (FR-023) (depends on T004)

**Checkpoint**: Stylesheets load and tokens resolve. Admin screens should already look
transformed without any admin file having been edited — verify this before proceeding.

---

## Phase 3: User Story 1 - A credible, consistent interface across the product (Priority: P1) 🎯 MVP

**Goal**: Replace browser-default rendering everywhere with one consistent visual system —
typography, palette, spacing, and control styling — across login, home, and every admin screen.

**Independent Test**: Sign in and visit each screen. No screen renders in browser defaults (serif
body text anywhere means failure); primary buttons are identical across screens; every control
shows a visible keyboard focus indicator; the axe audit still reports zero violations.

### Tests for User Story 1 ⚠️

- [X] T008 [P] [US1] E2E test in apps/web/tests/e2e/ui-foundation.spec.ts asserting the visual foundation is live: computed `font-family` on `body` is the sans stack (not a serif default), a primary button has a non-transparent background, and every focusable control on the login and home screens exposes a visible focus indicator when focused via keyboard

### Implementation for User Story 1

- [X] T009 [US1] Create apps/web/src/styles/components.css with the shared control classes and all five interaction states (rest, hover, focus-visible, active, disabled) per docs/ui-design-spec.md §4.1–4.3: `.btn` variants (primary, secondary, tertiary, danger, tertiary-danger), `.field`, `.card`, `.panel`, `.row`; every form-control border MUST use `--border-control`, never the decorative border tokens (data-model.md validation rule) (depends on T003)
- [X] T010 [US1] Restyle the app header in apps/web/src/app/AppShell.tsx per docs/ui-design-spec.md §2.1, replacing its inline `style` object with classes and adding the wordmark icon; preserve the `sign-out` testid (depends on T009, T006)
- [X] T011 [P] [US1] Restyle the login screen as a centered card in apps/web/src/app/LoginForm.tsx per docs/ui-design-spec.md §3.1; preserve the four login testids and `role="alert"` on the error (depends on T009)
- [X] T012 [US1] Restyle the home screen in apps/web/src/app/App.tsx per docs/ui-design-spec.md §3.2: the three actions as primary/secondary buttons with leading icons, and the admin links as a labelled row; preserve all nine testids (depends on T009, T006)
- [X] T013 [P] [US1] Restyle the project tree as a card with 44px rows in apps/web/src/projects/ProjectBrowser.tsx per docs/ui-design-spec.md §3.2, with always-visible (never hover-only) row actions and Delete as a tertiary-danger button; preserve all four testids (depends on T009)
- [X] T014 [US1] Verify the five screens in apps/web/src/admin/ and apps/web/src/ai/PersonaAdminPage.tsx inherit the visual system correctly **with zero file edits**, and run `npx playwright test tests/e2e/accessibility.spec.ts` to confirm all 7 audited screens still report zero violations (depends on T009)

**Checkpoint**: The whole product looks designed, including screens nobody edited. This is a
shippable slice on its own.

---

## Phase 4: User Story 2 - A focused diagram editing workspace (Priority: P2)

**Goal**: Restructure the editor from three bare columns plus a below-the-fold stack into a
document bar, a grouped palette rail, and a secondary rail whose four panels the architect
switches between.

**Independent Test**: Open a diagram. The canvas is the largest region; name/save/status/export/
share are visible without scrolling; each of the four supporting panels is reachable in one
click; DSL is showing by default; an unsent chat draft survives a tab switch away and back.

### Tests for User Story 2 ⚠️

- [X] T015 [P] [US2] E2E test in apps/web/tests/e2e/ui-editor-rail.spec.ts covering the rail contract from contracts/ui-contract.md §4: DSL is active on every diagram open; exactly one panel is visible at a time; a never-selected panel is absent from the DOM; an unsent chat draft and scroll position survive switching away and back with no refetch; and the violation count is visible on the Issues tab without activating it

### Implementation for User Story 2

- [X] T016 [US2] Create apps/web/src/styles/layout.css with the editor grid, document bar, left and right rail dimensions, and the canvas container per docs/ui-design-spec.md §1.5 and §3.3 (depends on T003)
- [X] T017 [US2] Create the secondary rail component at apps/web/src/ui/RailTabs.tsx implementing `role="tablist"`/`tab`/`tabpanel` with arrow-key navigation, maintained `aria-selected`, and the **lazy-mount-then-keep-alive** strategy from research §2 — a panel mounts on first selection and is thereafter hidden with `display: none` rather than unmounted; add testids `rail-tab-dsl`, `rail-tab-chat`, `rail-tab-issues`, `rail-tab-history` (depends on T009, T016)
- [X] T018 [US2] Restructure apps/web/src/app/DiagramEditor.tsx into the document bar plus palette rail plus secondary rail layout per docs/ui-design-spec.md §3.3: relocate save, save status, export, and share into a `doc-bar` region, mount `RailTabs` with DSL as the initial panel (FR-012), and render the save status as a labelled dot whose meaning is not carried by color alone (FR-006); preserve `save-diagram`, `save-status`, `open-share-dialog` (depends on T017)
- [X] T019 [P] [US2] Group the palette into labelled SHAPES / TOOLS / ICONS sections with a tile grid in apps/web/src/palette/Palette.tsx per docs/ui-design-spec.md §3.3; preserve all four palette testids and the search field's accessible name (depends on T009)
- [X] T020 [US2] In apps/web/src/canvas/Canvas.tsx, wrap the `<svg>` in a `canvas-surface` container carrying the dot-grid CSS background (**never** inside the SVG — research §5), relocate the shape/tool buttons into the palette rail carrying `role="toolbar"` and its "Diagram tools" accessible name with them, and add `aria-pressed` to `connect-mode-toggle` (FR-015); preserve all eleven canvas testids (depends on T016, T019)
- [X] T021 [P] [US2] In apps/web/src/canvas/shapes.tsx, recolor the selection stroke from `#1168bd` to the accent token value and add a hover stroke treatment per docs/ui-design-spec.md §5.3 — **stroke color and width only**: no shadow, filter, blur, or transition on any node, since the drag performance gate depends on it (FR-028)
- [X] T022 [US2] Apply panel chrome (header, padding, scroll behavior, mono type for DSL) to apps/web/src/canvas/DslPanel.tsx, apps/web/src/canvas/ViolationsPanel.tsx, apps/web/src/projects/VersionHistory.tsx, and apps/web/src/ai/ChatPanel.tsx per docs/ui-design-spec.md §3.3, including chat message bubbles and a pinned composer; preserve every testid and the `role="status"` on the violations panel (depends on T017)
- [X] T023 [US2] Surface the outstanding violation count as a badge on the Issues tab in apps/web/src/ui/RailTabs.tsx, fed from the editor's existing validation state in apps/web/src/app/DiagramEditor.tsx (FR-013) (depends on T018, T022)
- [X] T024 [US2] Insert tab activation into the four existing specs identified in the change manifest — apps/web/tests/e2e/ai-edit-diagram.spec.ts (2 lines, inside its existing `getDslPosition` and `sendChatMessage` helpers), apps/web/tests/e2e/ai-chat-history.spec.ts, apps/web/tests/e2e/standards-enforcement.spec.ts, and apps/web/tests/e2e/organize-version.spec.ts — changing **only** navigation, never an assertion or test logic (SC-003) (depends on T018)

**Checkpoint**: The editor is reorganized and the full E2E suite passes again.

---

## Phase 5: User Story 3 - Dialogs that preserve context (Priority: P3)

**Goal**: All five dialogs overlay the current screen instead of replacing it, with correct focus
management.

**Independent Test**: Trigger each dialog. It overlays with prior context visible behind; focus
moves in and cannot Tab out; Escape closes without applying a change; focus returns to the
control that opened it.

### Tests for User Story 3 ⚠️

- [X] T025 [P] [US3] E2E test in apps/web/tests/e2e/ui-modal.spec.ts covering contracts/ui-contract.md §4 items 6–10 for at least two dialogs: the underlying screen stays visible behind a scrim, Tab cycles only within the dialog, Escape closes and applies nothing, focus returns to the invoking control, and React open-state stays in sync when the browser closes the dialog natively

### Implementation for User Story 3

- [X] T026 [US3] Create apps/web/src/ui/Modal.tsx wrapping the native `<dialog>` element: call `showModal()` on open, handle the native `cancel` event so React state stays in sync when Escape closes it, style `::backdrop` as the scrim, and accept a `role` prop so `alertdialog` can be preserved (research §3) (depends on T009)
- [X] T027 [US3] Adopt `Modal` in apps/web/src/app/NewDiagramDialog.tsx and apps/web/src/canvas/ConfirmDialog.tsx — ConfirmDialog MUST explicitly keep `role="alertdialog"`, which `<dialog>` would otherwise silently downgrade to `dialog` (contracts/ui-contract.md §2) (depends on T026)
- [X] T028 [P] [US3] Adopt `Modal` in apps/web/src/projects/ImportDialog.tsx, apps/web/src/projects/ShareDialog.tsx, and apps/web/src/ai/CreateViaChatDialog.tsx, preserving each one's `role="dialog"` and `aria-label` (depends on T026)
- [X] T029 [US3] Style destructive confirmations with the danger button variant and ensure the message names the object being deleted, in apps/web/src/canvas/ConfirmDialog.tsx and its call sites in apps/web/src/canvas/Canvas.tsx and apps/web/src/projects/ProjectBrowser.tsx (FR-018) (depends on T027)

**Checkpoint**: All five dialogs are modal with correct focus behavior; axe still clean.

---

## Phase 6: User Story 4 - Clear feedback in every state (Priority: P4)

**Goal**: Every panel explains itself when empty, working, or failed, instead of rendering a bare
region.

**Independent Test**: Force the empty, loading, and failed conditions for the project tree, icon
search, violations, version history, and chat; each shows a specific, appropriate message.

### Tests for User Story 4 ⚠️

- [X] T030 [P] [US4] E2E test in apps/web/tests/e2e/ui-states.spec.ts asserting a specific empty state for an icon search with no matches, an explicit no-violations state, an empty version history, an empty chat panel, and — with the API unreachable — an error state offering retry rather than a blank region

### Implementation for User Story 4

- [X] T031 [P] [US4] Add empty, loading (skeleton rows), and error-with-retry states to apps/web/src/projects/ProjectBrowser.tsx per docs/ui-design-spec.md §4.4 (depends on T009)
- [X] T032 [P] [US4] Add empty ("no icons match") and loading (skeleton tiles) states to apps/web/src/palette/Palette.tsx per docs/ui-design-spec.md §4.4, preserving the `palette-no-results` testid (depends on T019)
- [X] T033 [P] [US4] Add the empty state to apps/web/src/canvas/ViolationsPanel.tsx (preserving `violations-panel-empty`) and empty/loading/error states to apps/web/src/projects/VersionHistory.tsx per docs/ui-design-spec.md §4.4 (depends on T022)
- [X] T034 [P] [US4] Add the empty prompt, an in-flight assistant indicator, and an error bubble with retry to apps/web/src/ai/ChatPanel.tsx per docs/ui-design-spec.md §4.4, preserving `chat-error` and its `role="alert"` (depends on T022)

**Checkpoint**: All four user stories complete; no unexplained blank regions remain.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [X] T035 [P] Re-run apps/web/scripts/check-contrast.mjs against the shipped values in apps/web/src/styles/tokens.css and confirm every pair still passes (SC-002)
- [X] T036 [P] Confirm `git diff --stat main -- packages/diagram-core/src/render/` is empty and that the diagram-core export tests pass unchanged, proving exports are byte-identical (SC-004)
- [X] T037 Run the full regression suite and confirm counts match the T001 baseline (SC-001, SC-003, SC-005): `npm run test --workspace=@canvas/diagram-core` (packages/diagram-core/tests/, expect 115), `npm run test --workspace=@canvas/api` (apps/api/tests/, expect 80), and in apps/web `npx playwright test` (apps/web/tests/e2e/, expect 33 plus the 4 new spec files) followed by `RUN_PERF_TESTS=1 npx playwright test tests/e2e/canvas-performance.spec.ts`
- [X] T038 Walk specs/005-modern-ui-redesign/quickstart.md end to end at a 1440×900 window, including the admin-defined-color check that confirms configured diagram colors still render truthfully and remain visually dominant (FR-027)

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (Phase 1)**: no dependencies.
- **Foundational (Phase 2)**: depends on Setup — **blocks all four user stories**. Nothing renders
  styled until tokens exist and are imported.
- **User Story 1 (Phase 3)**: depends on Foundational. Delivers `components.css`, which US2, US3,
  and US4 all consume — so unlike features 002–004, the stories here are **not** mutually
  independent. This is inherent to a design-system feature and matches spec.md, which describes
  US1 as "the foundation every other story builds on."
- **User Stories 2, 3, 4 (Phases 4–6)**: each depends on US1, but are largely independent of one
  another and could proceed in parallel by different people. The one coupling: US4's T033/T034
  depend on US2's T022 having established panel chrome.
- **Polish (Phase 7)**: depends on everything.

### Recommended order

Setup → Foundational → US1 → US2 → US3 → US4 → Polish, matching spec.md priorities.

### Parallel opportunities

- **Setup**: T002 is parallel-safe with T001.
- **Foundational**: T006 (Icon) is parallel-safe with the CSS tasks — different file, no shared
  dependency.
- **US1**: T011 (login) and T013 (project browser) are parallel-safe with each other and with
  T012 once T009 lands — three different files.
- **US2**: T019 (palette) and T021 (shapes) are parallel-safe with the DiagramEditor work — all
  different files.
- **US3**: T028 (three dialogs) is parallel-safe with T027 (two dialogs) once `Modal` exists.
- **US4**: T031–T034 are all parallel-safe — four different files.
- **Polish**: T035 and T036 are parallel-safe; T037 and T038 are sequential and last.

---

## Parallel Example: User Story 4

```bash
# Four independent files, once panel chrome (T022) and components.css (T009) are in place:
Task: "Empty/loading/error states in apps/web/src/projects/ProjectBrowser.tsx"
Task: "Empty/loading states in apps/web/src/palette/Palette.tsx"
Task: "Empty states in apps/web/src/canvas/ViolationsPanel.tsx and apps/web/src/projects/VersionHistory.tsx"
Task: "Empty/loading/error states in apps/web/src/ai/ChatPanel.tsx"
```

---

## Implementation Strategy

### MVP scope

**Setup + Foundational + User Story 1** (T001–T014) is a complete, shippable increment. It
carries **zero test risk** — no structural change, so no existing spec file needs editing — and
it improves every screen in the product, including the five admin screens that are never opened
in an editor. If work stopped there, the product would already look designed.

### Where the risk actually is

All of this feature's test impact sits in **one task, T024**, and all of it is navigation-only.
Every other task either adds CSS or restyles markup while preserving identifiers. If T024 grows
beyond the four files and ~7 lines described in the change manifest, something has gone wrong —
most likely a control was removed, merged, or renamed, which contracts/ui-contract.md forbids.

### Gates to watch

- **axe (T014, T037)**: the most likely failure is a decorative border token used on a form
  control — 1.52:1 where 3:1 is required (data-model.md validation rule).
- **Performance (T037)**: the most likely failure is a shadow, filter, or transition applied to
  diagram nodes in T021.
- **Export fidelity (T036)**: should be trivially satisfied, because no task in this list touches
  `packages/diagram-core/`. If that diff is non-empty, a task went out of scope.
