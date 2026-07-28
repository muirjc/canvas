# Implementation Plan: Modern UI Redesign

**Branch**: `005-modern-ui-redesign` | **Date**: 2026-07-27 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/005-modern-ui-redesign/spec.md`

## Summary

Give Canvas a visual design. The product currently ships with **no stylesheet at all** — zero
`.css` files, nine inline `style={{}}` usages, browser-default rendering everywhere — so this is
first-time design over a complete, fully-tested application rather than a refresh.

The approach: a global CSS layer (design tokens as custom properties, a reset, bare-element
styling, shared component classes) applied across the product, plus a structural rework of the
diagram editor into a document bar, a grouped palette rail, and a secondary rail whose four
panels the architect switches between. Dialogs become native modals. Every panel gains explicit
empty, loading, and error states.

Two deliberate non-goals shape the work: **diagram element rendering is untouched** (it is
admin-governed and produced by two separate renderers that must agree for exports to match the
canvas), and **admin screens receive no bespoke layout** (they inherit bare-element styling for
free). All visible change comes from the interface around the diagram.

Visual decisions are fully specified in [`docs/ui-design-spec.md`](../../docs/ui-design-spec.md);
the constraints they were designed against are in
[`docs/ui-design-brief.md`](../../docs/ui-design-brief.md).

## Technical Context

**Language/Version**: TypeScript 5.7, React 18.3 (unchanged)
**Primary Dependencies**: **None added.** `react`, `react-dom`, `@canvas/diagram-core` remain the
entire web runtime dependency set. Styling is plain CSS; dialogs use the native `<dialog>`
element; icons are inline SVG.
**Storage**: N/A — no persistence, schema, or API change in this feature
**Testing**: Playwright E2E (33 tests / 16 spec files) including an axe-core WCAG 2.1 AA audit of
7 screens and a canvas drag-performance gate; `apps/web` has no unit tests
**Target Platform**: Desktop browsers. Primary window 1440×900, degrading to ~1280 wide
**Project Type**: Web application — frontend-only change within an existing monorepo
**Performance Goals**: Canvas sustains >50fps while dragging among 300 elements (existing gate,
must not regress)
**Constraints**: Zero WCAG 2.1 A/AA violations (build gate); 108 `data-testid` identifiers and
all existing ARIA roles preserved as a contract; exports must remain self-contained and identical;
no network-fetched fonts or assets
**Scale/Scope**: ~20 components across 8 screens and 5 dialogs; 4 new CSS files; 2 new components

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Verdict | Assessment |
|---|---|---|
| **I. Diagram-as-Data** | **PASS** | No change to the DSL, the model, or parse/serialize. The DSL panel remains bidirectionally synced and is the default secondary panel (FR-012), so the canonical representation stays visible by default rather than being demoted. |
| **II. Standards Are Enforced** | **PASS (strengthened)** | Validation logic untouched. FR-013 surfaces the outstanding violation count without opening a panel, making enforcement *more* visible than today, where violations sit below the fold. |
| **III. Persona-Appropriate Abstraction** | **N/A** | No diagram type, palette scoping, or abstraction level is altered. |
| **IV. Test-First for Rendering & Export** *(NON-NEGOTIABLE)* | **PASS** | No DSL, validation, or export behavior changes; every existing contract test must pass **unchanged**, which is itself the gate. The one canvas-rendering touch is the selection highlight recolor, explicitly permitted by FR-025 and confined to the screen renderer — the export renderer is not modified (see research §9). New behaviors (rail tabs, modal focus, panel states) get E2E tests written before implementation, per this project's established practice. |
| **V. Extensible Symbol Libraries** | **N/A** | No icon or shape library is added, changed, or versioned. Interface icons are unrelated to diagram symbol libraries. |
| **VI. Simplicity & Incremental Delivery** | **PASS** | Four independently deliverable stories; P1 alone is a viable slice that improves every screen. Every technology decision chose the smaller option: no CSS framework, no CSS-in-JS, no CSS Modules, no icon package, and the native `<dialog>` element instead of a hand-rolled focus trap. Zero dependencies added. |

**Technology & Compliance Constraints**

| Constraint | Verdict | Assessment |
|---|---|---|
| WCAG 2.1 AA for keyboard and contrast | **PASS** | Central to the feature (FR-004–FR-008). Palette contrast pre-verified by measurement: 23/23 pairs pass (research §7). |
| Exports free of tracking/external calls | **PASS** | No network-fetched fonts or assets anywhere. The canvas dot grid is deliberately a CSS background on the wrapper `<div>`, never SVG content, so it cannot reach the export path (research §5). |
| Vendor icon usage guidelines | **N/A** | Vendor icon libraries are untouched. |
| Per-tenant data namespacing | **N/A** | No data access changes. |

**Result**: No violations. Complexity Tracking is empty and omitted.

**Post-Phase-1 re-evaluation**: Re-checked after the design below was settled. No verdict
changed. The Phase 1 decisions moved *toward* simplicity — the native `<dialog>` choice removed
roughly 60 lines of hand-rolled focus-trap code, and global bare-element CSS removed the need to
touch the five admin screens at all.

## Project Structure

### Documentation (this feature)

```text
specs/005-modern-ui-redesign/
├── plan.md              # This file
├── research.md          # Phase 0 output — 10 decisions
├── data-model.md        # Phase 1 output — no persisted entities; token + UI-state vocabulary
├── quickstart.md        # Phase 1 output — manual validation
├── contracts/
│   └── ui-contract.md   # Preserved testids/ARIA + new identifiers
├── checklists/
│   └── requirements.md  # Spec quality checklist (16/16)
└── tasks.md             # Phase 2 output (/speckit.tasks — NOT created here)
```

### Source Code (repository root)

```text
apps/web/src/
├── styles/                    # NEW — the whole visual system
│   ├── tokens.css             #   custom properties: color, type, space, radius, elevation
│   ├── base.css               #   reset + bare-element styling (this is what admin screens inherit)
│   ├── components.css         #   .btn variants, .card, .field, .panel, .tabs, .modal, states
│   └── layout.css             #   app shell, editor grid, rails, canvas container
├── ui/                        # NEW — three shared primitives
│   ├── Modal.tsx              #   native <dialog> wrapper: showModal, cancel-event sync, role passthrough
│   ├── RailTabs.tsx           #   tablist semantics + lazy-mount-then-keep-alive panel switching
│   └── Icon.tsx               #   name → inline SVG path map, currentColor, aria-hidden
├── app/
│   ├── main.tsx               # MOD — imports the stylesheets (only change)
│   ├── AppShell.tsx           # MOD — header restyle
│   ├── App.tsx                # MOD — home layout, action buttons, admin nav
│   ├── LoginForm.tsx          # MOD — centered card
│   ├── DiagramEditor.tsx      # MOD — document bar + rails + secondary rail (largest change)
│   └── NewDiagramDialog.tsx   # MOD — adopt Modal
├── canvas/
│   ├── Canvas.tsx             # MOD — canvas container, tools relocate to rail, selection recolor
│   ├── shapes.tsx             # MOD — selection colour + hover stroke ONLY
│   ├── ConfirmDialog.tsx      # MOD — adopt Modal, preserve role="alertdialog"
│   ├── DslPanel.tsx           # MOD — panel chrome, mono type
│   ├── ExportMenu.tsx         # MOD — button styling, preserve role="group"
│   └── ViolationsPanel.tsx    # MOD — panel chrome, empty state
├── palette/Palette.tsx        # MOD — grouped sections, tile grid, empty/loading states
├── projects/
│   ├── ProjectBrowser.tsx     # MOD — card + rows, empty/loading states
│   ├── ImportDialog.tsx       # MOD — adopt Modal
│   ├── ShareDialog.tsx        # MOD — adopt Modal
│   └── VersionHistory.tsx     # MOD — panel chrome, empty/loading states
├── ai/
│   ├── ChatPanel.tsx          # MOD — message bubbles, composer, empty/loading/error states
│   ├── CreateViaChatDialog.tsx# MOD — adopt Modal
│   └── PersonaAdminPage.tsx   # UNCHANGED — inherits tokens
└── admin/                     # UNCHANGED — all five screens inherit tokens (FR-029)

