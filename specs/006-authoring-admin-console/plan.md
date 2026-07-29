# Implementation Plan: Canvas Authoring & Admin Console

**Branch**: `006-authoring-admin-console` | **Date**: 2026-07-28 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/006-authoring-admin-console/spec.md`

## Summary

Five independent improvements, four of them small and one substantial.

The substantial one is **containers**: today a container can only be produced by grouping two or
more existing shapes, is always called "Group", and has no interaction handlers at all — it cannot
be renamed, moved, resized, or have its membership changed. This feature makes it a first-class
object, backed by pure operations in `diagram-core` rather than logic inlined in the canvas
component.

The other four are contained: a shared shell that centres every admin screen and gives it
persistent navigation (fixing a defect the previous feature introduced by scoping admin screens to
"tokens, no layout"), a visible affordance for the label editor that already exists, an additive
migration giving standards a name, description, and retirement date, and a server-side cap plus
search on version history.

Two decisions shape the work: **container appearance is not changed** — containers are drawn by
both the screen and export renderers, so interaction is added without touching styling — and
**creating nesting is deferred**, while imported nested containers must continue to round-trip.

## Technical Context

**Language/Version**: TypeScript 5.7, React 18.3, Node.js 22 (unchanged)
**Primary Dependencies**: **None added.** Plain CSS, native browser APIs, existing workspace
packages
**Storage**: PostgreSQL — one additive migration on `standards` (`name`, `description`,
`retired_at`); no other schema change, and no change to how diagrams are stored
**Testing**: Vitest contract tests (`diagram-core`, `api`), Playwright E2E including an axe-core
WCAG 2.1 AA audit and a canvas drag-performance gate
**Target Platform**: Desktop browsers, primary window 1440×900
**Project Type**: Web application — changes across all three workspaces
**Performance Goals**: Canvas sustains >50fps dragging among 300 elements (existing gate, must not
regress, and must now be exercised **with containers present**)
**Constraints**: 108 `data-testid` identifiers and all ARIA roles preserved; zero WCAG 2.1 A/AA
violations; exports must continue to match the canvas; a container must always carry a size or its
position is silently lost on round-trip
**Scale/Scope**: 7 new `diagram-core` operations, 1 migration, 1 new shared component, ~12
modified files across the three workspaces

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Verdict | Assessment |
|---|---|---|
| **I. Diagram-as-Data** | **PASS, with one guard** | Containers already round-trip: the flowchart serializer emits `subgraph` plus front-matter geometry, and the parser reads both back. New operations are pure model functions, so the DSL stays canonical. **The guard**: the serializer omits any container lacking a `size`, so a size-less container would silently lose its position on save — precisely the loss this principle forbids. research §4 makes an always-present size a hard rule. |
| **II. Standards Are Enforced** | **PASS (strengthened)** | Validation logic is untouched. A name, description, and retirement date make the governance surface legible — an admin currently cannot tell 33 stored standards apart. |
| **III. Persona-Appropriate Abstraction** | **N/A** | No diagram type, palette scoping, or abstraction level changes. Containers are generic organisation, scoped to flowchart. |
| **IV. Test-First for Rendering & Export** *(NON-NEGOTIABLE)* | **APPLIES — enforced** | Containers touch both rendering and export. Contract tests for the seven new `diagram-core` operations, and for container round-trip through the DSL, MUST be written and MUST fail before implementation. Export fidelity for containers (FR-015 / SC-009) is verified by extending the existing export tests to cover container name and membership. |
| **V. Extensible Symbol Libraries** | **N/A** | No icon or shape library is added, changed, or versioned. |
| **VI. Simplicity & Incremental Delivery** | **PASS** | Five independently shippable stories; the P1 slice is a defect fix that stands alone. Zero dependencies added. Nesting deliberately deferred. One addition is justified rather than assumed: server-side version search adds API surface, taken because the client-side alternative leaves the unbounded payload in place and so does not solve the stated problem (research §9). |

**Technology & Compliance Constraints**

| Constraint | Verdict | Assessment |
|---|---|---|
| WCAG 2.1 AA keyboard and contrast | **PASS** | The label affordance is revealed on selection and focus, not hover alone (research §11), and the admin navigation is ordinary links inside a landmark. Both land on screens the axe audit already covers. |
| Exports free of tracking/external calls | **PASS** | No export-path change. Container interaction affordances are screen-only (research §7). |
| Vendor icon usage guidelines | **N/A** | Untouched. |
| Per-tenant data namespacing | **PASS** | The migration adds descriptive columns to an existing per-tenant table; no access-path change. |

**Result**: No violations. Complexity Tracking is empty and omitted.

**Post-Phase-1 re-evaluation**: Re-checked after the design below was settled. No verdict changed.
Phase 1 tightened Principle I rather than relaxing it — the size-always-present rule and the
container round-trip contract test both exist because of it. The single judgement call
(server-side version search) is recorded above with its rationale rather than left implicit.

## Project Structure

### Documentation (this feature)

```text
specs/006-authoring-admin-console/
├── plan.md              # This file
├── research.md          # Phase 0 output — 13 decisions
├── data-model.md        # Phase 1 output — container ops, standards metadata, version query
├── quickstart.md        # Phase 1 output — manual validation
├── contracts/
│   ├── diagram-core-container-ops.md   # the 7 new pure operations
│   └── api-standards-versions.md       # standards metadata + version listing
├── checklists/
│   └── requirements.md  # Spec quality checklist (16/16)
└── tasks.md             # Phase 2 output (/speckit.tasks — NOT created here)
```

### Source Code (repository root)

```text
packages/diagram-core/
├── src/model/diagram-ops.ts            # MOD — 7 container operations (US2)
└── tests/contract/
    ├── diagram-ops.test.ts             # MOD — container operation contract tests
    └── container-round-trip.test.ts    # NEW — container DSL round-trip incl. nested + membership

