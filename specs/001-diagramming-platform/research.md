# Phase 0 Research: Governed Multi-Persona Diagramming Platform

## 1. Mermaid DSL expressiveness for free-form, icon-rich diagrams

**Decision**: Treat Mermaid DSL as the canonical *semantic* representation (nodes, edges, labels,
containers, diagram type, and style/icon references), and store visual-only metadata (exact
free-form (x, y) positions, per-node manual overrides) as a structured Mermaid front-matter/
directive block that today's stable Mermaid renderer already tolerates (front-matter and
`%%{init}%%` config blocks are ignored by the reference parser but preserved as plain text by our
own parser). Modern Mermaid (v10.5+) added native icon support via `@{ icon: "..." }` syntax and
`registerIconPacks` for flowchart/architecture diagrams, which is used directly for Azure/AWS/C4
icon references wherever the diagram type's native grammar supports it (architecture, flowchart);
for diagram types whose grammar has no icon/position concept (e.g., classic C4 or sequence
diagrams), icon/position metadata rides in the front-matter block, and the diagram still renders
correctly with any *standard* Mermaid tool that only reads the semantic body.
**Rationale**: Keeps the exported `.mmd` file meaningful and open outside our platform (a core
promise of "Mermaid DSL as source of truth"), while not blocking free-form layout, which real
architects expect from a drawing tool. Front-matter is the one extension point Mermaid already
reserves for tool metadata, so this isn't a fork of the language.
**Alternatives considered**: (a) Force everything into strict auto-layout Mermaid with no manual
positions — rejected, users explicitly expect direct-manipulation editing (FR-001). (b) Invent a
completely separate first-class DSL and only export "a Mermaid-like" format — rejected, violates
FR-004's requirement that Mermaid DSL export is real, re-importable Mermaid.

## 2. Canvas/editor rendering approach

**Decision**: Build the interactive canvas on an established 2D graph-editing library (e.g., a
node/edge canvas toolkit rather than raw SVG-from-scratch) for drag/connect/group/resize
interactions, and render read-only Mermaid preview via `mermaid.js` for parity-checking against
the shared `diagram-core` model during development and for the "paste raw Mermaid" import path
(User Story 5). The editable canvas itself is driven entirely by the `diagram-core` object model,
not by mermaid.js's own (non-editable) rendering pipeline.
**Rationale**: mermaid.js is excellent at DSL → static SVG rendering but is not designed to be an
interactive, direct-manipulation editor (no drag/resize/connect API surface); building interactive
editing on a purpose-built graph-canvas library is much less effort than retrofitting one onto
mermaid.js's renderer, and keeps `diagram-core` (the round-trip-critical part) independent of
whichever UI canvas library is chosen.
**Alternatives considered**: Fork/extend mermaid.js's renderer to be interactive — rejected as
high-effort and fragile against upstream changes. Build a fully custom canvas from raw SVG/Canvas
APIs with no library — rejected per Constitution VI (unjustified reinvention of solved problems
like hit-testing, snapping, and multi-select).

## 3. Icon/shape library sourcing and ingestion

**Decision**: Ingest Azure and AWS icons from each vendor's official published "Architecture
Icons" asset packages (SVG), plus a generic/C4/UML/ERD shape set authored or sourced from
permissively-licensed sets, through one ingestion pipeline that produces: icon id, display name,
search keywords, category, source library + version, license/attribution string, and the SVG
asset — all conforming to the `diagram-core` library contract (Constitution V). New libraries or
version bumps are data imports, not code changes.
**Rationale**: Matches FR-008/FR-010 and Constitution V directly; keeps vendor-icon compliance
(constitution's Technology & Compliance Constraints) auditable in one place (attribution/license
field per icon) instead of scattered across the codebase.
**Alternatives considered**: Hand-drawing "inspired by" icons to avoid licensing questions —
rejected, FR-008 explicitly requires the *official* icon sets. Depending on a third-party icon CDN
at runtime — rejected, conflicts with the constitution's "no external network calls in exported
files" constraint and adds an availability dependency to core editing.

## 4. SVG/PNG export pipeline

**Decision**: SVG export is produced directly from the canvas's own SVG-based render tree (the
editor already renders as SVG, so export is close to a serialization of current state, with
diagnostic/UI-only elements stripped). PNG export is produced **server-side** by rasterizing that
same SVG with a headless rasterizer, so PNG output is deterministic and independent of the
requesting user's browser/OS/font availability.
**Rationale**: Server-side rasterization guarantees SC-001/SC-002-style fidelity guarantees hold
the same way for every user, and avoids shipping large client-side rasterization dependencies to
every browser session for an action (PNG export) that is occasional, not continuous.
**Alternatives considered**: Client-side canvas rasterization (`canvas.drawImage` on the SVG) —
rejected as primary path due to font/renderer inconsistency across browsers/OSes, though it may
still serve as an instant low-fidelity preview while the server-rendered PNG is prepared.

