# Data Model: AI-Assisted Diagram Chat

Extends 001's schema (`specs/001-diagramming-platform/data-model.md`) with four new tables and
two new `packages/diagram-core` model operations. See research.md §4 for why the new persona
entity is named `AiPersona`/`ai_personas` rather than bare `Persona`, avoiding collision with the
existing, unrelated `users.personas`/`diagram_types.personas` architect-category-tag columns.

## AiPersona (new table: `ai_personas`)

| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| name | text | Admin-authored display name (FR-001). |
| category | text | One of `Business`, `Enterprise`, `Solution`, `Technical` — reuses the exact same four values as the existing `diagram_types.personas`/`users.personas` arrays, for vocabulary consistency (FR-001). |
| systemPrompt | text | Admin-authored system prompt text (FR-001, FR-006). |
| status | text | `active` or `archived` (FR-003). Archiving never deletes the row — existing `DiagramChat`s referencing it are unaffected (FR-003, edge case). |
| createdAt / updatedAt | timestamptz | |

**Validation**: `category` MUST be one of the four values above. More than one `AiPersona` may
share a `category` (FR-004). Only `active` personas are offered in the "Create via AI Chat"
persona-selection dropdown (FR-003); `archived` ones remain fully valid foreign-key targets for
existing `DiagramChat` rows.

## DiagramChat (new table: `diagram_chats`)

| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| diagramId | UUID FK → `diagrams.id`, **UNIQUE** | One conversation per diagram, for its whole life (FR-008b) — the unique constraint is what makes this a single shared thread rather than one of several. |
| personaId | UUID FK → `ai_personas.id`, nullable | Set once, at creation, from whichever persona was selected in "Create via AI Chat" (FR-008a). Null for a diagram created by import or by hand, whose chat panel then operates with no persona framing (research.md's read of FR-008a). Immutable after creation — no update path is exposed for this field. |
| createdAt | timestamptz | |

**Lifecycle**: Created either explicitly by the "Create via AI Chat" flow (with a `personaId`) or
implicitly the first time any user opens a diagram's chat panel and sends a message on a diagram
that has no `DiagramChat` row yet (with `personaId` null). Never deleted while its diagram exists;
follows the diagram's own soft-delete state (no independent lifecycle).

## ChatMessage (new table: `chat_messages`)

| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| diagramChatId | UUID FK → `diagram_chats.id` | |
| role | text | `user` or `assistant`. |
| content | text | The natural-language message shown in the chat panel (FR-015). |
| toolCalls | jsonb, nullable | For `assistant` messages: which tool calls (if any) were made and their outcome (applied / not-found — research.md §6), for transparency and to reconstruct "what changed" without re-deriving it from DSL diffs. Null for `user` messages. |
| createdAt | timestamptz | Determines display order (FR-015, Story 4). |

**Access**: Readable/writable by any user with at least `edit` access to the parent diagram
(FR-016) — reuses the existing `requireDiagramAccess('edit')` middleware, no new access-control
concept (FR-008b: shared thread, so no per-user filtering either).

## AiSettings (new table: `ai_settings`, singleton)

| Field | Type | Notes |
|---|---|---|
| id | boolean PK, `CHECK (id)` | Singleton-row pattern — exactly one row can ever exist. |
| chatEnabled | boolean | Platform-wide AI chat on/off (FR-020). Defaults to `false` on a fresh install — an admin must deliberately turn it on, consistent with introducing a new external data flow (research.md §5) rather than defaulting to "on." |
| updatedAt | timestamptz | |

**Access**: Read by every chat-related route (creation, message-sending) to short-circuit with a
clear error when disabled; write restricted to admins (FR-017's admin-only pattern extended to
this control).

## `packages/diagram-core` model operations (new, extends 002's `diagram-ops.ts`)

Not persisted entities — pure functions over the existing in-memory `DiagramModel`, used
identically by the canvas's manual "Add Shape"/connect-mode UI and by the AI tool-calling layer
(research.md §1, §2):

- **addNode(model, { shape, label? }) → DiagramModel**: appends a new node with an
  auto-computed grid position (same layout rule `Canvas.tsx`'s current inline logic uses) and the
  given `label`, defaulting to `"New Node"` if omitted — matching today's manual "Add Shape"
  button behavior exactly.
- **addEdge(model, { sourceId, targetId, label? }) → DiagramModel**: appends a new edge between
  two existing node ids, with an optional label.

## Entity Relationship Summary (delta)

```
AiPersona (1) ──── (0..1) DiagramChat (1) ──── (0..*) ChatMessage
Diagram   (1) ──── (0..1) DiagramChat
AiSettings — singleton, no relationships
```

No changes to the `Diagram`, `User`, or `DiagramType` entities — `AiPersona` is additive and
deliberately does not touch the pre-existing `personas` columns on either (research.md §4).
