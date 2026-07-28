# Feature Specification: AI-Assisted Diagram Chat

**Feature Branch**: `004-ai-diagram-chat`
**Created**: 2026-07-26
**Status**: Draft
**Input**: User description: "Add an AI-assisted, natural-language interface for creating and
editing diagrams, layered on top of the existing platform. A user selects a persona from a
dropdown before starting a chat — each persona is admin-managed, tagged to one of the platform's
four existing architect categories (Business/Enterprise/Solution/Technical), and carries an
admin-authored system prompt describing the expertise/framing the AI should adopt. Multiple
personas may exist per category. Creation: a new 'Create via AI Chat' entry point lets the user
pick a persona, describe the diagram they want, and have the AI generate an initial diagram that
opens in the canvas editor. Editing: a persistent chat panel in the diagram editor lets the user
continue describing changes; the AI applies these as targeted, minimal edits rather than
regenerating the whole diagram, preserving manual positioning/styling. Admin: a new admin screen
manages personas — create/edit/archive. Scope: flowchart diagrams only for this feature; other
diagram types are explicit follow-up work. LLM access is provider-configurable (Anthropic and
OpenAI). Chat history persists per-diagram. Out of scope: simultaneous multi-provider use per
conversation, voice input, and any diagram type beyond flowchart."

## Clarifications

### Session 2026-07-26

- Q: Once a diagram exists, does its chat panel keep using the persona chosen at creation for every future edit request, or can persona selection happen again for later editing sessions? → A: Persona is chosen once at creation and fixed for that diagram's entire chat history; the edit-time panel just uses it, no re-prompt.
- Q: When a diagram has multiple collaborators with edit access, do they all see and continue the same chat conversation, or does each user get their own private conversation with the AI for that diagram? → A: Single shared conversation per diagram — every collaborator with access sees the same thread and can continue it.
- Q: Beyond configuring which AI provider to use, should there be an explicit admin-level control to enable/disable AI chat entirely, or is an unconfigured provider a sufficient off-switch? → A: Add an explicit admin-level on/off control for AI chat, independent of provider configuration.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Create a flowchart diagram from a natural-language description (Priority: P1)

An architect picks "Create via AI Chat," selects a persona matching the kind of diagram they need
(e.g., a Business Architect persona for a capability map), describes what they want in plain
language, and gets back a populated flowchart diagram open in the canvas editor — ready to
review, adjust, or keep refining through chat.

**Why this priority**: This is the core value of the feature — going from a description to a
usable diagram without hand-drawing every shape and connector first. Every other story in this
feature builds on a diagram that already exists.

