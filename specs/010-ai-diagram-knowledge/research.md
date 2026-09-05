# Phase 0 Research: AI Chat Diagram-Type and Persona-Scoped Knowledge Grounding

## 1. Fixing multi-diagram-type support (Story 1) — the actual root cause

**Finding, not assumption**: `apps/api/src/ai/diagram-chat.service.ts:90` hardcodes
`getDslFamily('flowchart')!` regardless of the diagram actually being edited. `diagram-chat.routes.ts`
never fetches or passes the diagram's `diagramTypeId` at all, and the frontend's `ChatPanel` has no
diagram-type gating — the chat UI is shown for every diagram type today, but sending a message
against a non-flowchart diagram throws `DslParseError` (422) the moment `family.parse()` is asked
to read non-flowchart DSL text as flowchart syntax. This is the literal blocker Story 1 exists to
close, confirmed by reading the current source, not inferred from the bead description.

**Decision**: Reuse the exact mechanism `diagram.service.ts` already uses for the same lookup
elsewhere (`createDiagram`/`saveDiagram`): `loadDiagramTypeDslFamily(diagramTypeId)` →
`getDslFamily(dslFamilyId)`. Concretely: `diagram-chat.routes.ts`'s POST handler calls the existing
`getDiagram(id)` (already returns `dslFamily` on `DiagramRecord`) before calling `sendChatMessage`,
and passes `dslFamily` through as a new required field on `SendChatMessageInput`, replacing the
hardcoded literal.

**Rationale**: Zero new lookup mechanism — `getDiagram`/`loadDiagramTypeDslFamily` are the same
functions every other diagram-mutating code path already uses, so there is exactly one place in
the whole application that maps a diagram to its DSL family. No risk of this feature's lookup
drifting from the canonical one.

**Alternatives considered**: Sniffing the family from `currentDslContent` itself via
`packages/diagram-core/src/dsl/detect.ts` (already used by the import flow for "user pastes DSL
with no stated type" cases) — rejected here specifically, since a chat request already has an
authoritative, already-persisted `diagramTypeId` for the diagram being edited; re-detecting from
text is the right tool when the type is genuinely unknown, not when it is already on record.

## 2. What "grounding in the real DSL grammar" actually means, given Constitution I

**Constraint already established by 004** (Constitution I, reaffirmed in 004's own Constitution
Check): the AI never emits raw DSL text directly — every diagram mutation goes through a
`diagram-core` pure operation, wrapped as an AI SDK tool. This means the literal Mermaid token
syntax (`-->`, `<|--`, `..|>`, etc.) is never something the model needs to produce correctly — the
deterministic `diagram-core` serializer already guarantees syntactic validity regardless of what
the model "knows." The real gap is semantic: the model doesn't know a diagram type's *domain
concepts* (an ER entity has typed attributes with key markers; a UML relationship has a kind and
optional cardinality; a C4 element has a role) well enough to choose them correctly when calling a
tool — and today it mostly can't, because no tool parameter exists for most of these (see §3).

**Decision**: Two complementary, source-derived mechanisms, not a hand-written grammar dump:

1. **Tool schemas are the primary grounding mechanism.** The AI SDK sends each tool's full Zod
   schema (parameter names, enum values, per-field descriptions) to the model on every turn as
   part of standard tool-calling — this is not new plumbing, it already happens for the 8 existing
   tools. Once §3's expanded, family-scoped tools exist, their schemas — enum values pulled
   directly from `packages/diagram-core`'s own exported types (`NodeShape`, `ClassMember['kind']`,
   `DiagramEdge['umlRelationKind']`, etc.) rather than a hand-copied list — *are* FR-005's
   single source of truth. Widening a family's shape enum or relationship-kind union in
   `diagram-core` and re-exporting it into a tool's Zod schema is the same act as updating what the
   model is told; there is no second copy to forget.