## 5. Backend framework

**Decision**: Fastify (Node.js/TypeScript), organized as route → service → repository modules per
resource area (diagrams, standards, libraries, projects, sharing, admin, export, auth), without a
full-DI framework layer.
**Rationale**: Satisfies Constitution VI — the app needs clean module boundaries, not a DI
container; Fastify's plugin/route model is enough structure at this scale (single organization,
monolithic deployment) and keeps the dependency surface small.
**Alternatives considered**: NestJS — rejected for now as heavier machinery (DI, decorators,
module system) than currently justified; could be reconsidered if the backend later needs it, per
Constitution VI's "justify before generalizing" rule.

## 6. Data storage strategy

**Decision**: PostgreSQL for all structured/relational data, including Diagram Version rows that
store the full Mermaid DSL text (plus front-matter metadata) per version — text sizes here are
small (single diagrams, not media), so no separate blob store is needed for DSL content. Icon/
shape library SVG assets are stored in a blob/object store (filesystem volume in the simplest
deployment, S3-compatible bucket if deployed to cloud infra), referenced by id+version from
Postgres rows.
**Rationale**: One relational store keeps referential integrity (Diagram ↔ Version ↔ Diagram Type
↔ Standard ↔ Project ↔ Share Grant) simple and query-able (needed for SC-007's search-at-scale
requirement); splitting only the large binary icon assets out avoids bloating the database with
asset files while keeping everything else in one place.
**Alternatives considered**: Document store (e.g., Mongo) for diagrams — rejected, the relational
links between Diagram/Standard/Project/User/Share Grant are numerous and consistency-sensitive,
which relational modeling handles more directly.

## 7. Authentication

**Decision**: OIDC-based single sign-on as the primary authentication mechanism, with the backend
holding server-side sessions after token exchange (not storing raw provider tokens client-side).
**Rationale**: Single-organization enterprise deployments (per spec Clarifications) typically
already run an identity provider; OIDC SSO avoids the platform owning a parallel password store
and satisfies "standard session-based or OAuth2 for web apps" default guidance.
**Alternatives considered**: Local email/password only — kept as a fallback path for the smallest
deployments, but not the primary path, since it duplicates identity management the org likely
already has.

## 8. Testing strategy (Constitution IV)

**Decision**: `diagram-core` contract tests (round-trip fidelity per diagram type, per-type
standards validation, export-input fidelity) are written first and must fail before any
diagram-type or export implementation task begins, per diagram type family, as required tasks in
`/speckit.tasks`. API contract tests cover every endpoint in `contracts/`. Playwright end-to-end
tests cover each user story's acceptance scenarios, including an SVG/PNG visual-snapshot check for
export fidelity (User Story 1).
**Rationale**: Directly operationalizes the NON-NEGOTIABLE constitution principle instead of
leaving "test-first" as an unenforced intention.
**Alternatives considered**: Manual QA checklist per release — rejected, cannot scale across many
diagram types and is exactly the failure mode Principle IV exists to prevent.

## 9. Standards validation engine design

**Decision**: A Standard is a versioned, structured rule set (not free text) scoped to one Diagram
Type: allowed/mandatory shape ids, allowed/mandatory icon ids (with library+version reference),
an approved color palette (with per-element-role mapping, e.g., "Person" shapes → color X), and
optional font constraints. The validator evaluates a Diagram's model against its Diagram Type's
active Standard and returns a list of discrete violations `{elementId, rule, message}`, which is
exactly the shape FR-013 requires and what the soft-flag UI (FR-024) renders.
**Rationale**: A structured rule schema is what makes "machine-checked, not advisory" (Constitution
II) possible at all; free-text guidelines can't be validated by code.
**Alternatives considered**: Encoding standards as arbitrary scripts/plugins per organization —
rejected as premature generalization (Constitution VI) for a single-organization deployment with a
fixed, known set of rule dimensions (shape/icon/color/font).

## 10. Accessibility approach

**Decision**: Build interactive UI chrome (dialogs, menus, forms in the admin console and editor
toolbars — not the freeform canvas surface itself, which has its own keyboard-navigation model) on
an accessible component primitive library with built-in ARIA/keyboard support, rather than
hand-rolling accessible widgets.
**Rationale**: WCAG 2.1 AA (constitution constraint) is far more reliably achieved by reusing
audited accessible primitives than by re-implementing focus management, ARIA roles, and contrast
handling per component.
**Alternatives considered**: Fully custom component library — rejected as unnecessary
reinvention and higher risk of accessibility regressions.

---

All Technical Context unknowns are resolved above; no `NEEDS CLARIFICATION` markers remain in
`plan.md`.
