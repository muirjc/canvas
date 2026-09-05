# Feature Specification: AI Chat Diagram-Type and Persona-Scoped Knowledge Grounding

**Feature Branch**: `010-ai-diagram-knowledge`
**Created**: 2026-08-09
**Status**: Draft
**Input**: User description: "AI chat needs to give the model real diagramming knowledge grounded
in this app's actual DSL grammar, scoped per diagram type/family AND per persona (not diagram-type
alone). Today the AI chat system prompt never tells the model which diagram type it is working
with or gives it that type's actual DSL grammar/syntax rules — the model infers diagram-type
behavior purely from generic tool names/descriptions. Different personas also need access to
different external knowledge sources, not just a shared DSL syntax reference — e.g. a Technical
Architect persona would benefit from cloud-service reference material (such as Microsoft Learn
documentation) when helping build cloud-infrastructure diagrams, which a Business/Enterprise/
Solution Architect persona would not need. Whatever mechanism is chosen must have a clear story
for staying in sync with this app's own diagram grammar as it evolves, and must compose with
personas' existing admin-editable system-prompt customization rather than bypass it. Verified
against at least one non-flowchart diagram type with a real LLM provider."

## Clarifications

### Session 2026-08-09

- Q: Persona-scoped external knowledge (e.g. Microsoft Learn docs for a Technical Architect) —
  should this feature fetch live external content, or let admins attach curated reference material
  to a persona ahead of time? → A: Curated/static content only. Admins attach reference text to a
  persona ahead of time; no live network calls from the AI at chat time in this feature.
- Q: Which diagram types get AI-chat grounding in this feature's v1 — all of them, or a smaller
  named subset? → A: All 6 diagram type families this platform already supports (flowchart, C4,
  sequence, ERD, UML, architecture/cloud-infrastructure) — the grounding mechanism is data-driven
  per family, so covering all of them costs about the same as covering one once built.
- Q: AI chat's editing tools are currently generic (add/remove/rename a shape or connector, set
  style) with no way to set diagram-type-specific structure (an ER entity's attributes, a UML
  class's members, a C4 element's role, etc.) — does this feature expand those tools, or only
  improve the model's judgement within the existing generic set? → A: Expand the tools. Without
  type-specific editing capability, grounding alone cannot produce a genuinely correct non-flowchart
  diagram, since no tool call exists today that sets those fields at all.
- Q: A persona (e.g. Technical Architect) plausibly works across multiple diagram types (both
  cloud-architecture and C4) that could each want different reference material — is a persona's
  reference material a single blob always included whenever that persona is used, or can a persona
  have multiple entries, each optionally scoped to specific diagram type(s)? → A: Taggable/multiple
  entries per persona. A persona can have several reference-material entries, each optionally
  scoped to specific diagram type(s), and only the entries relevant to the diagram type currently
  open are pulled into a given conversation.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - AI chat works correctly on every diagram type, not just flowchart (Priority: P1)

An architect opens the chat panel on a diagram that is NOT a flowchart — an ER diagram, a C4
diagram, a UML class diagram, a sequence diagram, or a cloud-architecture diagram — and asks it to
make a change. Today, doing this fails outright: the chat backend always treats the diagram's
content as flowchart syntax regardless of what it actually is, so a request against any other
diagram type either errors or is silently misinterpreted. This story establishes the AI chat
correctly reads and writes each diagram's actual content, for every diagram type this platform
supports, as the precondition for everything else in this feature.

**Why this priority**: Nothing else in this feature has any value if the chat cannot even
correctly parse and save the diagram it is supposedly editing. Every other story assumes this one
is already true.

**Independent Test**: Open an existing ER diagram's chat panel, ask it to rename an entity, and
confirm the request succeeds and only that entity's name changes — with no error and no corruption
of the rest of the diagram.

**Acceptance Scenarios**:

1. **Given** an open diagram of any supported type, **When** the user sends a chat message,
   **Then** the system correctly reads that diagram's actual current content rather than
   misreading it as a different type.
2. **Given** a chat-driven edit is applied, **When** the diagram is saved, **Then** the diagram's
   type-appropriate syntax is preserved correctly and the file remains valid for that diagram
   type.
3. **Given** a diagram type the platform supports, **When** its chat panel is used for the first
   time, **Then** the request is processed the same way any flowchart chat request already is —
   no diagram type is silently excluded or degraded.

---