**Independent Test**: Select a persona, type a description of a simple process (e.g., "an order
comes in, gets validated, then either approved or rejected"), and confirm a flowchart diagram
with corresponding shapes and connectors opens in the canvas editor.

**Acceptance Scenarios**:

1. **Given** the main screen, **When** the user chooses "Create via AI Chat," **Then** they are
   prompted to select a persona before the chat can begin.
2. **Given** a persona is selected, **When** the user describes a diagram in natural language,
   **Then** the AI responds with a diagram whose shapes and connectors reflect that description,
   opened directly in the canvas editor.
3. **Given** the generated diagram is open, **When** the user inspects it, **Then** every shape
   and connector the AI created is a normal, fully editable element — no different from one
   created by hand.

---

### User Story 2 - Refine an open diagram through natural-language chat (Priority: P2)

While a diagram is open — however it was created — the architect describes a change in plain
language ("add a shape for the fraud-check step, between validation and approval") and the
requested shapes/connectors are added, removed, or relabeled accordingly, without disturbing
anything else about the diagram.

**Why this priority**: This is what makes the feature useful beyond a one-shot generator — an
architect can keep an existing, partly hand-tuned diagram and layer natural-language changes on
top of it without starting over.

**Independent Test**: Open any existing flowchart diagram (created via chat, import, or by hand),
manually move a couple of shapes, then ask the chat to add a new shape and connector; confirm the
new elements appear correctly and the manually-moved shapes stay exactly where they were left.

**Acceptance Scenarios**:

1. **Given** an open flowchart diagram, **When** the user asks the chat to add a shape and
   connect it to an existing one, **Then** the new shape and connector appear, and every
   pre-existing element's position, label, and styling is unchanged.
2. **Given** an open flowchart diagram, **When** the user asks the chat to remove or rename a
   specific shape or connector, **Then** only that element is affected.
3. **Given** the user has just manually repositioned or restyled a shape, **When** they make an
   unrelated chat-driven edit, **Then** the manual positioning/styling is preserved.
4. **Given** an open diagram, **When** the user alternates between dragging shapes on the canvas
   and issuing chat requests, in any order, **Then** both kinds of edits apply correctly and
   neither undoes the other.
5. **Given** a chat request that names a shape or connector no longer present in the diagram,
   **When** it is submitted, **Then** the chat reports that the referenced element cannot be
   found, and the diagram is left unchanged.

---

### User Story 3 - Admin manages the persona library (Priority: P3)

An admin creates, edits, and archives personas that appear in the chat's persona-selection
dropdown — each with a name, an architect-category tag, and the system-prompt text that shapes
how the AI responds when that persona is selected.

**Why this priority**: Without at least one persona, the chat feature (Stories 1–2) has nothing
to offer in the selection dropdown; ongoing curation of the persona library is what keeps the
feature useful as the organization's needs evolve, but a small seeded set (one per architect
category) makes Stories 1–2 usable before any admin curation happens — see Assumptions.

**Independent Test**: As an admin, create a new persona tagged to a category with a custom system
prompt, confirm it appears in the chat's persona dropdown, then archive it and confirm it no
longer appears for new chats.

**Acceptance Scenarios**:

1. **Given** the admin persona screen, **When** an admin creates a persona with a name, category,
   and system prompt, **Then** it appears in the chat's persona dropdown, grouped under its
   category.
2. **Given** an existing persona, **When** an admin edits its name, category, or system prompt,
   **Then** subsequent chat sessions using that persona reflect the change.
3. **Given** a category already has one persona, **When** an admin creates a second persona
   tagged to the same category, **Then** both appear as distinct options under that category.
4. **Given** an existing persona, **When** an admin archives it, **Then** it no longer appears in
   the dropdown for new chats, but diagrams/chat history that already used it are unaffected.
5. **Given** a non-admin user, **When** they attempt to reach the persona admin screen, **Then**
   access is denied, consistent with the platform's existing admin-only screens.

---

### User Story 4 - Resume a diagram's prior chat conversation (Priority: P4)

An architect reopens a diagram they previously created or edited via chat and sees the full prior
conversation, so they can pick up where they left off instead of losing that context.

**Why this priority**: A quality-of-life addition on top of Stories 1–2 — valuable, but the
create/edit capability itself delivers the feature's core value even before conversations persist
across sessions.

**Independent Test**: Create a diagram via chat, close it, reopen it later, and confirm the
earlier conversation is still visible in the chat panel.

**Acceptance Scenarios**:

1. **Given** a diagram with prior chat activity, **When** the user reopens it, **Then** the chat
   panel shows the complete prior conversation for that diagram.
2. **Given** a diagram with no prior chat activity (created by hand or import), **When** the user
   opens its chat panel for the first time, **Then** it starts as an empty conversation.

### Edge Cases

- What happens when a chat message doesn't correspond to any diagram creation or edit request
  (e.g., a general question)? The AI responds conversationally without changing the diagram.
- What happens when the configured AI provider is unreachable or returns an error? The chat
  reports the failure to the user, and the diagram is left exactly as it was — no partial edit is
  applied.
