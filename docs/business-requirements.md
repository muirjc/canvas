# Business Requirements Document: Canvas

| | |
|---|---|
| **Document status** | Draft |
| **Version** | 1.1 |
| **Date** | 2026-09-11 |
| **Owner** | Product / Engineering |
| **Source material** | `specs/001-diagramming-platform/spec.md` through `specs/011-sequence-lifeline-rendering/spec.md`, `.specify/memory/constitution.md`, `README.md`, `CLAUDE.md`'s Recent Changes log |
| **Companion document** | `docs/solution-architecture-document.md` — the *how*; this document is the *why*. |

This document describes the business rationale, objectives, and requirements for Canvas at a
level suitable for stakeholders outside the engineering team. It is derived from — and stays
subordinate to — the project's own governing constitution (`.specify/memory/constitution.md`) and
the detailed, testable functional specifications already maintained under `specs/`. Where this
document and a `specs/*/spec.md` file disagree on a technical detail, the spec file is
authoritative; this document exists to explain *why* those requirements exist, not to replace
them.

## 1. Executive Summary

Canvas is a governed, web-based diagramming platform purpose-built for enterprise architecture
and technical documentation. It replaces the common failure mode of general-purpose drawing
tools used for architecture work — diagrams that are visually inconsistent, drift from any
documented standard, and cannot be validated at scale — with a platform where diagrams are
structured data, admin-defined standards are machine-enforced rather than advisory, and every
diagram type is scoped to the architecture persona and abstraction level it actually serves.

The platform serves four distinct architect personas (Business, Enterprise, Solution, Technical)
from one tool, with Mermaid DSL as the single canonical source of truth for every diagram and
SVG/PNG as derived, always-consistent export formats.

## 2. Business Context & Problem Statement

Organizations that produce architecture diagrams at scale — across many architects, many
diagram types, and many teams — routinely encounter the same set of problems with
general-purpose drawing tools (e.g. generic diagramming/whiteboard software):

- **No enforceable standards.** A style guide describing "use these colors for AWS services" or
  "C4 Context diagrams must use these shapes" is advisory only; nothing stops a diagram from
  silently drifting out of compliance, and nobody can cheaply audit a large diagram library
  against it.
- **One-size-fits-all tooling for four different jobs.** A Business Architect's capability map,
  an Enterprise Architect's application landscape, a Solution Architect's sequence diagram, and a
  Technical Architect's cloud infrastructure diagram are different disciplines with different
  vocabularies and abstraction levels. Generic tools offer the same undifferentiated shape
  library to everyone, which either overwhelms less technical personas with irrelevant detail or
  under-serves technical ones.
- **Rendered output as the only source of truth.** When a diagram's file format *is* its
  rendered picture (or a proprietary binary format), there is no reliable way to diff, template,
  programmatically validate, or regenerate it in another format without visual drift.
- **Fragmented icon/notation support.** Official cloud-provider icon sets (Azure, AWS), C4
  notation, UML, and ER notation are each their own ecosystem; most general tools support these
  unevenly or via inconsistent, community-maintained stencils of uncertain provenance and license
  status.

Canvas exists to remove these problems for a single organization's architecture practice: one
platform, one canonical diagram representation, machine-checked standards, and persona-scoped
tooling.

## 3. Business Objectives

1. **Reduce diagram inconsistency across the architecture practice** by making standards
   machine-validated rather than documentation-only (Constitution Principle II).
2. **Serve four architect personas from a single platform** without any persona's diagram types
   or palettes leaking irrelevant detail from another persona's abstraction level (Constitution
   Principle III).
3. **Guarantee diagrams never silently lose information** across edit/export/re-import cycles, so
   the diagram-as-data model is trustworthy enough to build downstream tooling and documentation
   pipelines on (Constitution Principle I).
4. **Lower the cost of adopting and maintaining official vendor icon sets** (Azure, AWS, and any
   future provider) by treating them as versioned, pluggable data rather than hardcoded artwork
   (Constitution Principle V).
5. **Keep the platform's scope deliberately bounded** to what current, validated user stories
   require, avoiding speculative generalization that would slow delivery without proven demand
   (Constitution Principle VI).

## 4. Target Users / Stakeholders

