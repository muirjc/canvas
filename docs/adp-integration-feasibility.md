# Feasibility Study: Bringing Canvas into ADP to Replace ADP's Own Canvas Functionality

**Bead**: canvas-hly (closed — this document's Part 1 answer) · **Status**: Feasibility study
only — no implementation, no decision made.
**Scope of this document**: Part 1 (below) asks whether Canvas could *replace* ADP's C4 diagram
workspace wholesale. Part 2 (bottom of this file) asks a narrower, better-scoped follow-up: given
ADP has outgrown C4-only diagramming as it moved from a Solution-Architect tool toward
Enterprise/Business Architecture, could Canvas's *diagram-type breadth* (flowchart, sequence, ERD,
UML, cloud-architecture — everything beyond the C4 slice both apps already share) be ported into
ADP as an *additive* capability, leaving ADP's existing C4/typed-model/traceability pipeline
untouched?

## Summary

**Not straightforwardly feasible as a drop-in replacement.** The two projects solve an adjacent
but architecturally different problem, and ADP's canvas view is a thin *editing surface* over a
much larger typed data model — not a self-contained diagramming feature that could be swapped out
in isolation. The two most load-bearing facts:

1. **Different source-of-truth model.** Canvas's Constitution Principle I makes Mermaid DSL text
   the single canonical source of truth for a diagram — SVG/PNG are strictly derived and never
   authoritative. ADP's canonical source of truth is a **typed Pydantic model**
   (`ArchitectureDescription`) stored in PostgreSQL; DSL (its own **Structurizr** DSL, not
   Mermaid), SVG, and PNG are all *generated projections* of that model, produced by a completely
   separate export pipeline (`adp.renderer`) that the interactive canvas never touches. Canvas's
   canvas is a view onto DSL; ADP's canvas is a view onto a typed model. Neither app's canvas is
   built to be a view onto the other's source of truth.
2. **ADP's model carries governance/traceability data Canvas's model has no field for at all.**
   Every `Element` in ADP carries `satisfies` (requirement traceability), `provenance` (AI
   generation lineage), `tags`, and structured `technology_metadata`. Canvas's `DiagramNode` is
   purely visual/structural (id, label, shape, role, position, style, icon, containerId) — none of
   ADP's traceability fields have anywhere to live in Canvas's model today.

These two facts alone mean "bring Canvas's canvas into ADP" is not a UI-layer swap — it would
require either extending Canvas's own core model (risking exactly the kind of scope creep
Constitution VI warns against) or maintaining ADP's traceability data in a side-channel outside
whatever DSL Canvas edits, which reintroduces the dual-source-of-truth problem both projects'
architectures are individually designed to avoid.

## What ADP's current canvas functionality actually is

(`web/src/canvas/C4Canvas.tsx` + `adp.renderer`/`adp.theme`, confirmed by reading the source, not
inferred from the bead description alone)

- **React Flow (`@xyflow/react` v12)**-based interactive editor, C4 only (person / system /
  container / component — `ElementKind` "stops at component level (v1 scope)", no boundary
  concept). Reads/writes `ArchitectureDescription` directly via REST
  (`usePlaceElement`/`useDrawRelationship`/`useSaveLayout`); never generates or parses DSL text
  itself.
- Element/relationship layout positions persist server-side per design **and per C4 level**
  (`PUT /api/v1/designs/{id}/layout/{level}`) — a separate concept from Canvas's own
  `canvas.positions` YAML front-matter embedded in the DSL text itself.
- A **separate, server-side render pipeline** (`adp.renderer.orchestrator`) converts the typed
  model to **Structurizr DSL** (`design_to_dsl`, `adp/renderer/dsl.py` — a different C4-DSL
  dialect from Mermaid's own `C4Context`/`C4Container` syntax, not interchangeable without a
  translation layer) → a custom SVG generator → PNG via `cairosvg`. This path exists for document
  generation and export, not live editing.