- What happens when a chat-driven edit would make the diagram non-compliant with its assigned
  standard? The same as a manual edit today — the change is applied and the violation is flagged,
  not silently blocked or silently allowed without notice.
- What happens when a persona used by an in-progress chat session is archived mid-conversation?
  The session continues using that persona's prompt as already loaded; only new sessions lose the
  option to pick it.
- What happens when a user without edit access to a diagram tries to use its chat panel? The
  request is denied, consistent with the platform's existing view/comment/edit permission model.
- What happens when two people have the same diagram open at once and one makes a chat-driven
  edit? The same as today's manual-edit behavior — this feature introduces no new real-time
  collaboration guarantees.
- What happens when two different collaborators send chat messages to the same diagram? Both
  appear in one shared, chronological conversation visible to everyone with access to it —
  consistent with the diagram itself already being a single shared artifact.
- What happens to a diagram's existing chat history if an admin disables AI chat platform-wide?
  It remains visible (read-only) in the editor; no new messages can be sent until AI chat is
  re-enabled.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Admins MUST be able to create a persona with a name, an architect-category tag
  (Business, Enterprise, Solution, or Technical), and system-prompt text.
- **FR-002**: Admins MUST be able to edit an existing persona's name, category, and system-prompt
  text.
- **FR-003**: Admins MUST be able to archive a persona, removing it from the persona-selection
  dropdown for new chat sessions without deleting or altering any diagram or chat history that
  already references it.
- **FR-004**: The system MUST allow more than one persona to exist under the same architect
  category.
- **FR-005**: The system MUST provide a "Create via AI Chat" entry point, alongside the existing
  diagram-creation and import entry points, and MUST require a persona to be selected before a
  chat session can begin.
- **FR-006**: The system MUST let the user describe, in natural language, the diagram they want,
  and MUST frame the AI's behavior using the selected persona's system prompt.
- **FR-007**: The system MUST generate an initial flowchart diagram from the conversation and open
  it directly in the existing canvas editor.
- **FR-008**: The system MUST provide a persistent chat panel within the diagram editor for every
  diagram, regardless of how it was created, allowing continued natural-language requests.
- **FR-008a**: The persona associated with a diagram at creation MUST remain fixed for that
  diagram's entire chat history — the editor's persistent chat panel MUST use that same persona
  for every later edit request, without prompting the user to choose one again. A diagram created
  by import or by hand (with no persona chosen at creation) has no persona; its chat panel
  operates without one.
- **FR-008b**: A diagram's chat conversation MUST be a single shared thread, visible to and
  continuable by every user who has at least edit-level access to that diagram — the system MUST
  NOT maintain separate per-user chat histories for the same diagram.
- **FR-009**: The system MUST apply chat-driven edit requests as targeted operations — adding a
  shape, removing a shape, renaming a shape's or connector's label, adding a connector, or
  removing a connector — against the diagram's current state, rather than regenerating the whole
  diagram from scratch.
- **FR-010**: The system MUST leave every diagram element not addressed by a given chat-driven
  edit request unchanged, including its position, style, and label.
- **FR-011**: The system MUST allow the user to freely alternate between direct canvas edits and
  chat-driven edits on the same diagram, in any order, without either kind of edit undoing the
  other.
- **FR-012**: The system MUST apply the same governance and validation to chat-driven edits as to
  manually-made edits (e.g., standards-compliance flagging), with no bypass specific to chat.
- **FR-013**: The system MUST respond conversationally, without altering the diagram, when a chat
  message does not correspond to a recognizable creation or edit request.
- **FR-014**: The system MUST inform the user, via the chat, when a requested edit cannot be
  applied (e.g., it references an element that no longer exists, or the AI provider is
  unavailable), and MUST NOT leave the diagram in a partially-edited state when this happens.
- **FR-015**: The system MUST persist the full chat conversation for a diagram and MUST display
  that prior conversation when the diagram is reopened.
