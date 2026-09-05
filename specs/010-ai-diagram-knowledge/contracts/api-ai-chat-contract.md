# Contract: AI Chat Diagram-Type and Persona-Scoped Knowledge Grounding (extends 004's `api-ai-chat-contract.md`)

## Diagram chat — no route/path change, behavior change only (FR-001, FR-002, FR-003, FR-004)

`POST /diagrams/:id/chat/messages` and `GET /diagrams/:id/chat/messages` keep their existing
paths, request/response shapes, and access requirements from 004. The internal behavior change:

- The route handler now calls the existing `getDiagram(id)` before `sendChatMessage`, and passes
  its `dslFamily` through — `sendChatMessage` no longer hardcodes `getDslFamily('flowchart')`
  (research.md §1). A diagram whose `dslFamily` has no registered family (should be unreachable in
  practice, since every diagram's `diagramTypeId` is validated at creation) surfaces the same 422
  `DslParseError` path already used for unparseable `currentDslContent`.
- `createDiagramTools` is now called with the diagram's `dslFamily`, returning a family-scoped
  tool set (data-model.md) instead of the fixed 8-tool set every family previously received
  regardless of relevance.
- The system prompt composition order becomes: persona's own `systemPrompt` (or
  `DEFAULT_SYSTEM_PROMPT`) → that family's domain-concept primer (data-model.md) → the persona's
  reference-material entries scoped to that family or unscoped → `describeModel()`'s existing
  current-diagram summary. Persona reference material is never included ahead of or in place of
  the persona's own `systemPrompt` (FR-008).
- `ToolCallOutcome`'s shape is unchanged; the new tools (`setNodeRole`, `setEntityAttributes`,
  `setClassMembers`, `setRelationshipKind`, `setConnectorStyle`, `groupIntoContainer`,
  `activateParticipant`, `deactivateParticipant`) report outcomes the same
  `{ tool, applied, reason? }` way the existing 8 do.
- FR-004 ("decline an edit with no equivalent concept in the diagram's type"): satisfied by tool
  availability itself being family-scoped — there is no code path where, e.g., `setClassMembers` is
  offered to the model on a flowchart diagram, so the model's own natural-language response is what
  reports it cannot be done (no new "unsupported operation" tool or error code is introduced).

## Persona reference-material administration (new, admin-only, FR-006, FR-009, FR-010)

Extends 004's persona administration surface. Error shape consistent with the rest of this API:
`{ error: string }`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/admin/ai-personas/:id/reference-material` | Lists every reference-material entry for a persona, admin-only. |
| POST | `/admin/ai-personas/:id/reference-material` | Creates an entry: `{ content: string, diagramFamilies?: string[] }`. `content` MUST be non-empty (400 otherwise); each value in `diagramFamilies`, if given, MUST be one of the 6 registered `dslFamily` ids (400 listing the invalid value(s) otherwise, mirroring `InvalidPersonaCategoryError`'s existing message convention). Omitted/empty `diagramFamilies` means the entry is unscoped (applies to every family). |
| PATCH | `/admin/ai-personas/:personaId/reference-material/:entryId` | Edits `content`/`diagramFamilies` on an existing entry (FR-009). 404 if the entry doesn't exist or doesn't belong to `personaId`. |
| DELETE | `/admin/ai-personas/:personaId/reference-material/:entryId` | Removes an entry (FR-009). 404 if it doesn't exist. Existing diagram/chat history referencing that persona is unaffected — matches 004's `archivePersona` precedent of never retroactively altering past chat turns. |

No public (non-admin) endpoint is added for reference material — unlike `GET /ai-personas`
(persona list, needed for the chat picker), an architect never reads reference-material entries
directly; they only ever affect chat responses indirectly, per FR-006/FR-010's admin-only scope.

## Effect on existing endpoints

`GET /ai-personas` and the persona CRUD routes from 004 are unchanged. `GET /diagrams/:id`,
`saveDiagram`, standards validation, and sharing/access-control remain untouched — this feature
only changes what AI chat knows and can do within the existing edit pipeline, per the spec's own
Assumptions section.