### User Story 2 - AI-driven edits use each diagram type's real structure, not a generic flowchart shape (Priority: P1)

Once chat can operate on any diagram type (Story 1), an architect asks it to add or change
something that only makes sense for that type — add an attribute to an ER entity, add a member to
a UML class, mark a C4 element as an external system, add an activation bar to a sequence
participant, group cloud-architecture services — and the AI actually has a way to make that exact
change, correctly, rather than falling back to a generic labeled box because no such capability
exists.

**Why this priority**: This is the actual value the feature is being built for — an architect
using AI chat on a non-flowchart diagram today gets, at best, plain labeled boxes with none of
that diagram type's real semantics, which is why the underlying bead was filed in the first place.
Tied for top priority with Story 1: together they are the smallest slice that makes AI chat
genuinely useful beyond flowchart.

**Independent Test**: On an open UML class diagram, ask the chat to "add a class Order with a
private id field and a public place() method," and confirm the resulting class shows a properly
structured member, not just a plain rectangle labeled "Order."

**Acceptance Scenarios**:

1. **Given** an open ER diagram, **When** the user asks the chat to add an attribute to an entity,
   **Then** the entity's attribute list reflects the request, in the same structured form a
   manually-added attribute would take.
2. **Given** an open UML class diagram, **When** the user asks the chat to add a class with
   members and/or a relationship to another class, **Then** the class's members and the
   relationship's kind (e.g. inheritance, composition) are set correctly, not left generic or
   dropped.
3. **Given** an open C4 diagram, **When** the user asks the chat to add a person, system, or
   container element, **Then** the new element carries the correct role for what was asked, not a
   generic shape.
4. **Given** an open sequence diagram, **When** the user asks the chat to add a message between
   participants or to activate one, **Then** the resulting message/activation matches sequence
   diagram conventions.
5. **Given** an open cloud-architecture diagram, **When** the user asks the chat to add a service
   to a group, **Then** the new service is correctly grouped, not placed as an ungrouped shape.
6. **Given** an edit that a diagram type does not support (e.g. asking a flowchart-only operation
   on a diagram type without that concept), **When** it is requested, **Then** the chat explains
   the request cannot be applied to this diagram type rather than silently applying something
   incorrect.

---

### User Story 3 - AI suggestions and generated syntax stay valid as the diagram grammar evolves (Priority: P2)

A maintainer extends one of this platform's diagram-type grammars (adding new syntax, as has
happened repeatedly for this platform's diagram types). Without any further hand-maintenance step,
AI chat's knowledge of that diagram type reflects the change — old syntax the app no longer
generates does not keep being suggested, and new syntax the app now understands is available to
the AI without someone remembering to update a second, separate copy of that knowledge by hand.

**Why this priority**: Valuable and directly named in the underlying bead's acceptance criteria,
but not blocking — Stories 1 and 2 already deliver working, correctly-grounded AI chat the day
this feature ships. This story is what keeps that correctness from silently decaying afterward.

**Independent Test**: After a diagram-type grammar gains new syntax elsewhere in the codebase (no
special action taken for this feature), confirm AI chat's grounding for that diagram type reflects
the addition without a separate manual content update.

**Acceptance Scenarios**:

1. **Given** a diagram type's grammar has changed, **When** AI chat is next used on a diagram of
   that type, **Then** its grounding reflects the current grammar, not a stale snapshot.
2. **Given** a new diagram-type grammar addition, **When** no one manually updates any
   AI-chat-specific reference content, **Then** the AI's grounding is still accurate.

---

### User Story 4 - A persona brings its own relevant reference material into the conversation (Priority: P2)

An admin attaches one or more reference-material entries to a persona, each optionally scoped to
specific diagram type(s) — for example, cloud-service reference notes on a Technical Architect
persona, scoped to cloud-architecture and C4 diagrams specifically, not to every diagram type that
persona might ever be used on. When an architect uses that persona's chat, only the entries scoped
to the diagram type currently open (plus any entries not scoped to a specific type at all) are
drawn on; a different persona without matching material, or the same persona used on a diagram
type none of its material is scoped to, does not surface it.

**Why this priority**: Real, requested value, and independently useful once Stories 1–2 exist —
but a diagram can be correctly created and edited by AI chat without persona-specific external
material, so this is additive rather than blocking.

**Independent Test**: As an admin, attach a reference-material entry scoped to cloud-architecture
diagrams to a Technical Architect persona, then start a chat on a cloud-architecture diagram using
that persona and ask a question the material answers; confirm the response reflects it. Repeat on
a diagram type that entry is not scoped to, using the same persona, and confirm it does not surface
there.