- A **locked, schema-validated visual theme** (`adp.theme`, `c4-theme.json` +
  `c4-theme.schema.json`) governs element styling — conceptually adjacent to Canvas's own
  admin-defined Standards (Constitution Principle II), but a different mechanism (one global
  locked theme vs. Canvas's per-diagram-type, admin-authored, machine-checked rule sets).
- Substantial existing investment: 43 files under `specs/` reference the canvas view in some form,
  and it is the visual surface for `POST /designs/{id}/render`, `GET /designs/{id}/document`,
  `GET /designs/{id}/traceability`, `GET /designs/{id}/views`, `POST /designs/{id}/export`, and
  the FINOS CALM export — i.e. the canvas is load-bearing for most of ADP's downstream document/
  export/governance features, not an isolated widget.

## What Canvas offers, for comparison

- Mermaid DSL as the single source of truth (Constitution I), covering 6 diagram-type families
  (flowchart, C4, sequence, ERD, UML, architecture/cloud) — ADP only needs the C4 slice of this.
- Admin-defined, machine-checked Standards (shapes/colors/fonts/icon libraries) per diagram type
  (Constitution II) — a different governance axis from ADP's locked theme + LLM-as-Judge
  validation/verdict/audit-log system, with no overlap in what each one checks.
- TypeScript/Fastify/Node backend, PostgreSQL storage, Keycloak OIDC auth. The auth alignment is
  a genuine point of compatibility: this repo's own `infra/azure/README.md` already explicitly
  states it "mirrors ADP's own" Keycloak/Container Apps patterns — the two platforms already agree
  on how a user's identity and role should work, even though almost nothing else architecturally
  aligns.
- No requirement-traceability, AI-provenance, audit-log, or verdict concept anywhere in
  `packages/diagram-core`'s model today — these are ADP-specific concerns Canvas was never asked
  to represent.

## Integration options considered

| Option | What it would mean | Verdict |
|---|---|---|
| **Full replace**: ADP's canvas view becomes Canvas's canvas, wired to ADP's own API | Canvas's DSL parser/serializer would need to become the round-trip format for `ArchitectureDescription`, including every field ADP's model has that Canvas's doesn't (traceability, provenance, tags, technology metadata, locked theme, Structurizr export). This is closer to a rewrite of Canvas's C4 support than an integration. | **Not feasible without extending Canvas's core model** — and doing so risks Constitution VI (no speculative generalization; ADP-specific fields with no other consumer). |
| **Embed Canvas as a separate microservice**, ADP's canvas iframes/links out to a Canvas-hosted editor for the C4 view, syncing back via API | Avoids a model rewrite, but now two independently-authoritative diagram representations exist (ADP's typed model, Canvas's DSL) that must be kept in sync on every edit in either direction — a real, ongoing synchronization problem, not a one-time migration. | **Feasible but high ongoing complexity** — trades a rewrite for a permanent sync-consistency burden across two different backends (Python/FastAPI and Node/Fastify) and two different databases. |
| **One-way export**: ADP keeps its own canvas as the editing surface; Canvas is used only to *render/export* a read-only Mermaid-DSL rendition of an ADP design (e.g. for embedding in a wiki/doc that prefers Mermaid) | Narrow, low-risk, and technically straightforward — `design_to_dsl`'s existing Structurizr-DSL step could instead (or additionally) target a Mermaid-C4-syntax generator, reusing Canvas's existing C4 parser only to *validate* the output, not to power live editing. | **Feasible, but this is not "replacing ADP's current canvas functionality"** — it's a narrower, different feature (an export format), worth its own bead if wanted. |
| **Do nothing / keep both as independent products** | No integration risk; ADP keeps its typed-model-native canvas, Canvas keeps serving its own multi-family, DSL-native use case. | **Lowest-risk option**, and the one this study leans toward absent a specific, concrete driver for consolidation that outweighs the rewrite/sync costs above. |

## Recommendation

Do not pursue a full replacement. The architectural mismatch is at the level of "what is the
source of truth," not "which UI library renders the boxes" — that is the kind of decision neither
project should walk back lightly, and ADP's canvas is load-bearing for features (traceability,
CALM export, document generation, governance reporting) that have no equivalent in Canvas today.