| Persona | Role | Primary need |
|---|---|---|
| **Business Architect** | Models business capabilities, value streams, and organizational structure | Capability maps and value-stream diagrams, no network/deployment-level detail surfaced |
| **Enterprise Architect** | Models the application/technology landscape and its evolution | Application landscape and roadmap diagrams |
| **Solution Architect** | Designs individual solutions and their interactions | C4 Container/Component diagrams, solution architecture, and sequence/flow diagrams |
| **Technical Architect** | Designs deployable, physical/cloud infrastructure | Network, deployment, and cloud infrastructure diagrams using official Azure/AWS icon sets |
| **Administrator** | Governs the platform | Defines and publishes diagramming standards, manages icon/shape libraries and user roles/permissions via a dedicated admin console |
| **Viewer / collaborator** | Consumes or comments on diagrams they don't own | Access diagrams shared with them at view/comment/edit level |

Every diagram type is explicitly tagged with the persona(s) it serves and its abstraction level;
this tagging is enforced in the product, not just documented (Constitution Principle III).

## 5. Scope

### 5.1 In scope

- Visual, direct-manipulation diagram editing (shapes, connectors, text labels, containers/
  grouping) with **Mermaid DSL as the single canonical source of truth** — editing the DSL
  updates the canvas and editing the canvas regenerates equivalent DSL, losslessly, in both
  directions.
- Export to Mermaid DSL (plain text), SVG (scalable vector), and PNG (raster) on demand.
- Out-of-the-box diagram types: C4 (Context, Container, Component, Code), business capability
  maps, value stream diagrams, application/enterprise landscape and roadmap diagrams, solution
  architecture diagrams, sequence/flow diagrams, network/deployment/cloud infrastructure
  diagrams, plus generic flowchart, entity-relationship (ERD), and UML diagrams.
- Official Azure and AWS service icon sets, C4 notation, UML, and generic flowchart/ERD shapes,
  each searchable and each manageable as a versioned, updatable library.
- An admin-governed standards layer: per-diagram-type rules for allowed/mandatory shapes,
  colors, fonts, and icon sets, published as the default styling for new diagrams and used to
  validate existing ones with specific, actionable (not generic pass/fail) violation reporting.
  Standards enforcement is **soft-flag**: a non-compliant diagram can still be saved and
  exported — architects are informed, never blocked.
- Projects/folders for organizing diagrams, version history with restore, and search.
- Import of existing Mermaid DSL as a fully editable diagram, with specific reporting of any
  construct that cannot be imported.
- Sharing a diagram or project at view/comment/edit access level, and an admin console for
  managing standards, icon libraries, and user roles/permissions in one place.
- AI-assisted, natural-language diagram creation and refinement via a persistent chat panel,
  with admin-curated personas and optional persona-scoped reference material (added post-launch;
  see §8).
- Importing a filled-in "intake template" document (a structured, fillable worksheet, distinct
  from raw Mermaid DSL paste) for a diagram type, compiled directly into DSL and rendered
  identically to any other diagram (added post-launch; see §8).
- Single sign-on via an OIDC identity provider (Keycloak) with organization-enforced MFA, alongside
  a local email/password fallback for dev/demo use, and a self-documenting REST API (OpenAPI/
  Swagger, opt-in) for integration consumers (added post-launch; see §8).
- A reproducible Infrastructure-as-Code deployment (Azure) with a cost-control pause/resume/
  destroy lifecycle, for standing up a real reference environment on demand (added post-launch;
  see §8).

### 5.2 Explicitly out of scope

- Real-time multi-cursor co-editing.
- Native mobile applications.
- Diagram types beyond those listed in §5.1 (extensible later, but not required for the current
  scope).
- Multi-organization tenancy — the platform is a **single-organization deployment**: one shared
  set of users, standards, icon libraries, and diagrams, with no cross-organization data
  isolation required.
- Sharing diagrams or projects with users/audiences outside the organization.

## 6. Business Requirements

Numbered functional requirements (FR-001 through FR-026) and their acceptance criteria live in
`specs/001-diagramming-platform/spec.md`; later specs (`002` through `009`) add and refine
requirements incrementally as the platform evolved (see §8). At the business level, those
requirements group into six themes:

1. **Core diagram editing & round-trip** — a diagram can be built visually or via DSL text, and
   the two never disagree or silently lose content.
2. **Diagram types & symbol libraries** — the right palette, scoped to the right persona and
   abstraction level, searchable, using official vendor icon artwork where applicable.
3. **Governance & standards** — organization-wide, machine-validated, versioned standards that
   pre-style new work and flag (not block) deviations in existing work.
4. **Persistence, organization, and versioning** — diagrams live in a project/folder hierarchy,
   are versioned, and can be found again by name, type, or folder.
5. **Import** — existing Mermaid diagrams become first-class, fully editable Canvas diagrams.
6. **Sharing, permissions, and administration** — access is grantable at view/comment/edit
   granularity, and a single admin console governs standards, libraries, and user roles.

## 7. Success Criteria

The following measurable outcomes (drawn from `specs/001-diagramming-platform/spec.md` §Success
Criteria) define what "working as intended" means at the business level:

| ID | Criterion |
|---|---|
| SC-001 | A first-time user creates a diagram and exports all three formats in under 10 minutes, unassisted. |
| SC-002 | Round-trip edits (visual ↔ DSL) retain 100% of shapes, connectors, labels, and groupings — zero silent data loss. |
| SC-003 | ≥95% of diagrams created from a template under an active standard pass automated validation on first save. |
| SC-004 | A known shape or icon is findable via palette search in under 15 seconds. |
| SC-005 | An admin publishes a new/updated standard in one workflow, with no per-diagram manual re-configuration. |
| SC-006 | ≥90% of persona-based usability test participants confirm their diagram types/palettes match role expectations. |
| SC-007 | Save/load/search stay perceptibly instant for projects with at least 1,000 diagrams. |
| SC-008 | A sharing access-level change takes effect on the recipient's next action, with no stale-permission window. |

## 8. Delivery History

The platform was delivered incrementally against this business requirement set, using the
spec-kit lifecycle (constitution → specify → clarify → plan → tasks → implement) tracked under
`specs/`:

| Spec | Delivered |
|---|---|
| `001-diagramming-platform` | The foundational platform: visual/DSL round-trip editing, all core diagram types, Azure/AWS icon libraries, admin-governed standards, projects, versioning, sharing, and import — the requirements set out in §5–§7 above. |
| `002-editing-lifecycle-enhancements` | Sign-out, label editing, shape/diagram deletion, and broader flowchart DSL compatibility. |
| `003-parser-correctness-fixes` | ER attribute blocks, sequence diagram notes/control-flow blocks, and `%%` comment support across every parser. |
| `004-ai-diagram-chat` | Admin-authored AI personas and a natural-language chat interface for generating and iteratively refining a diagram. |
| `005-modern-ui-redesign` | A cohesive visual design system (tokens, WCAG 2.1 AA-verified contrast) and a restructured editor layout. |
| `006-authoring-admin-console` | Container/grouping objects, a discoverable label-editing affordance, persistent admin navigation, capped/searchable version history, and named/described/retirable standards. |
| `007-project-context` | In-application project selection that survives navigation, replacing a URL-query-parameter-only model. |
| `008-shared-diagram-access` | A discoverable path to diagrams shared with a user who has no project-level access. |
| `009-flowchart-node-shapes` | Additional Mermaid flowchart node shapes, with a diagram-family-aware authoring toolbar. |
| `010-ai-diagram-knowledge` | Family-aware AI tools and diagram-type primers (an AI chat request now uses the real vocabulary/tool set for the diagram's actual type, not a hardcoded flowchart assumption), plus admin-curated, persona-scoped reference material. |
| `011-sequence-lifeline-rendering` | Real sequence-diagram lifeline/activation/message geometry, replacing flat placeholder positions the family had used since launch. |

Substantial further work — delivered outside the formal spec-kit lifecycle but tracked end-to-end
in the project's issue tracker (`bd`) and `CLAUDE.md`'s Recent Changes log — brought the platform
from "each diagram family's DSL parses" to "every construct each family's real Mermaid grammar can
express has a matching point-and-click canvas affordance, and the platform is independently
deployable and securable":

- **A Mermaid DSL full-compliance roadmap** (epic `jmuir-dtu`), diagram-type by diagram-type,
  closing dozens of real grammar gaps across all six families (C4 boundary/element-kind vocabulary,
  UML members/generics/stereotypes/relationships, ERD attribute blocks/aliases/styling, sequence
  activation/blocks/autonumber/participant lifecycle, architecture junctions/groups/icon packs,
  flowchart click-interactions/classDef/multi-line labels).
- **A canvas-UI renderer-completeness epic** (`canvas-7vs`/`canvas-2s6`) closing the gap between
  "the DSL parses this construct" and "a user can create/edit it visually" for every one of those
  same constructs across all six families, plus cross-family drag-to-nest containers and
  auto-layout.
- **C4 Context template import** (`canvas-73s`) — importing a filled intake-template document,
  compiled to DSL and rendered through the existing pipeline; architected to extend to the
  remaining five diagram-type groups as follow-up work.
- **Azure deployment** (`canvas-ycu`) — a reproducible Bicep IaC deployment with Keycloak SSO/MFA,
  Key Vault-backed secrets, and a pause/resume/destroy cost-control lifecycle (see
  `docs/solution-architecture-document.md` §10).
- **Self-documenting API** — an OpenAPI/Swagger specification generated from the live route table
  and served at `/docs`, opt-in via configuration.

This document's business requirements are unaffected by any of the above — they refine and
complete delivery against the requirement set in §5–§7, not change it. `docs/solution-
architecture-document.md` covers the resulting technical architecture in full.

## 9. Assumptions & Constraints

- Accessed via a modern desktop web browser; no native mobile app is required.
- Standard web-application practices govern authentication, error handling, and data retention
  (diagrams retained until deleted by an owner or admin) unless a spec states otherwise.
- "Persona" scopes default diagram types and palettes; it is **not** a security boundary — access
  control is handled separately by roles/permissions.
- Azure and AWS icon libraries are sourced from each vendor's official published sets and updated
  periodically; real-time parity with every vendor release is not required.
- Vendor icon sets must be used per each vendor's published trademark/usage guidelines (no
  modification beyond permitted resizing/coloring).