**Acceptance Scenarios**:

1. **Given** a persona with a reference-material entry scoped to the diagram type currently open,
   **When** an architect chats using that persona, **Then** the AI's responses can draw on that
   entry.
2. **Given** a persona with no reference-material entries at all, **When** an architect chats using
   it, **Then** the AI behaves exactly as it did before this feature — no unrelated material leaks
   in.
3. **Given** a persona with reference-material entries, none of which are scoped to the diagram
   type currently open, **When** an architect chats using that persona on that diagram, **Then**
   none of those entries surface — only entries scoped to that diagram type, or scoped to no
   specific type, are eligible.
4. **Given** a persona with multiple reference-material entries scoped to different diagram types,
   **When** an architect chats using that persona on one of those diagram types, **Then** only the
   entries relevant to the currently-open diagram type are drawn on, not entries scoped to a
   different diagram type.
5. **Given** an admin edits or removes one of a persona's reference-material entries, **When** that
   persona is next used, **Then** subsequent chat responses reflect the change; existing
   conversation history is unaffected, consistent with how editing a persona's system prompt
   already behaves.
6. **Given** a persona's own admin-authored system prompt already shapes how it responds, **When**
   reference-material entries also apply, **Then** both apply together — attaching material does
   not remove or override the persona's existing system-prompt customization.

### Edge Cases

- What happens when a diagram's content cannot be understood as valid syntax for its own type
  (e.g. it was hand-edited into an invalid state) before a chat request is made? The chat reports
  that the diagram could not be read, the same way an invalid flowchart is already reported today,
  and no edit is attempted.
- What happens when the AI is asked to make a diagram-type-specific edit that has no equivalent
  concept in the diagram's actual type (e.g. asking for a UML relationship kind on a flowchart)?
  The request is declined with an explanation, not silently approximated.
- What happens when a persona's attached reference material is very large? The material is scoped
  to what is relevant to the current request rather than always including all of it in full,
  consistent with keeping ordinary chat requests fast and affordable regardless of how much
  reference material a persona accumulates over time.
- What happens on a diagram type this platform does not yet support at all (outside the 6 existing
  families)? Unchanged and out of scope — this feature does not add any new diagram type.
- What happens when an architect switches which diagram is open mid-conversation? Unchanged from
  today — each diagram keeps its own independent chat conversation and grounding; nothing carries
  over between diagrams.
