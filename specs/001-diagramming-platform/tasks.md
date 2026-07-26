---
description: "Task list for feature implementation"
---

# Tasks: Governed Multi-Persona Diagramming Platform

**Input**: Design documents from `/specs/001-diagramming-platform/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Included and REQUIRED, not optional. Constitution Principle IV ("Test-First for
Rendering & Export") is NON-NEGOTIABLE: `diagram-core` round-trip/validation contract tests and
API contract tests MUST be written and MUST fail before their corresponding implementation task.

**Organization**: Tasks are grouped by user story (spec.md priorities P1–P6) so each story is
independently implementable, testable, and deployable.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no unmet dependencies)
- **[Story]**: Maps the task to US1–US6 from spec.md
- File paths follow the monorepo layout in plan.md: `apps/web/`, `apps/api/`, `packages/diagram-core/`

---

## Phase 1: Setup (Shared Infrastructure)

- [X] T001 Create monorepo skeleton (`apps/web`, `apps/api`, `packages/diagram-core`) with npm workspaces (`workspaces` field in root package.json — pnpm was unavailable in the dev environment, npm workspaces is an equivalent, dependency-free substitute)
- [X] T002 Initialize `packages/diagram-core` TypeScript project (package.json, tsconfig.json, Vitest config) in packages/diagram-core/
- [X] T003 [P] Initialize `apps/api` Fastify + TypeScript project (package.json, tsconfig.json) in apps/api/
- [X] T004 [P] Initialize `apps/web` React + TypeScript project (Vite) in apps/web/
- [X] T005 [P] Configure shared ESLint + Prettier config for the workspace in .eslintrc.cjs and .prettierrc
- [X] T006 Configure Docker Compose for local PostgreSQL in docker-compose.yml

---

## Phase 2: Foundational (Blocking Prerequisites)

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T007 Setup PostgreSQL migrations framework in apps/api/migrations/
- [X] T008 [P] Write base schema migration (users, projects, diagrams, diagram_versions, diagram_types, standards, icon_libraries, icons, share_grants, templates) in apps/api/migrations/0001_init.sql
- [X] T009 [P] Implement OIDC-based session auth framework in apps/api/src/auth/
- [X] T010 [P] Setup API app shell: routing, error-handling middleware, request logging in apps/api/src/app.ts
- [X] T011 Implement base DiagramModel types (Node, Edge, Container, Group, DiagramModel) shared by every DSL family in packages/diagram-core/src/model/diagram-model.ts
- [X] T012 [P] Implement `loadLibrary()` and IconShapeLibrary/Icon types (the pluggable-library contract, Constitution V) in packages/diagram-core/src/libraries/library-loader.ts
- [X] T013 [P] Configure environment/config management (.env schemas) for apps/api and apps/web in apps/api/src/config.ts and apps/web/src/config.ts

**Checkpoint**: Foundation ready — user story phases can now begin.

---

## Phase 3: User Story 1 - Create and Export a Diagram (Priority: P1) 🎯 MVP

**Goal**: An architect creates a diagram on a visual canvas, sees it stay in sync with Mermaid
DSL in both directions, and exports Mermaid/SVG/PNG.

**Independent Test**: Create a diagram with three shapes and two connectors purely via canvas,
verify generated DSL, edit DSL directly and verify canvas updates, export SVG/PNG/Mermaid and
verify they match the canvas.

### Tests for User Story 1 ⚠️ (write first; must fail before implementation)

- [X] T014 [P] [US1] Contract test: `parse(serialize(model))` round-trip equality for the flowchart DSL family in packages/diagram-core/tests/contract/round-trip.test.ts
- [X] T015 [P] [US1] Contract test: `parse()` never throws and returns structured `ParseError[]` for malformed/unsupported input in packages/diagram-core/tests/contract/parse-errors.test.ts
- [X] T016 [P] [US1] Contract test: `renderToSvg()` output is self-contained (no external network/font references) in packages/diagram-core/tests/contract/render-svg.test.ts
- [X] T017 [P] [US1] API contract test: POST/GET/PATCH `/diagrams` and `/diagrams/:id/export` per contracts/api-diagrams.md in apps/api/tests/contract/diagrams.test.ts
- [X] T018 [P] [US1] E2E test: create → edit DSL → export Mermaid/SVG/PNG flow in apps/web/tests/e2e/create-export.spec.ts

### Implementation for User Story 1

- [X] T019 [US1] Implement flowchart DSL parser (Mermaid flowchart text → DiagramModel) in packages/diagram-core/src/dsl/flowchart-parser.ts (depends on T011)
- [X] T020 [US1] Implement flowchart DSL serializer (DiagramModel → Mermaid flowchart text + front-matter metadata per research.md §1) in packages/diagram-core/src/dsl/flowchart-serializer.ts (depends on T011)
- [X] T021 [US1] Implement `renderToSvg()` for DiagramModel in packages/diagram-core/src/render/svg-renderer.ts (depends on T011)
- [X] T022 [US1] Implement interactive canvas (add/move/connect/group shapes, text labels, containers) in apps/web/src/canvas/Canvas.tsx
- [X] T023 [US1] Implement bidirectional DSL↔canvas sync hook in apps/web/src/canvas/useDslSync.ts (depends on T019, T020, T022)
- [X] T024 [US1] Implement editable Mermaid DSL text panel in apps/web/src/canvas/DslPanel.tsx (depends on T023)
- [X] T025 [US1] Implement Diagram CRUD service (create/get/save-creates-version) in apps/api/src/diagrams/diagram.service.ts (depends on T007, T008)
- [X] T026 [US1] Implement POST/GET/PATCH `/diagrams` routes in apps/api/src/diagrams/diagram.routes.ts (depends on T025)
- [X] T027 [US1] Implement append-only DiagramVersion creation on save in apps/api/src/diagrams/version.service.ts (depends on T025)
- [X] T028 [US1] Implement server-side SVG/PNG export endpoint (`GET /diagrams/:id/export`) using `renderToSvg` + headless rasterization for PNG (research.md §4) in apps/api/src/export/export.service.ts and apps/api/src/export/export.routes.ts (depends on T021)
- [X] T029 [US1] Implement client export menu (download Mermaid/SVG/PNG) in apps/web/src/canvas/ExportMenu.tsx (depends on T028)
- [X] T030 [US1] Surface unsupported-element errors from `ParseError`/serialize failures in the UI instead of silently dropping content in apps/web/src/canvas/UnsupportedElementNotice.tsx (depends on T015, T023)

**Checkpoint**: User Story 1 is fully functional and independently testable/deployable.

---

## Phase 4: User Story 2 - Admin Defines and Enforces Diagramming Standards (Priority: P2)

**Goal**: Admins define per-diagram-type Standards; diagrams are pre-styled per the active
Standard and soft-flagged with specific violations when they deviate.

**Independent Test**: Publish a Standard for one diagram type, create a violating diagram of
that type, confirm specific violations are surfaced (not a generic pass/fail) and the save is
not blocked.

### Tests for User Story 2 ⚠️

- [X] T031 [P] [US2] Contract test: `validate(model, standard)` returns correct `Violation[]` for known rule violations (shape/color/icon/font) in packages/diagram-core/tests/contract/validate.test.ts
- [X] T032 [P] [US2] API contract test: Standard create/publish/retire lifecycle per contracts/api-standards-libraries.md in apps/api/tests/contract/standards.test.ts
- [X] T033 [P] [US2] E2E test: admin publishes standard → architect creates violating diagram → violations shown on save, save succeeds (soft-flag) in apps/web/tests/e2e/standards-enforcement.spec.ts

### Implementation for User Story 2

- [X] T034 [P] [US2] Implement Standard rule schema types (allowed/mandatory shapes, icon refs, color palette, font constraints) in packages/diagram-core/src/standards/schema.ts
- [X] T035 [US2] Implement `validate()` engine in packages/diagram-core/src/standards/validator.ts (depends on T034, T011)
- [X] T036 [US2] Implement Standard draft/publish/retire lifecycle service (one published version per diagram type) in apps/api/src/standards/standard.service.ts (depends on T007, T008)
- [X] T037 [US2] Implement Standards API routes in apps/api/src/standards/standard.routes.ts (depends on T036)
- [X] T038 [US2] Wire diagram save (`PATCH /diagrams/:id`) to re-run `validate()` against the active Standard and persist `lastValidationResult` without blocking the save in apps/api/src/diagrams/diagram.service.ts (depends on T035, T025)
- [X] T039 [US2] Implement admin "Standards" editor UI in apps/web/src/admin/StandardsEditor.tsx (depends on T037)
- [X] T040 [US2] Apply active Standard's approved shapes/colors as palette/canvas defaults in apps/web/src/palette/StandardDefaults.ts (depends on T039, T022)
- [X] T041 [US2] Implement violations panel (element, rule, message) in the canvas UI in apps/web/src/canvas/ViolationsPanel.tsx (depends on T038)
- [X] T042 [US2] Implement async re-validation of existing diagrams when a Standard is published/updated in apps/api/src/standards/revalidate.service.ts (depends on T036, T035)

**Checkpoint**: User Stories 1 and 2 both independently functional.

---

## Phase 5: User Story 3 - Use Persona-Specific Diagram Types and Symbol Libraries (Priority: P3)

**Goal**: Each of the four personas gets diagram types scoped to their abstraction level with a
searchable, correctly-scoped shape/icon palette including official Azure/AWS icons.

**Independent Test**: Start a diagram of each supported type, confirm the palette is scoped
correctly (e.g., no AWS icons in a business capability map), search for a known Azure/AWS icon by
name and get the correct result.

### Tests for User Story 3 ⚠️

- [X] T043 [P] [US3] Contract test: parse/serialize round-trip for C4 (Context/Container/Component/Code) DSL family in packages/diagram-core/tests/contract/dsl-c4.test.ts
- [X] T044 [P] [US3] Contract test: parse/serialize round-trip for architecture/cloud-infrastructure DSL family with icon references in packages/diagram-core/tests/contract/dsl-architecture.test.ts
- [X] T045 [P] [US3] Contract test: `loadLibrary()` ingests an Azure/AWS manifest and icons become searchable in packages/diagram-core/tests/contract/library-loading.test.ts
- [X] T046 [P] [US3] API contract test: diagram-type-scoped icon search per contracts/api-standards-libraries.md in apps/api/tests/contract/libraries.test.ts
- [X] T047 [P] [US3] E2E test: open each diagram type, confirm scoped palette; search "Azure Blob Storage" and "AWS Lambda" in apps/web/tests/e2e/persona-diagram-types.spec.ts

### Implementation for User Story 3

- [X] T048 [P] [US3] Implement C4 DSL parser/serializer (Context/Container/Component/Code) in packages/diagram-core/src/dsl/c4.ts (depends on T011)
- [X] T049 [P] [US3] Implement architecture/cloud-infrastructure DSL parser/serializer with icon-reference support in packages/diagram-core/src/dsl/architecture.ts (depends on T011)
- [X] T050 [P] [US3] Implement sequence, ERD, and UML DSL parsers/serializers in packages/diagram-core/src/dsl/sequence.ts, packages/diagram-core/src/dsl/erd.ts, packages/diagram-core/src/dsl/uml.ts (depends on T011)
- [X] T051 [P] [US3] Implement business capability map / value stream / landscape / roadmap / solution-architecture flowchart-family variants (persona-specific shape sets) in packages/diagram-core/src/dsl/business-diagrams.ts (depends on T019)
- [X] T052 [US3] Register all DiagramType entries (persona, abstraction level, dslFamily, defaultPaletteLibraryIds) in apps/api/src/seed/diagram-types.seed.ts (depends on T048, T049, T050, T051, T012)
- [X] T053 [P] [US3] Build Azure icon library manifest + SVG assets ingestion in packages/diagram-core/src/libraries/azure-icons/ (depends on T012)
- [X] T054 [P] [US3] Build AWS icon library manifest + SVG assets ingestion in packages/diagram-core/src/libraries/aws-icons/ (depends on T012)
- [X] T055 [US3] Implement icon/shape search service + routes (cross-library, diagram-type-scoped) in apps/api/src/libraries/search.service.ts and apps/api/src/libraries/library.routes.ts (depends on T053, T054)
- [X] T056 [US3] Implement searchable, diagram-type-scoped palette UI in apps/web/src/palette/Palette.tsx (depends on T055)
- [X] T057 [US3] Implement persona-aware new-diagram type picker in apps/web/src/app/NewDiagramDialog.tsx (depends on T052)

**Checkpoint**: User Stories 1, 2, and 3 all independently functional.

---

## Phase 6: User Story 4 - Save, Organize, and Version Diagrams (Priority: P4)

**Goal**: Diagrams live in a project/folder hierarchy with browsable, restorable version history.

**Independent Test**: Save a diagram into a folder, edit and save again, confirm prior versions
are viewable/restorable, and the diagram is findable via search.

### Tests for User Story 4 ⚠️

- [X] T058 [P] [US4] API contract test: Project create/get/tree per contracts/api-projects-sharing-admin.md in apps/api/tests/contract/projects.test.ts
- [X] T059 [P] [US4] API contract test: version list + restore per contracts/api-diagrams.md in apps/api/tests/contract/versions.test.ts
- [X] T060 [P] [US4] E2E test: save into folder → edit → restore prior version → search by name/type/folder in apps/web/tests/e2e/organize-version.spec.ts

### Implementation for User Story 4

- [X] T061 [US4] Implement Project/Folder service with cycle-prevention validation in apps/api/src/projects/project.service.ts (depends on T007, T008)
- [X] T062 [US4] Implement Projects API routes (create/get/tree) in apps/api/src/projects/project.routes.ts (depends on T061)
- [X] T063 [US4] Implement diagram search/browse by name/type/folder in apps/api/src/diagrams/search.service.ts (depends on T025, T061)
- [X] T064 [US4] Implement version list + restore-as-new-version routes in apps/api/src/diagrams/version.routes.ts (depends on T027)
- [X] T065 [US4] Implement project/folder browser UI in apps/web/src/projects/ProjectBrowser.tsx (depends on T062)
- [X] T066 [US4] Implement version history panel + restore action in apps/web/src/projects/VersionHistory.tsx (depends on T064)

**Checkpoint**: User Stories 1–4 all independently functional.

---

## Phase 7: User Story 5 - Import an Existing Mermaid Diagram (Priority: P5)

**Goal**: Users import existing Mermaid DSL text and continue editing it like a native diagram.

**Independent Test**: Import valid Mermaid DSL for a supported type, confirm correct rendering,
edit, and re-export successfully.

### Tests for User Story 5 ⚠️

- [X] T067 [P] [US5] Contract test: import of valid Mermaid text across all supported DSL families in packages/diagram-core/tests/contract/import.test.ts
- [X] T068 [P] [US5] API contract test: `POST /projects/:id/diagrams/import` success + structured 422 for unmappable syntax per contracts/api-diagrams.md in apps/api/tests/contract/import.test.ts
- [X] T069 [P] [US5] E2E test: import → edit → re-export in apps/web/tests/e2e/import.spec.ts

### Implementation for User Story 5

- [X] T070 [US5] Implement import endpoint (parse + diagramTypeHint resolution + structured 422 error details) in apps/api/src/diagrams/import.service.ts and apps/api/src/diagrams/import.routes.ts (depends on T019, T048, T049, T050, T051)
- [X] T071 [US5] Implement import UI (paste/upload Mermaid text) in apps/web/src/projects/ImportDialog.tsx (depends on T070)

**Checkpoint**: User Stories 1–5 all independently functional.

---

## Phase 8: User Story 6 - Share Diagrams and Manage Access (Priority: P6)

**Goal**: Owners share diagrams/projects at view/comment/edit access; admins manage user roles.

**Independent Test**: Share a diagram at "view" access (recipient cannot edit), change to "edit"
(recipient can now modify it).

### Tests for User Story 6 ⚠️

- [X] T072 [P] [US6] API contract test: ShareGrant CRUD + most-specific-grant access resolution per contracts/api-projects-sharing-admin.md in apps/api/tests/contract/sharing.test.ts
- [X] T073 [P] [US6] API contract test: admin user/role management per contracts/api-projects-sharing-admin.md in apps/api/tests/contract/admin-users.test.ts
- [X] T074 [P] [US6] E2E test: share at view (edit blocked) → change to edit (edit allowed) in apps/web/tests/e2e/sharing.spec.ts

### Implementation for User Story 6

- [X] T075 [US6] Implement ShareGrant service with most-specific-grant resolution (diagram grant overrides inherited project grant) in apps/api/src/sharing/sharing.service.ts (depends on T007, T008)
- [X] T076 [US6] Implement sharing API routes (create/list/revoke) in apps/api/src/sharing/sharing.routes.ts (depends on T075)
- [X] T077 [US6] Implement access-level enforcement middleware on all diagram/project write routes in apps/api/src/auth/access-control.middleware.ts (depends on T075, T009)
- [X] T078 [US6] Implement admin user/role management service + routes in apps/api/src/admin/admin.service.ts and apps/api/src/admin/admin.routes.ts (depends on T009)
- [X] T079 [US6] Implement admin console "Users" page in apps/web/src/admin/UsersPage.tsx (depends on T078)
- [X] T080 [US6] Implement share dialog (grant/revoke access) in apps/web/src/projects/ShareDialog.tsx (depends on T076)

**Checkpoint**: All 6 user stories independently functional — full spec scope delivered.

---

## Final Phase: Polish & Cross-Cutting Concerns

- [X] T081 [P] Implement admin console "overview" page aggregating standards, libraries, and users (FR-023) in apps/web/src/admin/AdminOverview.tsx
- [X] T082 [P] Accessibility audit (WCAG 2.1 AA) of editor toolbars and admin console in apps/web
- [X] T083 [P] Performance validation: diagram list/search p95 < 300ms at 1,000+ diagrams (SC-007) in apps/api/tests/performance/search.perf.test.ts
- [X] T084 [P] Performance validation: canvas sustains 60fps up to 300 elements in apps/web/tests/performance/canvas.perf.test.ts
- [X] T085 Security hardening: session config, input validation, SVG/PNG export sanitization to prevent embedded scripts/telemetry in apps/api and packages/diagram-core
- [X] T086 Update quickstart.md with actual setup/test commands once scaffolding is real
- [X] T087 Run full quickstart.md manual validation end-to-end

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies.
- **Foundational (Phase 2)**: Depends on Setup — BLOCKS all user stories.
- **User Stories (Phase 3–8)**: All depend on Foundational completion; independently
  implementable/testable thereafter, though the following data dependencies exist:
  - US2 (standards) reads/writes diagrams created via US1's Diagram service.
  - US3 (persona diagram types/libraries) adds DSL families that US1's flowchart family
    established the pattern for, and is required before US5 (import) can support those types.
  - US4 (organize/version) builds on US1's Diagram/DiagramVersion tables.
  - US5 (import) depends on the DSL parsers built in US1 and US3.
  - US6 (sharing) is independent of US2–US5 but depends on US1's Diagram/Project resources
    existing to share.
- **Polish (Final Phase)**: Depends on all implemented user stories.

### Recommended Order

P1 → P2 → P3 → P4 → P5 → P6, matching spec.md priorities; P4 and P6 could swap or run in
parallel with a second team since neither blocks the other.

### Parallel Opportunities

- All `[P]`-marked Setup and Foundational tasks run in parallel within their phase.
- Once Foundational is done, the DSL-family parser/serializer tasks across US1/US3 (different
  files in packages/diagram-core/src/dsl/) can be parallelized by multiple developers.
- All contract/E2E test tasks within a story marked `[P]` run in parallel (different files).
- With enough capacity, US1 and US6 can be staffed in parallel once Foundational is done, since
  US6 only needs US1's Diagram/Project *shape*, not its full implementation, to write against the
  contracts in contracts/api-projects-sharing-admin.md.

---

## Parallel Example: User Story 1

```bash
# Tests together:
Task: "Contract test round-trip in packages/diagram-core/tests/contract/round-trip.test.ts"
Task: "Contract test parse-errors in packages/diagram-core/tests/contract/parse-errors.test.ts"
Task: "Contract test render-svg in packages/diagram-core/tests/contract/render-svg.test.ts"
Task: "API contract test diagrams in apps/api/tests/contract/diagrams.test.ts"
Task: "E2E test create-export in apps/web/tests/e2e/create-export.spec.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1 (Setup) and Phase 2 (Foundational).
2. Complete Phase 3 (User Story 1).
3. **STOP and VALIDATE** independently (quickstart.md §"Primary manual validation").
4. Demo/deploy if ready — this alone proves the core round-trip promise the rest of the product
   depends on.

### Incremental Delivery

Setup + Foundational → US1 (MVP, round-trip + export) → US2 (governance) → US3 (persona
diagram types + Azure/AWS libraries) → US4 (organize/version) → US5 (import) → US6 (sharing) →
Polish. Each checkpoint is independently demoable.

---

## Notes

- `[P]` tasks touch different files with no unmet dependencies.
- Every diagram-type or export task in US1/US3 has its round-trip/validation contract test
  written and failing **before** the implementation task begins, per Constitution IV.
- Commit after each task or logical group; stop at any checkpoint to validate a story in
  isolation before continuing.
