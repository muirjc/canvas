<!--
Sync Impact Report
- Version change: [TEMPLATE] → 1.0.0 (initial ratification)
- Modified principles: n/a (first concrete version, all six principles newly defined)
- Added sections: Core Principles (6), Technology & Compliance Constraints,
  Development Workflow & Quality Gates, Governance
- Removed sections: none (template placeholders replaced)
- Templates requiring updates:
  ✅ .specify/templates/plan-template.md (Constitution Check gate is generic — reads from
     this file at plan time; no structural edit needed)
  ✅ .specify/templates/spec-template.md (no constitution-specific references; unaffected)
  ✅ .specify/templates/tasks-template.md (no constitution-specific references; unaffected)
  ✅ .claude/skills/speckit-*/SKILL.md (no hardcoded principle names found; unaffected)
- Follow-up TODOs:
  - TODO(RATIFICATION_DATE): Confirmed as the date this constitution was first authored
    (2026-07-25). No prior undocumented adoption date exists, so no discrepancy to resolve.
-->

# Canvas Constitution

## Core Principles

### I. Diagram-as-Data (Source of Truth)

The Mermaid DSL representation of a diagram is the single canonical source of truth.
SVG and PNG are derived render targets, regenerated from the DSL, and MUST NOT be hand-edited
or treated as authoritative. Every diagram MUST round-trip losslessly: editing the DSL updates
the visual canvas, and editing the visual canvas regenerates equivalent DSL, with no silent
loss of shapes, connectors, labels, or grouping.

**Rationale**: Three export formats only stay consistent with each other if exactly one of
them is authoritative. Treating rendered output as a second source of truth guarantees drift
between what users see and what is stored/shared.

### II. Standards Are Enforced, Not Advisory

Admin-defined diagramming standards (permitted/mandatory shapes, colors, fonts, and icon sets
per diagram type and notation) MUST be machine-checked, not just documented. The system MUST be
able to programmatically validate a diagram against its assigned standard and surface concrete,
specific violations. A "compliant" diagram is one that passes automated validation, not one a
human believes follows the guidelines.

**Rationale**: The core value proposition for admins is governance at scale across many
architects and diagrams; a standard that only lives in a style guide document does not scale
and cannot be trusted during audits.

### III. Persona-Appropriate Abstraction

Every diagram type is explicitly scoped to one or more named architect personas (Business,
Enterprise, Solution, Technical) and a defined abstraction level (e.g., C4 Context vs.
Component). Features and shape palettes for a given diagram type MUST NOT leak detail belonging
to a different abstraction level (e.g., a business capability map MUST NOT expose
network/deployment-level elements).

**Rationale**: The product's differentiator is that it serves four distinct personas without
turning into a generic all-purpose canvas where every diagram accretes irrelevant detail.

### IV. Test-First for Rendering & Export (NON-NEGOTIABLE)

Because DSL parsing, shape rendering, and SVG/PNG export are the core correctness surface,
contract tests for these paths MUST be written before implementation and MUST fail before the
corresponding code is written (Red-Green-Refactor). This applies to: DSL parse/serialize
round-trips, per-diagram-type standard validation, and export fidelity (SVG/PNG match the
canvas state).

**Rationale**: Regressions in rendering or export are the hardest class of bug to catch via
manual QA because they are visual and often diagram-type-specific; automated contract tests are
the only reliable guard.

### V. Extensible Symbol Libraries

Icon and shape libraries (Azure, AWS, C4 notation, UML, generic flowchart/ERD shapes, and any
future provider) MUST be added through a defined library contract (category, license/attribution,
version, visual metadata) rather than hardcoded into rendering logic. Adding a new icon set or a
new version of an existing one MUST NOT require changes to core rendering or validation code.

**Rationale**: Cloud provider icon sets change frequently and new providers/notations will be
requested; treating them as pluggable data keeps the core system stable as libraries evolve.

### VI. Simplicity & Incremental Delivery

Each user story MUST be independently testable and independently deliverable as a viable slice
of value, per the spec-kit prioritization model (P1, P2, P3...). Implementation MUST NOT
introduce abstractions, configuration, or diagram-type support beyond what the current spec
requires. Speculative generalization (e.g., building a plugin system before a second plugin
exists) requires explicit justification in Complexity Tracking.

**Rationale**: A four-persona, multi-format, governance-enforcing tool has enough inherent scope;
uncontrolled speculative abstraction is the most likely way this project fails to ship.

## Technology & Compliance Constraints

- Vendor icon sets (Azure, AWS, and any future cloud/vendor providers) MUST be used in
  compliance with the vendor's published trademark and icon usage guidelines (e.g., no
  modification of official service icons beyond permitted resizing/coloring rules).
- Exported SVG/PNG files MUST NOT embed tracking pixels, telemetry, or external network calls.
- The diagram editor UI MUST meet WCAG 2.1 AA for keyboard navigation and color-contrast,
  independent of any diagram-specific color standard an admin configures.
- Diagram and standards data MUST be namespaced per organization/tenant; one organization's
  admin-defined standards or diagrams MUST NOT be visible to or editable by another.

## Development Workflow & Quality Gates

- Feature work follows the spec-kit lifecycle: `/speckit.specify` → `/speckit.clarify` →
  `/speckit.plan` → `/speckit.tasks` → `/speckit.implement`. The Constitution Check gate in
  `plan.md` MUST be evaluated before Phase 0 research and re-evaluated after Phase 1 design.
- Any Constitution Check violation MUST be either resolved or explicitly justified in the
  plan's Complexity Tracking table before implementation proceeds.
- Quality gates before a feature is considered done: automated tests pass (contract, unit,
  integration), DSL round-trip tests pass, standard-validation tests pass for every diagram
  type touched, and export fidelity tests pass for SVG and PNG.
- Code review MUST verify compliance with this constitution in addition to normal correctness
  review.

## Governance

This constitution supersedes ad hoc practices and conflicting guidance in other project
documents. Amendments require: (1) a documented rationale for the change, (2) a version bump
following semantic versioning (MAJOR for incompatible principle removal/redefinition, MINOR for
new/materially expanded principles or sections, PATCH for clarifications and wording), and
(3) propagation of the change to `plan-template.md`, `spec-template.md`, `tasks-template.md`,
and any command files that reference an affected principle by name. All plans and PRs MUST be
checked against this constitution; unjustified complexity or governance shortcuts MUST be
rejected or escalated for an explicit, recorded exception.

**Version**: 1.0.0 | **Ratified**: 2026-07-25 | **Last Amended**: 2026-07-25