- What happens when two personas both have material attached and a diagram is later associated
  with a different persona than the one used originally? Consistent with existing behavior (a
  diagram's persona is fixed at its first chat message and does not change), so this does not
  arise within one diagram's conversation.
- What happens when a persona has reference-material entries, but none of them are scoped to the
  diagram type currently open (and none are scoped to "no specific type")? The AI behaves as if
  that persona had no reference material at all for that conversation — no entry surfaces just
  because the persona has some.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST correctly read and write a diagram's actual content according to its
  own real diagram type, for every diagram type this platform supports, when handling an AI chat
  request — not assume or default to any single diagram type regardless of what is actually open.
- **FR-002**: The system MUST make each diagram type's real structural vocabulary available to the
  AI as part of AI chat, for every diagram type this platform supports (flowchart, C4, sequence,
  ER, UML, and cloud-architecture) — not only the diagram type AI chat already supported before
  this feature.
- **FR-003**: The system MUST provide the AI with editing capability sufficient to correctly
  create and modify each diagram type's own distinguishing structural concepts through chat,
  including at minimum: ER entity attributes; UML class members and relationship kinds; C4 element
  roles (e.g. person, system, container, boundary); sequence diagram messages and
  activation/deactivation; and cloud-architecture service grouping.
- **FR-004**: The system MUST decline, with an explanation to the user, an edit request that has
  no equivalent concept in the diagram's actual type, rather than silently approximating it with
  an incorrect or generic substitute.
- **FR-005**: The AI's grounding in a diagram type's grammar MUST be derived from the same source
  that defines that grammar for the rest of the application, so that a change to a diagram type's
  supported syntax is reflected in AI chat's grounding without requiring a separate, independently
  maintained copy to be updated by hand.
- **FR-006**: The system MUST allow an admin to attach one or more reference-material entries to a
  persona, in addition to that persona's existing name, category, and system-prompt text, with
  each entry optionally scoped to one or more specific diagram types (an entry with no diagram-type
  scoping applies regardless of which diagram type is open).
- **FR-007**: When an architect uses a persona on a given diagram, the AI's responses MUST be able
  to draw only on that persona's reference-material entries that are scoped to the currently-open
  diagram type or scoped to no specific type — entries scoped to a different diagram type MUST NOT
  surface. A persona with no reference-material entries at all MUST behave exactly as it did before
  this feature.
- **FR-008**: A persona's reference-material entries MUST compose with its existing
  admin-authored system prompt — attaching material MUST NOT remove, replace, or bypass the
  persona's existing system-prompt customization.
- **FR-009**: Editing or removing one of a persona's reference-material entries MUST take effect
  for that persona's future chat use, without altering any diagram or chat history that already
  exists.
- **FR-010**: The system MUST restrict persona reference-material management to admin users, the
  same restriction already applied to persona creation and editing.
- **FR-011**: The system MUST apply the same access-control and governance rules to chat requests
  and their resulting edits regardless of diagram type — no diagram type receives weaker
  permission checks or validation than another.
- **FR-012**: This feature MUST NOT introduce any new diagram type; it grounds AI chat in the
  diagram types the platform already supports.
- **FR-013**: This feature MUST NOT have the AI retrieve external content over the network at chat
  time; persona-scoped external knowledge in this feature comes only from material an admin has
  attached ahead of time.

### Key Entities *(include if feature involves data)*

- **Diagram-Type Grammar Reference**: The structural/syntax knowledge the AI is given about one
  diagram type — derived from the same definitions that already govern that diagram type elsewhere
  in the application, not a separately hand-authored copy.
- **Persona Reference Material Entry**: One admin-authored piece of reference content associated
  with a persona, distinct from and additional to that persona's existing name, category, and
  system prompt. A persona may have zero or more entries. Each entry is optionally scoped to one
  or more specific diagram types; an entry with no scoping applies regardless of diagram type.
  Composes with the persona's existing system prompt rather than replacing it.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An architect can use AI chat to make a correct, type-appropriate edit on each of the
  6 diagram types this platform supports, not only flowchart.
- **SC-002**: AI-generated or AI-edited diagrams for a non-flowchart type use that type's real
  structural concepts (attributes, members, roles, relationship kinds, activation, grouping, as
  applicable) rather than generic flowchart-shaped output, verified against at least one non-flowchart
  diagram type using a real (non-mock) AI provider.
- **SC-003**: When a diagram type's supported syntax changes elsewhere in the application, AI
  chat's grounding for that diagram type reflects the change with no separate manual update step.
- **SC-004**: A persona with a reference-material entry scoped to the open diagram's type
  measurably changes the AI's responses on relevant requests compared to the same persona without
  that entry; a persona with no entries scoped to the open diagram's type behaves identically to
  how it did before this feature.
- **SC-005**: An admin can attach, edit, or remove one of a persona's reference-material entries
  and see the effect on that persona's next chat use, with no code change or redeploy required.
- **SC-006**: A chat request for an edit that does not apply to the open diagram's type is
  declined with a clear explanation in 100% of cases observed during testing, never silently
  approximated.

## Assumptions

- AI chat's diagram-type coverage in this feature extends to exactly the 6 diagram-type families
  this platform already supports (flowchart, C4, sequence, ER, UML, cloud-architecture/
  architecture) — no new diagram type is introduced, and no existing one is excluded.
- Persona-scoped external knowledge in this feature is admin-curated, static reference material
  attached ahead of time, not live retrieval from external sources at chat time; live retrieval is
  a possible future extension but is not built here.
- The existing persona system-prompt customization point, access-control model
  (view/comment/edit), governance/standards-validation behavior, and chat-conversation persistence
  are all unchanged by this feature — this feature extends what the AI knows and can do within
  those existing rules, not the rules themselves.
- A broader long-term vision for an AI diagramming assistant exists as background reading (this
  app's own internal design notes) describing ideas such as a retrieval-augmented company-standards
  knowledge base, format conversion from other tools, and diff-based diagram editing. Those ideas
  are directional inspiration only; none of them are in scope for this feature beyond what is
  explicitly required above.
- Expanding AI chat's editing tools to cover each diagram type's distinguishing structural concepts
  (FR-003) is scoped to the concepts named there; further, more advanced type-specific editing
  capability beyond that minimum set may be identified as follow-up work once this feature ships.
