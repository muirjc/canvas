# Implementation Plan: Editing & Lifecycle Enhancements

**Branch**: `002-editing-lifecycle-enhancements` | **Date**: 2026-07-26 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/002-editing-lifecycle-enhancements/spec.md`

## Summary

Five focused additions to the existing platform (001), all built on its established
architecture with no new services, languages, or infrastructure: a sign-out control wired to
the already-existing session-termination endpoint; connector label editing added alongside the
existing shape-label editing in the canvas; shape (and dangling-connector, and emptied-group)
deletion on the canvas with a confirmation step; diagram soft-delete with an admin-only restore
path within a 30-day retention window; and flowchart-parser extensions so `graph` (alias for
`flowchart`), `style` directives, and `%%` comments import successfully.

## Technical Context

**Language/Version**: TypeScript 5.x, unchanged from 001 — this feature adds to the existing
`packages/diagram-core`, `apps/api`, and `apps/web` workspaces; no new workspace or package.
**Primary Dependencies**: None added. Reuses React, Fastify, the existing session/auth stack,
and `packages/diagram-core`'s existing DSL parser/serializer and model types.
**Storage**: PostgreSQL (existing `canvas`/`canvas_test` databases) — one additive migration for
soft-delete columns on `diagrams`; no new tables.
**Testing**: Vitest (diagram-core, api) and Playwright (web), same as 001 — this feature adds
contract/unit tests for the parser extensions and the delete/restore flows, plus E2E tests for
sign-out, label editing, shape deletion, and diagram delete/restore.
**Target Platform**: Unchanged (Linux server + modern evergreen browsers).
**Project Type**: Web application (unchanged structure — see Project Structure below).
**Performance Goals**: No new performance targets beyond 001's; deletion and label edits are
interactive, low-frequency operations with no distinct budget beyond "feels instant."
**Constraints**: Soft-deleted diagrams MUST behave as not-found for normal access (owner,
collaborators) immediately — no caching or delayed-visibility window. Restoring past the
retention window MUST fail clearly, not silently.
**Scale/Scope**: Same single-organization deployment scale as 001; no new scale dimension.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|---|---|---|
| I. Diagram-as-Data (Source of Truth) | PASS | Label edits and shape/connector deletion are ordinary mutations to the existing `DiagramModel` (nodes/edges/containers arrays), serialized through the same `diagram-core` parser/serializer already governing round-trip fidelity. No second representation introduced. |
| II. Standards Are Enforced, Not Advisory | PASS | Deletions and label edits flow through the existing save path, which already re-validates against the active Standard on every save — no bypass introduced. |
| III. Persona-Appropriate Abstraction | N/A | This feature adds no diagram types and touches no persona-scoping logic. |
| IV. Test-First for Rendering & Export (NON-NEGOTIABLE) | PASS (process gate) | The flowchart parser extensions (`graph` alias, `style` directive, comments) get contract tests before implementation, per `/speckit.tasks`. |
| V. Extensible Symbol Libraries | N/A | Not touched by this feature. |
| VI. Simplicity & Incremental Delivery | PASS | Soft-delete is enforced by a timestamp check at read/restore time — no new job scheduler or queue is introduced to physically purge expired records (see research.md §1). Sign-out reuses the existing endpoint rather than inventing a new one. |

No violations requiring justification; Complexity Tracking is empty.

**Post-Phase 1 re-check**: data-model.md's two new nullable columns and the delete/restore
service functions in contracts/ introduce no new principle risk — confirmed PASS.

## Project Structure

### Documentation (this feature)

```text
specs/002-editing-lifecycle-enhancements/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md         # Phase 1 output
├── quickstart.md         # Phase 1 output
├── contracts/            # Phase 1 output
└── tasks.md              # Phase 2 output (/speckit.tasks — not created by /speckit.plan)
```

### Source Code (repository root — existing structure from 001, extended)

```text
packages/diagram-core/
├── src/dsl/flowchart-parser.ts       # extend: graph alias, style directive, %% comments
├── src/dsl/flowchart-serializer.ts   # unchanged (front-matter styles already round-trip)
├── src/model/diagram-ops.ts          # NEW: pure delete-node(+edges)/delete-edge helpers
└── tests/contract/
    ├── flowchart-graph-alias.test.ts # NEW
    ├── flowchart-style-directive.test.ts # NEW
    └── diagram-ops.test.ts           # NEW

apps/api/
├── migrations/0003_diagram_soft_delete.sql   # NEW
├── src/diagrams/diagram.service.ts           # extend: soft-delete-aware queries, deleteDiagram, restoreDiagram
├── src/diagrams/diagram.routes.ts            # extend: DELETE /diagrams/:id, POST /diagrams/:id/restore, GET /admin/deleted-diagrams
├── src/auth/local.ts or auth routes           # unchanged (logout already exists)
└── tests/contract/
    ├── diagram-delete-restore.test.ts # NEW
    └── (existing diagrams.test.ts extended for soft-delete filtering)

apps/web/
├── src/app/AppShell.tsx              # NEW: persistent header with a Sign Out control
├── src/canvas/Canvas.tsx             # extend: connector label edit, delete key/button + confirm
├── src/canvas/ConfirmDialog.tsx      # NEW: small reusable custom confirmation UI
├── src/projects/ProjectBrowser.tsx   # extend: per-diagram Delete action + confirm
├── src/admin/DeletedDiagramsPage.tsx # NEW: admin-only restore UI
└── tests/e2e/
    ├── sign-out.spec.ts              # NEW
    ├── edit-labels.spec.ts           # NEW
    ├── delete-shapes.spec.ts         # NEW
    └── delete-restore-diagram.spec.ts # NEW
```

**Structure Decision**: No new apps or packages — every change lands inside the three existing
workspaces from 001. This is the simplest structure that satisfies the spec (Constitution VI):
these are additive capabilities on an already-established architecture, not a new subsystem.

## Complexity Tracking

*No entries — Constitution Check passed with no violations.*
