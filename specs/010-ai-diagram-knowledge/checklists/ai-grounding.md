# AI Grounding & Persona Reference-Material Checklist: AI Chat Diagram-Type and Persona-Scoped Knowledge Grounding

**Purpose**: Pre-implementation requirements-quality gate, focused on the two riskiest areas of
this spec — AI grounding/behavior correctness and the new persona reference-material data model —
before `/speckit.implement` begins.
**Created**: 2026-08-10
**Feature**: [spec.md](../spec.md) (see also [data-model.md](../data-model.md),
[research.md](../research.md))

**Note**: This checklist tests the REQUIREMENTS' quality (completeness, clarity, consistency,
measurability, coverage) — not whether any implementation works. Every item is a question about
what is or isn't written down.

## Requirement Completeness — AI Grounding & Behavior

- [ ] CHK001 Are requirements defined for what happens if the AI attempts a tool call with a
  parameter value outside that tool's valid set for the current family (e.g. a malformed or
  impossible enum choice), distinct from the "no equivalent concept" case FR-004 already covers?
  [Gap, Edge Case]
- [ ] CHK002 Beyond the single "at least one non-flowchart diagram type" check in SC-002, are
  there any requirements establishing a minimum behavioral proof point per diagram family, given
  the feature claims correctness across all 6? [Coverage, Spec §SC-002]
- [ ] CHK003 Does the spec define what "sufficient" editing capability means for FR-003's
  "at minimum" list — is there a stated boundary for when the named concepts are considered
  adequately covered versus needing further expansion? [Clarity, Spec §FR-003]
- [ ] CHK004 Are requirements defined for how the system behaves if a diagram's `dslFamily`
  cannot be resolved at all (as opposed to the diagram's content failing to parse, which the
  Edge Cases section does cover)? [Gap]

## Requirement Clarity — AI Grounding & Behavior

- [ ] CHK005 Is "correct, type-appropriate edit" (SC-001, SC-002) defined precisely enough that
  two reviewers would agree on a pass/fail outcome for a given AI response, or does it rely on
  subjective judgment? [Clarity, Ambiguity, Spec §SC-001]
- [ ] CHK006 Is the boundary of "no equivalent concept in the diagram's actual type" (FR-004,
  Edge Cases) precise enough to resolve borderline cases — e.g. a concept partially but not fully
  supported by a given family? [Ambiguity, Spec §FR-004]
- [ ] CHK007 FR-004 requires the decline explanation to be clear, but is any minimum content for
  that explanation specified (e.g. naming the diagram type or the requested concept), or could a
  generic refusal satisfy the letter of the requirement? [Clarity, Spec §FR-004]
- [ ] CHK008 Is "available to the AI" (FR-002) specific enough to be objectively verified, or
  could a technically-present-but-practically-unusable form of availability satisfy it as
  written? [Measurability, Spec §FR-002]

## Requirement Consistency — AI Grounding & Behavior

- [ ] CHK009 Are FR-002 ("make each diagram type's real structural vocabulary available") and
  FR-005 ("grounding MUST be derived from the same source that defines that grammar... without a
  separate hand-maintained copy") consistent about whether the vocabulary itself may ever be
  hand-authored prose (as opposed to derived), or does this leave room for a contradictory
  implementation choice? [Consistency, Spec §FR-002, §FR-005]
- [ ] CHK010 Do User Story 2's six acceptance scenarios and FR-003's five named concepts cover
  the identical set of diagram-type structural concepts, or does one list something the other
  omits? [Consistency, Spec §US2, §FR-003]

## Acceptance Criteria Quality — AI Grounding & Behavior

- [ ] CHK011 Can SC-003 ("AI chat's grounding for that diagram type reflects the change with no
  separate manual update step") be objectively verified without relying on a specific
  implementation's internal mechanism, or does verifying it require assuming how grounding is
  built? [Measurability, Spec §SC-003]
- [ ] CHK012 Is SC-006's "100% of cases observed during testing" a meaningfully bounded acceptance
  target, or does it depend entirely on how many cases testing happens to observe? [Measurability,
  Spec §SC-006]

## Scenario & Edge Case Coverage — AI Grounding & Behavior

- [ ] CHK013 Are requirements defined for a diagram-type request that is ambiguous between two
  families' concepts (e.g. a term that means one thing in UML and another in ERD), rather than
  clearly out of scope for the open family? [Gap, Edge Case]
- [ ] CHK014 Are requirements defined for the AI attempting a family-scoped tool call immediately
  after the diagram's type context changes mid-conversation (e.g. a persona/diagram association
  edge already noted) — or is this fully covered by the existing "switches which diagram is open"
  edge case? [Coverage, Spec Edge Cases]

## Requirement Completeness — Persona Reference Material

- [ ] CHK015 Is there a requirement addressing what happens when a persona has multiple
  reference-material entries that all match the currently-open diagram type — are all of them
  included, and if so is there any stated ordering or precedence among them? [Gap, Spec §FR-007]
- [ ] CHK016 Is the content format of a reference-material entry specified (plain text only,
  or something richer), given it is composed directly into the AI's system prompt? [Gap, Spec
  §FR-006]
- [ ] CHK017 Is there a stated limit — or an explicit statement that none exists — on how many
  reference-material entries a single persona may have, distinct from the per-entry size question
  already covered by the "very large" edge case? [Gap, Spec Edge Cases]
- [ ] CHK018 Are requirements defined for whether an architect using the chat can tell that a
  response drew on persona-specific reference material, or is this intentionally invisible to
  them? [Gap]

## Requirement Clarity — Persona Reference Material

- [ ] CHK019 Is "very large" (Edge Cases, reference-material size) quantified, or left to
  implementation judgment about what counts as large enough to require scoping/truncation?
  [Clarity, Ambiguity, Spec Edge Cases]
- [ ] CHK020 Is "relevant to the current request" (Edge Cases, how oversized material is scoped)
  specific enough to be verified, or does it depend on an unstated relevance-determination
  mechanism? [Clarity, Ambiguity, Spec Edge Cases]

## Requirement Consistency — Persona Reference Material

- [ ] CHK021 Are the Key Entities description of *Persona Reference Material Entry* and FR-006's
  requirement text consistent about whether an entry may be scoped to more than one diagram type
  at once (both say "one or more"), and does every acceptance scenario in User Story 4 actually
  exercise the multi-family-per-entry case, or only the single-family and unscoped cases? [Consistency,
  Coverage, Spec §Key Entities, §FR-006, §US4]

## Dependencies & Assumptions — Persona Reference Material

- [ ] CHK022 Is the assumption that diagram-type family ids (`flowchart`/`c4`/`architecture`/
  `sequence`/`erd`/`uml`) are stable identifiers that will never be renamed or removed — which
  entry scoping implicitly depends on — stated anywhere, or only implied? [Assumption, Gap]
- [ ] CHK023 Is it documented that reference-material entries follow the same trust level as a
  persona's existing system-prompt text (admin-authored, not further sanitized/validated for
  content beyond non-emptiness and family-id validity), or is this left for an implementer to
  assume either way? [Assumption, Spec §FR-006]

## Notes

- Check items off as completed: `[x]`
- Add findings inline (e.g. "Resolved — see spec.md FR-00X update" or "Deferred to plan, out of
  spec scope by design").
- Items are numbered sequentially (CHK001–CHK023) for easy reference.