apps/api/
├── migrations/0005_standard_metadata.sql  # NEW — name, description, retired_at + backfill
├── src/standards/
│   ├── standard.service.ts             # MOD — metadata fields; set retired_at in BOTH retire paths
│   └── standard.routes.ts              # MOD — accept and return name + description
├── src/diagrams/
│   ├── version.service.ts              # MOD — limit + search on the version query
│   └── version.routes.ts               # MOD — optional limit/search params
└── tests/contract/
    ├── standards.test.ts               # MOD — metadata, and retirement date via BOTH paths
    └── versions.test.ts                # MOD — default cap of 5, search reaches older versions

apps/web/
├── src/ui/AdminShell.tsx               # NEW — centred page container + admin navigation (US1)
├── src/app/App.tsx                     # MOD — wrap admin routes in AdminShell
├── src/canvas/
│   ├── Canvas.tsx                      # MOD — container create/drag/resize, drop membership,
│   │                                   #       label affordance, group action relabel (US2, US3)
│   └── shapes.tsx                      # MOD — container selection/handle rendering (screen only)
├── src/admin/StandardsEditor.tsx       # MOD — name/description inputs, dates in the list (US4)
├── src/projects/VersionHistory.tsx     # MOD — capped list + search (US5)
├── src/app/api.ts                      # MOD — standards metadata, version query params
└── tests/e2e/
    ├── containers.spec.ts              # NEW — create/name/move/resize/membership/delete (US2)
    ├── admin-console.spec.ts           # NEW — centred layout + navigation (US1)
    ├── label-affordance.spec.ts        # NEW — discoverable label editing (US3)
    ├── standards-metadata.spec.ts      # NEW — name/description/dates (US4)
    └── version-search.spec.ts          # NEW — cap of 5 + search (US5)

packages/diagram-core/src/render/       # UNCHANGED — container appearance is not modified
apps/web/src/admin/{UsersPage,AdminOverview,DeletedDiagramsPage}.tsx  # UNCHANGED — fixed by AdminShell
```

**Structure Decision**: Changes span all three workspaces, but each user story is confined to a
small set of files. Two exclusions are deliberate and load-bearing.

`packages/diagram-core/src/render/` stays untouched because containers are drawn by both renderers
and this feature adds interaction, not styling — keeping the export path out of scope preserves the
exports-match-canvas guarantee for free.

Three of the five admin screens are never opened: wrapping the admin routes in `AdminShell` at the
routing site in `App.tsx` centres and navigates all of them at once — the same leverage
bare-element CSS gave feature 005.
