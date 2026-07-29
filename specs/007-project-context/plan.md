# Implementation Plan: Project Context

**Branch**: `007-project-context` | **Date**: 2026-07-29 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/007-project-context/spec.md`

## Summary

The project a user works in exists only in the address bar, where the application reads it but
never writes it — so landing on the root and clicking New Diagram fails, and one hop into the
admin console discards it. This feature gives the project a real home in application state,
seeded from the address and written back, reached through a chooser the code already admits is
missing.

Clarification expanded this past a bug fix: projects gain an **owner**, and the chooser lists only
what the user owns or has been given. Phase 0 found that making that a real property — not a
cosmetic filter — requires closing a pre-existing hole: **no route taking a project id checks
anything beyond "is this user signed in"**, and `getProjectTree` reads every project and every
diagram in the installation with no predicate at all. Enforcement is therefore in scope, and is
the largest single piece of work here.

## Technical Context

**Language/Version**: TypeScript 5.x, Node.js 22 LTS
**Primary Dependencies**: React 18 + Vite (`apps/web`), Fastify (`apps/api`); no new dependency
**Storage**: PostgreSQL — one additive migration (`projects.owner_id`, backfilled)
**Testing**: Vitest (all three workspaces), Playwright + `@axe-core/playwright` (E2E/a11y)
**Target Platform**: Modern evergreen browsers; Linux server for the API
**Project Type**: Web application — React frontend, Fastify backend, shared `diagram-core` package
**Performance Goals**: No regression. `getProjectTree` becomes *cheaper*: it currently loads every
project and diagram in the installation regardless of the requested subtree.
**Constraints**: 108 `data-testid` identifiers are a contract (additions fine, removals/renames
not); WCAG 2.1 AA with zero axe violations; `packages/diagram-core/src/render/` untouched;
existing suite green (154 diagram-core, 95 api, 83 E2E)
**Scale/Scope**: Tens of projects per user (clarified). No search, no paging.

## Constitution Check

*GATE: evaluated before Phase 0, re-evaluated after Phase 1.*

| Principle | Assessment |
|---|---|
| **I. Diagram-as-Data** | **Pass, untouched.** No change to DSL, parsing, serialization, or round-tripping. This feature never opens a diagram's content. |
| **II. Standards Enforced** | **Pass, not engaged.** No standards logic changes. |
| **III. Persona-Appropriate Abstraction** | **Pass, not engaged.** No change to shape palettes or diagram-type behaviour. |
| **IV. Test-First for Rendering & Export (NON-NEGOTIABLE)** | **Pass — and note the direction of travel.** This feature touches no rendering or export path, so the mandate is not triggered by its letter. It is satisfied by its spirit anyway: `project-context.spec.ts` was written first and verified failing 0/3 before any fix. Access-control tests must likewise be written and seen failing before enforcement lands — otherwise a passing test proves only that the endpoint returns *something*. |
| **V. Extensible Symbol Libraries** | **Pass, not engaged.** |
| **VI. Simplicity & Incremental Delivery** | **Pass, with the scope increase stated plainly** — see below. |

**Per-tenant namespacing** (Technology & Compliance Constraints): this feature moves the product
*toward* compliance. The constraint requires that one organization's diagrams not be visible to
another; today any signed-in user can read any project's entire diagram tree by id. Shipping the
chooser without enforcement would have made that hole harder to see while leaving it open.

**WCAG 2.1 AA**: the chooser is new interactive UI and must be keyboard-operable with zero axe
violations (FR-018, SC-007).

### Simplicity assessment

The honest position: **this feature is larger than the bug report**, by the user's explicit
choice during clarification. Three checks that it has not grown beyond that choice:

- **One new column**, not a permissions subsystem. Project *sharing* is already modelled and
  implemented; only ownership was missing.
- **One new endpoint**, deliberately narrow — no search, no paging, per the clarified scale.
- **One access helper**, used by both the middleware and the list endpoint. Two implementations of
  "can this user see this project" would drift, and the drift would be a security bug.

No Complexity Tracking entries are required: nothing here is unjustified complexity. The scope
increase is recorded in the spec's Clarifications and Assumptions, and its cause in `research.md`.

**Post-Phase 1 re-evaluation**: unchanged. Phase 1 added no new dependency, no new workspace, and
no new persistence beyond the single column. The design shrank one thing — the tree query gains a
predicate it should always have had.

## Project Structure

### Documentation (this feature)

```text
specs/007-project-context/
├── plan.md              # This file
├── research.md          # Phase 0 — 8 decisions, incl. the access-control finding
├── data-model.md        # Phase 1
├── quickstart.md        # Phase 1
├── contracts/           # Phase 1 — API + UI contracts
│   ├── projects-api.md
│   └── ui-contract.md
└── tasks.md             # Phase 2 (/speckit.tasks — NOT created here)
```

### Source Code (repository root)

```text
apps/api/migrations/0006_project_owner.sql # NEW — owner_id + backfill (0005 is current max)

apps/api/src/
├── projects/
│   ├── project.routes.ts                  # list endpoint; access guards on :id routes
│   ├── project.service.ts                 # listForUser(); scope getProjectTree
│   └── project.access.ts                  # NEW — the single access rule
├── auth/access-control.middleware.ts      # requireProjectAccess, beside requireDiagramAccess
└── diagrams/
    ├── diagram.routes.ts                  # guard 2 routes (:projectId)
    └── import.routes.ts                   # guard 1 route  (:projectId)

apps/web/src/
├── app/
│   ├── App.tsx                            # current-project state; home nav links
│   ├── project-context.ts                 # NEW — read/write selection, build links
│   └── ProjectPicker.tsx                  # NEW — the chooser
├── ui/AdminShell.tsx                      # admin links preserve context
└── canvas/DiagramEditor.tsx               # expose unsaved-changes state

apps/web/tests/e2e/project-context.spec.ts # EXISTING — fixed input, must not be weakened
```

**Structure Decision**: The existing three-workspace layout is unchanged — no new package, no new
service. Two genuinely new backend files (`project.access.ts`, the migration) and two new frontend
files (`project-context.ts`, `ProjectPicker.tsx`); everything else is an edit to a file that
already exists. `packages/diagram-core/` is not touched at all.

## Complexity Tracking

> No Constitution Check violations. Table intentionally empty.

The one judgement call worth recording is the *opposite* of added complexity: Phase 0 revealed
that the visibility requirement could be met cheaply and falsely (filter the list) or properly
(enforce on the server). The proper route was chosen, and the reasoning is in `research.md` §1.
