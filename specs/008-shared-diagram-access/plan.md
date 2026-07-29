# Implementation Plan: Reaching a Diagram Shared With You

**Branch**: `008-shared-diagram-access` | **Date**: 2026-07-29 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/008-shared-diagram-access/spec.md`

## Summary

A user granted access to a diagram, but not to its containing project, currently cannot find that
diagram at all — worse, the home screen tells them "you do not have any projects yet" when they
have work waiting. The access control is already correct (`resolveDiagramAccess` already resolves
a diagram-level grant to the right view/comment/edit level); the gap is entirely discovery. This
feature adds one read endpoint (`GET /shared-diagrams`) listing a user's direct diagram-level
grants, and one home-screen section rendering it, reusing the existing diagram-open path
unchanged. Phase 0 found that FR-002, FR-006, and FR-011 all fall out of a single un-clever join —
no new access-resolution logic is needed — and that the seeded E2E fixtures cannot currently
represent the feature's own primary scenario (a user with zero project access), which the test
plan must fix with one new seeded user rather than misusing an existing one.

## Technical Context

**Language/Version**: TypeScript 5.x, Node.js 22 LTS
**Primary Dependencies**: React 18 + Vite (`apps/web`), Fastify (`apps/api`); no new dependency
**Storage**: PostgreSQL — one additive migration, index-only (`share_grants_grantee_idx`); no
column added, no backfill
**Testing**: Vitest (`diagram-core`, `api`; `web` has no unit test suite today), Playwright +
`@axe-core/playwright` (E2E/a11y)
**Target Platform**: Modern evergreen browsers; Linux server for the API
**Project Type**: Web application — React frontend, Fastify backend, shared `diagram-core`
package (untouched by this feature)
**Performance Goals**: No regression. The new query is a single indexed join, not a scan — see the
added index (data-model.md) so it does not become the one "list mine" query in this codebase
without one.
**Constraints**: 144 `data-testid` identifiers are a contract (additions fine, removals/renames
not); WCAG 2.1 AA with zero axe violations; `packages/diagram-core/src/render/` untouched; existing
suite green (154 diagram-core, 112 api, 96 passed / 1 skipped E2E) with no assertion weakened
**Scale/Scope**: Same "tens, not thousands" scale as feature 007's project list — no search, no
paging on the new list either.

## Constitution Check

*GATE: evaluated before Phase 0, re-evaluated after Phase 1.*

| Principle | Assessment |
|---|---|
| **I. Diagram-as-Data** | **Pass, untouched.** No change to DSL, parsing, serialization, or round-tripping. This feature never opens a diagram's content — only its metadata (name, type, project name). |
| **II. Standards Enforced** | **Pass, not engaged.** No standards logic changes. |
| **III. Persona-Appropriate Abstraction** | **Pass, not engaged.** No change to shape palettes or diagram-type behaviour. |
| **IV. Test-First for Rendering & Export (NON-NEGOTIABLE)** | **Pass, not triggered by the letter** — no rendering or export path is touched. Satisfied by spirit: the API contract tests for `GET /shared-diagrams` (quickstart.md §1) and the E2E scenarios (§2) must be written and seen failing before the endpoint/UI exist, same discipline as feature 007 applied to its access-control tests. |
| **V. Extensible Symbol Libraries** | **Pass, not engaged.** |
| **VI. Simplicity & Incremental Delivery** | **Pass** — see Simplicity assessment below. |

**Per-tenant namespacing** (Technology & Compliance Constraints): preserved, not extended. The
feature reads `share_grants` rows that already exist under existing sharing rules; it introduces
no new sharing capability and does not change who can grant or be granted access.

**WCAG 2.1 AA**: the new list is new interactive UI (open buttons per row) and must be
keyboard-operable with zero axe violations (FR-008), added to `accessibility.spec.ts`.

### Simplicity assessment

- **One new endpoint**, self-scoped exactly like `GET /projects` — no search, no paging, matching
  the clarified scale.
- **One new index**, no new table, no new column, no backfill.
- **Zero new access-resolution logic.** Research (§1) found FR-002/FR-006/FR-011 are all
  satisfied by the shape of one join; adding any project-access check or de-duplication pass on
  top would be unrequired complexity, not extra safety.
- **One new frontend component**, a sibling to `ProjectBrowser`, reusing the existing
  `openDiagram` path in `App.tsx` verbatim.

No Complexity Tracking entries are required — nothing here is unjustified complexity. The one
scope item worth being explicit about is test infrastructure, not product code: a third seeded
user is needed so this feature's own primary scenario is actually testable (research.md §5) —
this is fixture debt the feature's own spec creates, not scope creep.

**Post-Phase 1 re-evaluation**: unchanged. Phase 1 added no new dependency, no new workspace, no
new persisted column — only an index and a read-model shaped entirely by an existing query
pattern (`listProjectsForUser`'s ordering, `resolveDiagramAccess`'s access-level precedence).

## Project Structure

### Documentation (this feature)

```text
specs/008-shared-diagram-access/
├── plan.md              # This file
├── research.md          # Phase 0 — 6 decisions, incl. the fixture-gap finding
├── data-model.md        # Phase 1
├── quickstart.md         # Phase 1
├── contracts/            # Phase 1 — API + UI contracts
│   ├── shared-diagrams-api.md
│   └── ui-contract.md
└── tasks.md              # Phase 2 (/speckit.tasks — NOT created here)
```

### Source Code (repository root)

```text
apps/api/migrations/0007_share_grants_grantee_idx.sql   # NEW — index only (0006 is current max)

apps/api/src/
├── sharing/
│   ├── sharing.service.ts    # NEW — listSharedDiagramsForUser()
│   └── sharing.routes.ts     # NEW — GET /shared-diagrams (top-level, not under registerSubjectRoutes)
└── (diagrams/, projects/, users tables — read via join only, no file changes)

apps/web/src/
├── app/
│   ├── App.tsx                        # fetch shared diagrams; new home-screen section, placement per ui-contract.md
│   └── api.ts                         # NEW — SharedDiagramDto, api.listSharedDiagrams()
└── projects/
    └── SharedDiagramsList.tsx         # NEW — sibling to ProjectBrowser.tsx

apps/api/src/seed/run.ts                          # + one new zero-access user (research.md §5)
apps/api/tests/contract/shared-diagrams.test.ts   # NEW
apps/web/tests/e2e/shared-diagrams.spec.ts        # NEW (or added to project-visibility.spec.ts)
apps/web/tests/e2e/accessibility.spec.ts          # + one new audited state
```

**Structure Decision**: The existing three-workspace layout is unchanged — no new package, no new
service. One new backend file pair (service function + route registration, both inside the
existing `sharing/` module since this is fundamentally "list my grants") plus a migration; one new
frontend component alongside `ProjectBrowser.tsx`. `packages/diagram-core/` is not touched at all.

## Complexity Tracking

> No Constitution Check violations. Table intentionally empty.

The judgement call worth recording is, again, the opposite of added complexity: research
considered and rejected layering a project-access check onto the new query (it would look like
extra safety) because FR-006 explicitly requires the unfiltered result, and the join's own shape
already yields the correct answer for FR-002 and FR-011 without it (research.md §1).
