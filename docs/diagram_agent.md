## Skill list for a diagramming architect-assistant agent

**Core diagramming knowledge**
- Mermaid DSL fluency across all diagram types it needs to output: flowchart, sequence, class, ER, state, C4 (via mermaid's C4 support or structured flowchart conventions), Gantt if used for roadmaps
- Mermaid syntax validation/linting — knowing what will and won't render before committing to an answer
- Diagram *type selection* — recognizing when a request calls for a sequence diagram vs. a flowchart vs. an ERD vs. a C4 diagram (this is a judgment skill, not just syntax)
- Layout/readability heuristics — subgraph grouping, direction (TD/LR) selection, avoiding crossed edges, when to split one diagram into several

**Standards and best practices**
- Company diagramming standards (naming conventions, required diagram types per artifact, approved terminology/taxonomy)
- Architecture framework alignment — C4 model levels, FINOS CALM, ArchiMate, TOGAF, whatever the org has adopted — knowing which level of abstraction a given request calls for
- Style guide enforcement — color/shape semantics if the company has conventions (e.g., "external systems are always gray")
- Versioning/change conventions — how diagrams are expected to evolve alongside specs (especially relevant if diagrams are meant to be spec-driven artifacts)

**Domain/architecture knowledge**
- Reading and interpreting existing architecture documentation to extract entities/relationships (so it can *generate* diagrams from prose, specs, or code, not just take manual instructions)
- Basic familiarity with the architecture patterns being diagrammed (microservices, event-driven, layered, hexagonal) so it asks sensible clarifying questions and doesn't misrepresent relationships
- Enough domain vocabulary (in your case: insurance/enterprise systems, Azure/Databricks primitives) to correctly categorize components when generating diagrams from technical descriptions

**Interaction and elicitation skills**
- Requirements gathering for underspecified diagram requests — knowing which questions matter (internal vs. external actors, direction of dependency, sync vs. async) rather than guessing and silently omitting details
- Incremental diagram refinement — handling "now show the auth flow" as a follow-up edit to existing mermaid source, not a from-scratch regeneration
- Diff-awareness — when editing an existing diagram, preserving unrelated parts exactly rather than regenerating and introducing drift

**Format conversion**
- Reading draw.io XML, PlantUML, Visio exports, or hand-drawn/whiteboard descriptions and converting to mermaid
- Reading source code or IaC (Terraform, ARM/Bicep) to reverse-engineer a structural diagram
- Exporting/embedding mermaid into the target surface (Markdown docs, Confluence, docx, PDF) correctly

**Quality and validation**
- Self-checking generated mermaid against a syntax validator before presenting it (catch broken syntax before the architect sees it)
- Consistency checking against company standards as a gate, not just a suggestion (ties to your existing quality-gate pattern if you're using one)
- Detecting and flagging ambiguous or incomplete input rather than fabricating relationships it wasn't told about

---

## How I'd design this agent

**1. Treat it as retrieval-augmented, not knowledge-baked-in**
Company standards and architecture patterns change; don't rely on the model's training data or a static system prompt for these. Put standards, terminology, and pattern references in a retrievable knowledge base (docs, a vector store, or even structured files) that the agent queries at generation time. This keeps the agent current without retraining or prompt bloat, and makes the standards auditable/versionable independent of the agent.

**2. Separate "understand the request" from "generate the diagram" from "validate the output"**
This is the plan/apply/validate pattern applied to diagramming:
- *Understand*: parse the request (or source doc/code) into a structured intermediate representation — entities, relationships, types, direction — before touching mermaid syntax at all.
- *Generate*: render that structured representation into mermaid syntax. Keeping this step separate from "understanding" means you can swap diagram types (flowchart vs. C4) without re-interpreting the input.
- *Validate*: run the generated mermaid through an actual parser/renderer (not just visual inspection by the LLM) to catch syntax errors, then check it against standards (naming, required elements) as a second pass.

This mirrors the determinism-isolation principle from earlier — the "does this satisfy company naming conventions" check should be deterministic code (regex/rule-based or schema-based), not the LLM re-reading its own output and hoping it's right.

**3. Use a typed intermediate schema, not raw mermaid, as the source of truth**
Define a Pydantic (or similar) schema for "diagram" — nodes with type/label/metadata, edges with direction/label/type. Generate that structured object first, validate it against standards, *then* render to mermaid as a final serialization step. Benefits:
- Standards enforcement operates on structured data (much more reliable than pattern-matching mermaid text)
- You can add other output formats later (draw.io, PlantUML, C4-JSON/CALM) as alternate serializers of the same intermediate representation
- Diagram edits become object mutations, not text surgery — much lower risk of the LLM corrupting unrelated parts of existing mermaid source

**4. Ground it in real inputs, not just conversation**
The most valuable version of this agent doesn't just take dictated instructions — it reads specs, ADRs, code, or existing diagrams and proposes the diagram. Give it tools to fetch those sources (repo access, doc search, existing diagram retrieval) rather than expecting the architect to describe the system from scratch in chat.

**5. Make company-standards compliance a hard gate, not a suggestion**
If there's a required diagram taxonomy (e.g., only certain C4 levels, mandatory legend, required subgraph structure for a given diagram type), encode that as a checklist the generated diagram must pass before being presented as "done" — analogous to your CI-enforced spec gates. Non-compliant output gets flagged and iterated on automatically before the architect ever sees it, rather than relying on the architect to catch drift.

**6. Version and diff diagrams like code**
Store mermaid source under version control alongside the specs/docs it illustrates. When the agent edits a diagram, it should output a diff against the previous version, not just a fresh block — this makes review fast and keeps a history of architectural decisions visible over time.

**7. Keep humans as final approvers, agent as the drafting/consistency layer**
The agent's job is to eliminate the tedious parts (syntax correctness, standards compliance, converting between formats, keeping diagrams in sync with specs) — not to make unreviewed architectural judgment calls. Architects should always see and approve the structured intermediate representation (or at least the rendered diagram) before it's considered final, especially for anything that becomes part of an approved architecture artifact.

**8. Instrument it for feedback**
Log which generated diagrams get manually corrected and why. That's your best signal for where the standards knowledge base is incomplete or where the LLM's diagram-type judgment needs better examples — treat corrections as training data for improving the retrieval corpus and few-shot examples, not just one-off fixes.