- Exported SVG/PNG must never embed tracking pixels, telemetry, or external network calls.
- The editor UI must meet WCAG 2.1 AA for keyboard navigation and color contrast, independent of
  any diagram-specific standard an admin configures.
- Version history is retained indefinitely unless an admin-configured retention policy states
  otherwise.

## 10. Risks

- **Standards drift without enforcement.** Mitigated by Constitution Principle II: standards are
  machine-validated, not advisory-only.
- **Vendor icon set changes.** Azure/AWS periodically rename or restyle service icons; existing
  diagrams referencing a changed icon are a known edge case requiring an explicit product
  decision (freeze to old version vs. auto-update) rather than silent breakage.
- **Scope creep across four personas.** Mitigated by Constitution Principle VI (no speculative
  generalization) and the spec-kit lifecycle's Complexity Tracking requirement for any
  constitution-check violation.
- **Round-trip data loss.** The platform's core trust guarantee; mitigated by Constitution
  Principle IV (contract tests for parse/serialize round-trips are non-negotiable and must exist,
  and fail, before implementation).

## 11. Glossary

| Term | Meaning |
|---|---|
| **DSL** | Domain-Specific Language — here, the Mermaid syntax that is the canonical representation of a diagram. |
| **Round-trip** | Editing a diagram via its DSL and via its visual canvas produce equivalent results in both directions, with no data loss. |
| **Standard (Stencil)** | An admin-defined, versioned set of rules (allowed/mandatory shapes, colors, fonts, icon set) bound to a diagram type. |
| **Soft-flag enforcement** | Standards violations are reported but never block save/export. |
| **Persona** | One of Business, Enterprise, Solution, or Technical Architect — scopes which diagram types and palettes are presented by default. |
| **Icon/Shape Library** | A named, versioned collection of icons or shapes (Azure, AWS, C4 notation, UML, generic) usable across relevant diagram types. |
| **Abstraction level** | The level of detail a diagram type operates at (e.g. C4 Context vs. C4 Component); diagram types must not leak detail across levels. |
| **Intake Template** | A structured, fillable worksheet for a diagram type (distinct from raw Mermaid DSL) that compiles directly into a diagram — an alternative starting point to visual editing, DSL paste, or AI chat. |