apps/web/tests/e2e/
├── ui-foundation.spec.ts      # NEW — visual system live, focus indicators (US1)
├── ui-editor-rail.spec.ts     # NEW — rail tab contract, keep-alive, violation badge (US2)
├── ui-modal.spec.ts           # NEW — overlay, focus trap, Escape, focus return (US3)
├── ui-states.spec.ts          # NEW — empty/loading/error coverage (US4)
├── ai-edit-diagram.spec.ts    # MOD — 2 lines (tab activation inside 2 existing helpers)
├── ai-chat-history.spec.ts    # MOD — ~3 lines (tab activation)
├── standards-enforcement.spec.ts # MOD — 1 line (tab activation)
└── organize-version.spec.ts   # MOD — 1 line (tab activation)

packages/diagram-core/         # UNCHANGED — export renderer deliberately untouched (SC-004)
apps/api/                      # UNCHANGED — no backend change in this feature
```

**Structure Decision**: Frontend-only change confined to `apps/web`. Two new directories:
`styles/` for the global CSS layer and `ui/` for the two shared primitives (`Modal`, `Icon`) that
several screens need. Everything else is modification in place, which is what keeps the 108
`data-testid` identifiers intact.

Two directories are conspicuously absent from the change list, by design:
`packages/diagram-core/` (touching it would break the export-fidelity guarantee behind SC-004)
and `apps/web/src/admin/` (bare-element styling in `base.css` restyles those screens without
editing them — research §10).
