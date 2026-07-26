# Implementation Plan: Governed Multi-Persona Diagramming Platform

**Branch**: `001-diagramming-platform` | **Date**: 2026-07-25 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/001-diagramming-platform/spec.md`

## Summary

A single-organization web application where Business, Enterprise, Solution, and Technical
Architects create diagrams on an interactive canvas, backed at all times by an editable Mermaid
DSL as the canonical representation, exportable as Mermaid/SVG/PNG. A shared, versioned diagram
model/parser/validator library is used by both the browser editor and the backend so that
DSL↔visual round-tripping and standards validation behave identically client- and server-side.
Admins define per-diagram-type Standards (allowed shapes/colors/fonts/icon sets) that pre-style
new diagrams and soft-flag violations on save/export. Azure and AWS official icon sets, plus C4,
UML, ERD, and generic flowchart shapes, are ingested as versioned, pluggable icon/shape libraries
rather than hardcoded. Diagrams live in a project/folder hierarchy with version history and
org-internal sharing at view/comment/edit granularity.

## Technical Context

**Language/Version**: TypeScript 5.x end-to-end (Node.js 22 LTS backend, modern evergreen
browsers for the frontend). A single language across frontend, backend, and the shared
diagram-core package lets the DSL parser/serializer/validator be written once and used
identically in the browser (live editing) and on the server (save-time validation, versioned
storage, server-side export) — directly serving Constitution Principle I (round-trip fidelity)
and Principle IV (one set of contract tests covers both call sites).
**Primary Dependencies**:
- Frontend: React, a canvas/graph-editing library for interactive nodes/connectors/containers
  (see research.md for the specific library decision), Mermaid.js (parsing/reference rendering),
  an accessible component primitive library (for WCAG 2.1 AA compliance per the constitution).
- Backend: Fastify (Node.js), the shared `diagram-core` package, a headless SVG→PNG rasterizer
  for server-side export.
- Shared: `diagram-core` — diagram object model, Mermaid DSL parser/serializer, per-diagram-type
  standards validator, icon/shape library contract types.
**Storage**: PostgreSQL for all relational data (Users, Diagrams, Diagram Versions, Diagram
Types, Standards, Projects/Folders, Share Grants); a blob/object store (filesystem volume or
S3-compatible bucket) for icon/shape library SVG assets, keyed by library+version+icon id.
**Testing**: Vitest for unit and contract tests (diagram-core round-trip and validation
contracts are NON-NEGOTIABLE per Constitution IV and must exist and fail before implementation);
Supertest-style HTTP contract tests for the API; Playwright for end-to-end flows (create diagram
→ edit DSL → export SVG/PNG) and for visual/export-fidelity snapshot checks.
**Target Platform**: Linux server (containerized), accessed via modern evergreen desktop
browsers (Chrome, Edge, Firefox, Safari — current and previous major version). No native mobile
app (out of scope per spec).
**Project Type**: Web application (frontend + backend + one shared library package).
**Performance Goals**: Diagram list/search responds within 300ms p95 with 1,000+ diagrams in a
project (SC-007). Canvas interactions (add/move/connect shapes) sustain 60fps up to at least 300
elements on a diagram, degrading gracefully beyond that. Standards validation on save completes
within 500ms for a typical (<200-element) diagram so soft-flag feedback feels immediate.
**Constraints**: Exported SVG/PNG MUST NOT embed telemetry or external network calls
(constitution). Vendor icon usage MUST follow Azure/AWS published trademark/icon-usage terms.
Editor UI MUST meet WCAG 2.1 AA. Single-organization deployment (per spec Clarifications) — no
multi-tenant data isolation is being built now.
**Scale/Scope**: Single organization; on the order of hundreds of users, thousands of diagrams,
tens of admin-defined standards, and two large vendor icon libraries (hundreds of icons each)
plus smaller C4/UML/ERD/generic shape sets.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|---|---|---|
| I. Diagram-as-Data (Source of Truth) | PASS | Shared `diagram-core` parser/serializer is the single implementation of DSL↔model conversion, used by both editor and backend — no second authoritative representation. Grammar-expressiveness risk (can every visual construct, e.g., free-form icon placement, be represented in Mermaid DSL?) is flagged as a Phase 0 research task, not deferred silently. |
| II. Standards Are Enforced, Not Advisory | PASS | Standards are stored as structured, machine-evaluated rule sets and validated by the same `diagram-core` validator client- and server-side; FR-024's soft-flag behavior still requires every violation to be programmatically detected and displayed, not just possible in principle. |
| III. Persona-Appropriate Abstraction | PASS | Diagram Type is a first-class entity carrying persona + abstraction-level metadata that scopes which palette/library entries are offered; enforced in `diagram-core`, not left to UI convention. |
| IV. Test-First for Rendering & Export (NON-NEGOTIABLE) | PASS (process gate) | `diagram-core` contract tests (round-trip, per-type validation, export fidelity) are scheduled as the first tasks for any diagram-type or export work in `/speckit.tasks`, before the corresponding implementation tasks. |
| V. Extensible Symbol Libraries | PASS | Icon/Shape Library is a versioned, metadata-driven entity (category, license/attribution, version, visual asset) ingested through one library-loading path; Azure and AWS are the first two instances of that contract, not special-cased code paths. |
| VI. Simplicity & Incremental Delivery | PASS | Single-organization, monolithic frontend+backend+shared-package structure (no microservices, no plugin runtime, no multi-tenancy) is the simplest structure that satisfies the spec as clarified. No speculative generalization introduced. |

No violations requiring justification; Complexity Tracking is empty.

**Post-Phase 1 re-check** (after research.md, data-model.md, contracts/, quickstart.md): design
artifacts introduce no new principle risk. Notably: the Standard/IconShapeLibrary version-pinning
in data-model.md directly implements Principle V's "no code change to add a library version";
the `diagram-core-contract.md` round-trip/validate invariants directly implement Principles I,
II, and IV as testable properties rather than aspirations. Constitution Check remains PASS.

## Project Structure

### Documentation (this feature)

```text
specs/001-diagramming-platform/
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output (/speckit.plan command)
├── data-model.md        # Phase 1 output (/speckit.plan command)
├── quickstart.md        # Phase 1 output (/speckit.plan command)
├── contracts/           # Phase 1 output (/speckit.plan command)
└── tasks.md             # Phase 2 output (/speckit.tasks command - NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
apps/
├── web/                        # Frontend: editor, palette, admin console, project browser
│   ├── src/
│   │   ├── canvas/             # Interactive diagram canvas (shapes, connectors, containers, DSL sync)
│   │   ├── palette/             # Searchable shape/icon palette (generic, C4, UML, Azure, AWS)
│   │   ├── standards/           # Standards-violation display, template application
│   │   ├── admin/               # Admin console UI (standards, libraries, users/roles)
│   │   ├── projects/            # Project/folder browser, versions, sharing UI
│   │   └── app/                 # Routing, auth, shell
│   └── tests/
│       ├── unit/
│       └── e2e/                 # Playwright: create/edit/export flows per user story
│
└── api/                        # Backend service
    ├── src/
    │   ├── diagrams/            # Diagram CRUD, versioning, import
    │   ├── standards/           # Standard definitions + validation invocation
    │   ├── libraries/           # Icon/shape library ingestion + management
    │   ├── projects/            # Project/folder hierarchy
    │   ├── sharing/             # Share grants, access-level enforcement
    │   ├── admin/               # User/role management
    │   ├── export/              # Server-side SVG/PNG rendering
    │   └── auth/                # Session/OIDC auth
    └── tests/
        ├── contract/            # HTTP API contract tests
        ├── integration/
        └── unit/

packages/
└── diagram-core/                # Shared by apps/web and apps/api
    ├── src/
    │   ├── model/                # Diagram object model (nodes, edges, containers, groups)
    │   ├── dsl/                  # Mermaid DSL parser + serializer (per diagram type family)
    │   ├── standards/            # Rule schema + validator engine
    │   └── libraries/            # Icon/shape library contract types
    └── tests/
        └── contract/             # Round-trip + validation contract tests (Constitution IV)
```

**Structure Decision**: Web application (Option 2) with one addition: a shared `diagram-core`
package consumed by both `apps/web` and `apps/api`. This is not a workaround or premature
abstraction — Constitution Principle I requires exactly one DSL↔model implementation used
identically by the interactive editor and by server-side validation/export, so a second,
independent parser in the backend would itself be a constitution violation (a second source of
truth). Everything else stays a plain two-app monorepo; no microservices, no plugin runtime.

## Complexity Tracking

*No entries — Constitution Check passed with no violations.*