2. **One short, hand-authored domain-concept primer per family** (6 total — flowchart, C4,
   sequence, ERD, UML, architecture), appended to the system prompt alongside the existing
   `describeModel()` summary. Plain-language orientation ("this is an ER diagram; entities have
   typed attributes, optionally marked PK/FK/UK; relationships carry cardinality"), not syntax —
   just enough for the model to know which of its available tools/fields are relevant to reach for.
   Kept in sync via a lightweight contract test (§5), not full generation, since 6 short paragraphs
   changing infrequently is a tractable hand-maintenance burden in a way a full literal-grammar
   dump across 6 evolving parsers is not.

**Rationale**: This is a materially smaller, more robust build than "generate full DSL grammar
prose from parser source" (the option floated in the original bead) while satisfying FR-005 more
strictly — a Zod enum literally cannot drift from itself. It also matches this repo's own
established pattern of preferring a tested contract over generated text fidelity (Constitution IV).

**Alternatives considered**: Auto-generating grammar prose by introspecting each `dsl/*.ts`
parser's regex patterns — rejected: most of the token maps/regexes involved are module-private
(not exported), several diagram types express the same concept with divergent internal
representations, and mechanically-generated prose from regex source is a poor substitute for
authored explanation with no proportionate reduction in drift risk over the tool-schema approach.
A retrieval/RAG lookup — rejected: the corpus (6 short primers) is far too small to need a
retrieval system; always-inject is simpler and cheaper.

## 3. Expanding the tool surface (Story 2, FR-003) — new `diagram-core` operations required

**Finding**: `packages/diagram-core/src/model/diagram-ops.ts` has no operation to set an ER
entity's attributes, a UML class's members, a node's `role`, an edge's `umlRelationKind`/
cardinality, or an edge's `lineStyle`/sequence-specific `arrow` values — `addNode`'s `AddNodeInput`
is `{ shape, label }` only; `addEdge`'s is `{ sourceId, targetId, label, arrow }`. These fields
already exist on `DiagramNode`/`DiagramEdge` (added across this session's `jmuir-dtu` DSL-parity
work) but have no *operation* that sets them post-creation, and no AI tool wraps them.

**Decision**: Add narrowly-scoped new `diagram-core` operations, mirroring the existing
`updateNodeStyle`/`updateEdgeStyle` precedent (canvas-kwa: a small, additive merge-patch function
per concept, not a monolithic "update everything" operation) — then wrap each as its own AI tool,
matching the 1:1 tool-per-operation pattern the existing 8 tools already establish:

| New `diagram-core` operation | New AI tool | Families |
|---|---|---|
| `updateNodeRole(model, nodeId, role)` | `setNodeRole` | C4 (person/system/container/boundary), sequence (participant/actor) |
| `updateEntityAttributes(model, nodeId, attributes)` | `setEntityAttributes` | ERD |
| `updateClassMembers(model, nodeId, members)` | `setClassMembers` | UML |
| `updateEdgeRelationKind(model, edgeId, { umlRelationKind?, sourceCardinality?, targetCardinality? })` | `setRelationshipKind` | UML |
| `updateEdgeArrowStyle(model, edgeId, { arrow?, lineStyle? })` | `setConnectorStyle` | sequence, flowchart (existing `arrow` param on `addEdge` stays for creation-time; this covers post-creation changes) |
| *(reuse existing)* `addContainer` + `assignNodeToContainer` | `groupIntoContainer` | architecture (service grouping), C4 (boundaries), UML (namespaces), sequence (boxes) — no new `diagram-core` op needed, only a new tool wrapping two existing ones together |

Sequence activation/deactivation (FR-003's remaining named concept) reuses the existing
`DiagramContainer` `role: 'activate'/'deactivate'` point-in-time-marker representation
(`jmuir-dtu.4`) via a new minimal `addPointMarkerContainer(model, { role, attachedNodeId,
sequenceOrder })` operation and a matching `activateParticipant`/`deactivateParticipant` tool pair.

**Tool availability is family-conditional, not universal** — `createDiagramTools(context, family)`
gains a `family` parameter and returns only the tools meaningful for that family (e.g.
`setEntityAttributes` is not offered at all when `family !== 'erd'`). This is both how FR-004
("decline an edit with no equivalent concept in the diagram's type") is satisfied structurally —
an out-of-family request has no matching tool to call, so the model's own text response explains
it cannot be done, per the existing not-found-reports-a-reason convention already used for
missing-id cases — and how the family-scoped grounding from §2 stays consistent with what the
model can actually do.

**Rationale**: Matches this codebase's own established precedent (canvas-kwa added
`updateNodeStyle`/`updateEdgeStyle` as new, narrow operations rather than growing `addNode`'s
schema) instead of introducing a single large "universal" tool whose relevance varies by family —
which would also undermine tool-schema-as-grounding from §2 (a universal schema can't communicate
"only architecture diagrams have groups").

**Alternatives considered**: Growing `addNode`/`addEdge`'s existing input schemas with every new
optional field — rejected: it would make every family's tool schema include irrelevant fields for
every other family, working against §2's "tool schema communicates what's actually valid" premise,
and contradicts the narrow-operation precedent already set.

## 4. Persona reference material — data model and scoping

**Decision**: New table `ai_persona_reference_material` (one row per entry, FK to `ai_personas`,
`content TEXT`, `diagram_families TEXT[]` nullable — `NULL`/empty means "applies regardless of
family," matching the Clarifications-session decision that an unscoped entry applies everywhere).
`sendChatMessage` fetches the persona's entries matching the current `dslFamily` (or unscoped) and
appends their content to the system prompt, after the family primer (§2) and the persona's own
`systemPrompt` (order: persona framing → family domain primer → persona's family-relevant
reference material → current diagram summary) — reference material never replaces or reorders
ahead of the persona's own system-prompt text (FR-008).

**Rationale**: A `TEXT[]` column keyed by the same `dslFamily` string id `registry.ts` already
uses (`'flowchart' | 'c4' | 'architecture' | 'sequence' | 'erd' | 'uml'`) needs no new vocabulary
and no join table — a persona realistically has at most a handful of entries, so a simple array
column outperforms a normalized many-to-many for this scale, consistent with Constitution VI
(no speculative generalization beyond what's needed).

**Alternatives considered**: A separate `ai_persona_reference_material_families` join table —
rejected as unwarranted normalization for a column that is genuinely small, low-cardinality, and
never queried from the "family" side (nothing ever asks "which personas have material for family
X" independent of a specific persona).

## 5. Testing approach

**Decision**: Follow 004's own established pattern exactly (research.md §8 there) — Vitest
contract tests for every new `diagram-core` operation (test-first, Constitution IV) and every new
AI tool, using `MockLanguageModelV4` from `ai/test` with per-test canned tool-call sequences (no
network, no API key, deterministic); Playwright e2e coverage for the two new/changed
diagram-editor flows (non-flowchart chat working at all; persona reference-material admin CRUD).
SC-002's "verified against at least one non-flowchart diagram type ... with a real (non-mock) AI
provider" is satisfied the same way 004's own T033 was — a manual, ad-hoc validation run against a
real configured provider immediately before shipping, documented in the PR/CLAUDE.md entry, not a
new persisted `RUN_LIVE_AI_TESTS`-gated suite (004's research.md proposed that flag but it was
never actually built; the manual-run precedent is what this codebase has actually done every time
live-provider behavior needed checking).

**Rationale**: Consistency with the one precedent this exact scenario already has, and avoiding
committing to CI secrets management for a real provider key when the manual-check precedent has
already proven sufficient once.

## 6. Diagram type → domain primer content source

**Decision**: The 6 primers are hand-authored (see data-model.md), stored as a single exported
`const` map in a new `apps/api/src/ai/diagram-type-primers.ts` (parallel to, not inside,
`diagram-tools.ts`), keyed by the same `dslFamily` id. A new contract test asserts, for each
family, that every enum value currently exposed by that family's tool set (read via each tool's
own Zod schema at test time, not hand-copied into the test) is mentioned somewhere in that family's
primer text or an accompanying per-family glossary line — catching the case where a future
`jmuir-dtu`-style grammar expansion adds a new enum value to a tool schema without a human updating
the primer's prose to match.

**Rationale**: This is the concrete mechanism that makes §2's "kept in sync, not a silently-drifting
hand copy" claim (FR-005) actually enforced rather than aspirational — a real, automated regression
guard, not a documentation promise.