If there is a specific, narrower motivation behind this bead (e.g. "we want Mermaid-format export
from ADP designs" or "we want ADP's designs viewable read-only inside Canvas for some reason"),
that is worth stating explicitly and scoping as its own, much smaller bead — the "one-way export"
option above is genuinely low-risk and could be delivered without touching either project's core
model or source-of-truth architecture.

## Open questions if this is pursued further

- What specific pain point with ADP's *current* canvas (React Flow + Structurizr DSL) is driving
  the request — performance, missing diagram types beyond C4, a desire for Mermaid-format output,
  something else? This determines which of the four options above (if any) is actually worth
  scoping.
- Is there an appetite on the ADP side to extend `ArchitectureDescription`/`Element` to be
  representable in Canvas's DSL losslessly, including `satisfies`/`provenance`/`tags`/
  `technology_metadata` — or is losing those fields on round-trip acceptable for some subset of
  use cases?
- Would consolidation be justified by reduced maintenance burden (one diagramming stack instead of
  two), or is the actual goal something narrower that doesn't require full consolidation?

---

# Part 2: Porting Canvas's diagram-type breadth into ADP (additive, not a replace)

**Driver (stated by the user)**: ADP started focused on Solution Architecture but has grown into a
broader Enterprise/Business Architecture tool. Its C4-only diagram capability is now too limiting
for that broader scope. The question: if a full replace/merge isn't sound (Part 1), can Canvas's
*capabilities* — specifically, everything beyond the C4 slice both apps already share (flowchart,
sequence, ERD, UML, cloud-architecture) — be moved into ADP, even if that means dramatic changes
to ADP's own canvas, rather than trying to reconcile the two source-of-truth models?

## Verdict: yes, this is genuinely feasible — and meaningfully easier than Part 1's question

Part 1's blocking problems (typed-model-vs-DSL source-of-truth conflict, `Element`'s
traceability/provenance/tags/technology-metadata fields having no home in Canvas's model) are
**specific to C4**, because C4 is the one diagram type ADP already has a mature, deeply-integrated
typed representation for. **Flowchart, sequence, ERD, UML, and cloud-architecture diagrams have no
existing ADP representation to conflict with at all.** That reframes this from "reconcile two
sources of truth" (hard, Part 1's problem) to "add a new, self-contained capability" (normal
feature work) — DSL-as-truth can simply be the (only) source of truth for these new diagram types,
the same way it already is in Canvas itself, with zero tension against ADP's existing
`ArchitectureDescription`/C4 pipeline, which would stay completely untouched.

Two independently-verified technical facts make this concretely, not just conceptually, feasible:

1. **`packages/diagram-core` has exactly two runtime dependencies, both pure JS with no
   server/filesystem coupling** (`yaml`, `@dagrejs/dagre`) — confirmed by reading its
   `package.json` directly, not assumed. The parser/serializer/model/validator/SVG-renderer are
   plain TypeScript with no Node-only APIs. This package is directly consumable as-is from a
   browser bundle — it does not need a rewrite, a WASM compile step, or a service boundary to run
   inside ADP's own frontend.
2. **ADP's `web/` frontend already runs the same generation of toolchain as Canvas's `apps/web`**
   — confirmed from `web/package.json`: React 18, TypeScript 5.x, Vite, Vitest, Playwright. This
   isn't just "a JS app that could theoretically import an npm package" — it's close enough to
   Canvas's own stack that Canvas's actual *React canvas-editing components*
   (`apps/web/src/canvas/`), not only the underlying data layer, are realistically portable too,
   not just the pure-logic package.

## What this would concretely look like