- **FR-016**: The system MUST restrict chat-driven editing of a diagram to users who already have
  edit-level access to it — the same requirement as direct canvas editing.
- **FR-017**: The system MUST restrict persona create/edit/archive actions to admin users.
- **FR-018**: The system MUST support selecting, via configuration, which supported AI provider
  (at minimum Anthropic and OpenAI) services chat requests, without requiring a code change to
  switch providers.
- **FR-019**: This feature's diagram creation/editing capability MUST be scoped to flowchart
  diagrams only; other diagram types are out of scope.
- **FR-020**: The system MUST provide an admin-level control to enable or disable AI chat
  availability platform-wide, independent of and in addition to which AI provider is configured.
  When disabled, the "Create via AI Chat" entry point and every diagram's chat panel MUST be
  unavailable to all users, regardless of provider configuration — this is a distinct governance
  control, not merely the absence of a configured provider.

### Key Entities *(include if feature involves data)*

- **Persona**: An admin-authored AI framing — a name, an architect-category tag, system-prompt
  text, and an active/archived status. Selected by the user at the start of a chat session.
- **Diagram Chat Conversation**: The ongoing exchange of messages associated with one diagram —
  a single thread shared by every collaborator with edit access to that diagram, not a per-user
  history — including which persona (if any) was used to start it, set once at creation and
  fixed for the life of the diagram (see Clarifications).
- **Chat Message**: A single turn in a conversation — either the user's natural-language request
  or the AI's response — along with a record of what, if any, diagram edit resulted from it.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user can go from a written description to a populated, on-canvas flowchart
  diagram within a single conversational exchange for straightforward diagrams.
- **SC-002**: An admin can add a new persona and have it selectable in the chat dropdown
  immediately, with no deployment or restart required.
- **SC-003**: Manual positioning, styling, and labeling changes a user has made are never altered
  or lost by a subsequent chat-driven edit that doesn't address them.
- **SC-004**: Every chat-driven edit that references existing diagram elements either applies
  correctly or is reported back to the user as unable to apply — none silently fail or silently
  corrupt the diagram.
- **SC-005**: Reopening any diagram shows its complete prior chat conversation, if one exists.
- **SC-006**: Switching the AI provider used for chat requests requires only a configuration
  change, not a code change.
- **SC-007**: An admin can disable AI chat platform-wide and have it take effect immediately for
  all users, without a code change or redeploy.

## Assumptions

- Creating a diagram via chat and editing one via chat share the same underlying targeted-edit
  mechanism — "creation" is simply the first turn of editing against a new, empty flowchart
  diagram. There is no separate, one-shot generation pipeline distinct from ongoing editing.
- The "Create via AI Chat" entry point requires the same upfront project placement and diagram
  naming context that the existing "New Diagram" flow already requires, for consistency.
- A small set of personas (at least one per architect category) ships pre-seeded, so Stories 1–2
  are usable before any admin has created a persona — consistent with how the platform's diagram
  types and default standards were seeded rather than requiring admin setup first.
- This feature's chat-editable operations are scoped to what's named in FR-009 (add/remove a
  shape, add/remove a connector, rename a shape's or connector's label). Repositioning, styling,
  grouping, and container edits via chat are out of scope for this feature; the existing manual
  canvas tools remain the way to do these until a future feature extends chat's editing scope.
- Standards validation, sharing/permission levels, and soft-delete behavior are unchanged and
  apply identically whether an edit originates from the canvas or from chat.
- No new real-time collaboration behavior is introduced; concurrent editing of the same diagram
  from different sessions behaves exactly as it already does today. Real-time multi-cursor
  co-editing remains out of scope for the platform as a whole, not just this feature.
- Rate limiting, per-user AI usage quotas, and cost controls for AI provider calls are not
  addressed by this feature; they are deferred as a future operational concern.
- No new diagram types are introduced by this feature — scope is strictly the AI chat capability
  applied to the existing flowchart diagram type.
