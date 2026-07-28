# Contract: AI Persona & Diagram Chat API (new — `apps/api/src/ai`)

Builds on the existing diagram/auth surface from `specs/001-diagramming-platform/contracts/`.
Error shape consistent with prior features: `{ error: string }`, with `{ error, details }` for
structured validation failures.

## Persona administration (admin-only, FR-001–FR-004, FR-017)

| Method | Path | Purpose |
|---|---|---|
| GET | `/admin/ai-personas` | Lists all personas (active and archived), admin-only. |
| POST | `/admin/ai-personas` | Creates a persona: `{ name, category, systemPrompt }`. `category` MUST be one of `Business`/`Enterprise`/`Solution`/`Technical` (400 otherwise). |
| PATCH | `/admin/ai-personas/:id` | Edits `name`/`category`/`systemPrompt` on an existing persona (FR-002). 404 if the persona doesn't exist. |
| POST | `/admin/ai-personas/:id/archive` | Sets `status = 'archived'` (FR-003). Idempotent — archiving an already-archived persona is a no-op success. Does not affect any `DiagramChat` already referencing it. |
| GET | `/ai-personas` | Lists **active** personas only, grouped by category — the source for the chat's persona-selection dropdown (FR-005). Available to any authenticated user (not admin-only — every architect needs to see this list to start a chat). |

## Platform AI-chat toggle (admin-only, FR-020)

| Method | Path | Purpose |
|---|---|---|
| GET | `/admin/ai-settings` | Returns `{ chatEnabled: boolean }`. |
| PATCH | `/admin/ai-settings` | Sets `{ chatEnabled: boolean }` (FR-020). Takes effect immediately for all users (SC-007) — every chat-related route below checks this on each request, not a cached/startup-time value. |

## Diagram chat (FR-005–FR-016)

| Method | Path | Purpose |
|---|---|---|
| POST | `/diagrams/:id/chat/messages` | Sends a chat message for a diagram. Requires `edit`-level access to the diagram (`requireDiagramAccess('edit')`, FR-016) and `chatEnabled = true` (503 with a clear message if disabled). Request: `{ message: string, currentDslContent: string, personaId?: string }` — `personaId` is required and only accepted on the **first** message for a diagram with no existing `DiagramChat` row (creates one, FR-008a); omitted/ignored on every subsequent message, which reuses the `DiagramChat`'s already-fixed `personaId`. Response: `{ assistantMessage: string, updatedDslContent: string, toolCalls: ToolCallOutcome[] }` where `updatedDslContent` reflects every successfully-applied tool call (research.md §3) and is unchanged from `currentDslContent` if none were. |
| GET | `/diagrams/:id/chat/messages` | Returns the full message history for the diagram's `DiagramChat`, oldest first (FR-015, Story 4). Empty list (not 404) for a diagram with no chat activity yet. Same `edit`-level access requirement. |

**`ToolCallOutcome` shape**: `{ tool: string, applied: boolean, reason?: string }` — `applied:
false` with a `reason` (e.g., `"No shape named 'X' was found"`) is how FR-014's "cannot apply, no
partial edit" requirement is represented in the response; `applied: true` entries are what
`updatedDslContent` reflects.

**Errors**:
- 401/403 — unauthenticated, or insufficient diagram access (existing `requireDiagramAccess`
  behavior).
- 503 — AI chat is administratively disabled (FR-020) or the configured provider is unreachable
  (edge case) — distinct messages for each, so the user isn't told "disabled" when the real cause
  is a provider outage.
- 422 — `currentDslContent` fails to parse (shouldn't happen in normal use since the client only
  ever sends its own valid live state, but guarded rather than assumed).

## Effect on existing endpoints

None. `GET /diagrams/:id`, `saveDiagram`, standards validation, and sharing/access-control are
all unchanged — chat-driven edits reach them exactly the way manual edits already do, via the
existing client-side "unsaved state → Save button → `saveDiagram`" path (research.md §3).