- **`packages/diagram-core` becomes a real dependency of ADP's `web/`** — published as an npm
  package both repos consume (preferred, avoids copy-paste drift between two independently-edited
  copies of the same parser), or vendored in directly as a nearer-term first step. Either way, ADP
  inherits Canvas's existing, extensively contract-tested (500+ tests) parsing/serialization/
  standards-validation logic for the 5 non-C4 families essentially for free — this is a real
  asset being inherited, not a risk being taken on.
- **New, independent backend storage in ADP** — a small, additive table (e.g. one row per
  supplementary diagram: id, `dsl_family`, `dsl_content`, timestamps, optionally a link to a
  `Design` for context) and a correspondingly small new FastAPI router. This is genuinely new
  surface, not a modification of `ArchitectureDescription`/`adp.store` — the canonical EA model
  and its migration history stay untouched, which is exactly what keeps this low-risk relative to
  Part 1's options.
- **Canvas's canvas-editing UI is ported into ADP's `web/src/canvas/`, alongside (not replacing)
  `C4Canvas.tsx`** — ADP's canvas view gains a diagram-type picker; C4 keeps using ADP's existing
  React-Flow-based editor and typed-model pipeline exactly as today, while the newly-supported
  types render/edit through the ported Canvas components against the new DSL-backed storage.
- **Rendering/export for the new types uses Canvas's own SVG renderer directly** (already pure
  TS) — no need to extend `adp.renderer`'s Python/Structurizr pipeline, which stays C4-only.
- **Auth needs no new work** — both already use Keycloak OIDC, and this repo's own
  `infra/azure/README.md` already documents that alignment.

## What is genuinely new engineering work, not free

- **Governance/permissions mapping.** Canvas's admin-defined Standards system
  (`packages/diagram-core/src/standards`) would need a real decision about how it composes with
  ADP's own existing RBAC (`enterprise_architect`/`solution_architect`/`technical_architect`/
  `reviewer`) — these are two different governance models built for different purposes, and
  nothing today reconciles them. Reasonable for a v1 to defer entirely (no standards enforcement
  on the new diagram types yet) rather than solve up front.
- **UI/visual integration**, not a verbatim drop-in — Canvas's canvas components would need
  adaptation to ADP's own `AppShell`/design system conventions, the same category of work as any
  cross-codebase component port.
- **Product decision on data placement**: are these new diagrams attached to a `Design` (part of
  an EA deliverable) or fully standalone artifacts a user creates independent of any design? This
  changes the new table's shape and needs an answer before implementation, not an assumption.
- **AI chat is explicitly out of scope for a first port.** Canvas's AI-chat tool-calling system
  (the feature actively under construction in this same session, `010-ai-diagram-knowledge`) is
  wired to Canvas's own AI-provider config and tool surface; ADP has its own, separate LLM
  pipeline (LangGraph intake/recommendation/validation). Bringing Canvas's AI chat over is a
  distinct, later integration decision — the diagram-editing capability itself doesn't need it to
  deliver value.

## Suggested phased approach (if pursued)

1. Vendor/publish `packages/diagram-core` into ADP's `web/`; confirm it builds and its existing
   test suite runs clean inside ADP's toolchain — a pure feasibility spike with no product surface
   yet.
2. Add the new, independent backend table + minimal CRUD API in ADP (Python/FastAPI) — additive
   only, `ArchitectureDescription` untouched.
3. Port Canvas's canvas-editing React components into ADP's `web/`, wired to the new API, with a
   diagram-type picker added alongside the existing C4-only entry point.
4. (Stretch, later, separately scoped) governance/permissions reconciliation; linking new diagrams
   to ADP's traceability model; AI chat integration.

## Recommendation

This is worth pursuing as real, scoped work — unlike Part 1's full-replace question, there is no
architectural blocker here, only normal additive-feature engineering with two independently
verified facts (dependency-free package, matching toolchain) supporting it. File it as its own
bead (not a re-open of canvas-hly, which specifically answered the full-replace question) once
the two open product decisions above (governance deferral confirmed acceptable for v1; new
diagrams attached-to-a-Design vs. standalone) have real answers — those materially affect the new
table's shape and shouldn't be assumed by whoever picks up the implementation.

