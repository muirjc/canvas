# Quickstart: AI Chat Diagram-Type and Persona-Scoped Knowledge Grounding

Builds on `specs/004-ai-diagram-chat/quickstart.md` — same one-time AI-provider setup and admin
enable toggle apply here unchanged.

## One-time setup

```bash
npm install
npm run build --workspace=@canvas/diagram-core     # picks up the new update*/addPointMarkerContainer ops
npm run migrate --workspace=@canvas/api             # applies ai_persona_reference_material
```

## Manual validation by user story

### US1 — AI chat works correctly on every diagram type

1. Open an existing (or newly created) ER diagram. Open its chat panel.
2. Ask the chat to rename an entity. Confirm the request succeeds — no error, only that entity's
   name changes.
3. Repeat on a C4, sequence, UML, and cloud-architecture diagram — each with a trivial request
   (rename an element). Confirm none error and none corrupt the rest of the diagram.
4. Save each diagram after its chat edit; reopen it and confirm the diagram's own syntax is still
   valid for its type (the DSL panel shows correctly-typed content, not flowchart syntax).

### US2 — AI-driven edits use each diagram type's real structure

1. On an ER diagram, ask the chat: "add an attribute called email, type string, to the Customer
   entity." Confirm the entity's attribute list — not just its label — reflects the request.
2. On a UML class diagram, ask: "add a class Order with a private id field and a public place()
   method, related to Customer by composition." Confirm the class has real structured members and
   the relationship's kind is composition, not a plain connector.
3. On a C4 diagram, ask to add a person and a container; confirm each carries the correct role.
4. On a sequence diagram, ask to add a message between two participants and to activate one of
   them; confirm both match sequence-diagram conventions.
5. On a cloud-architecture diagram, ask to add a service to an existing group; confirm it is
   correctly grouped, not left ungrouped.
6. On a flowchart, ask for something that only makes sense in UML (e.g. "make this an inheritance
   relationship"); confirm the chat explains it can't be done here rather than silently applying
   something incorrect.

### US3 — Grounding stays valid as the grammar evolves (spot-check, not a full regression)

1. Confirm (by reading `apps/api/src/ai/diagram-type-primers.ts` and the tool schemas it
   accompanies) that no diagram-type vocabulary is duplicated by hand anywhere else in the AI-chat
   code path outside that one file plus the tool Zod schemas themselves.
2. Run the contract test from research.md §6 (drift guard) and confirm it passes.

### US4 — Persona reference material

1. As an admin, open the persona admin screen and attach a reference-material entry to a Technical
   Architect persona, scoped to `architecture`.
2. Start a chat on a cloud-architecture diagram using that persona; ask a question the entry
   answers. Confirm the response reflects it.
3. Start a chat on a flowchart using the *same* persona; ask the same question. Confirm the entry
   does not surface (it's scoped to `architecture`, not `flowchart`).
4. Repeat with a persona that has no entries at all; confirm behavior is unchanged from before this
   feature.
5. Edit the entry's content; start a new chat and confirm the change is reflected. Existing chat
   history for that persona is unaffected.
6. As a non-admin user, confirm the reference-material admin controls are not reachable.

## Test commands

```bash
npm run build --workspace=@canvas/diagram-core
npm run test --workspace=@canvas/diagram-core       # new update*/addPointMarkerContainer op contract tests
npm run test --workspace=@canvas/api                # family-scoped tool contract tests, reference-material CRUD (needs Postgres running)
npm run test:e2e --workspace=@canvas/web            # non-flowchart chat + reference-material admin E2E specs
```

All of the above run against the AI SDK's mock test provider — no API key, no real network call.
SC-002's real-provider verification is a manual pre-release check (research.md §5, following 004's
own T033 precedent), not a persisted CI-gated suite: with a real provider configured, exercise US2
step 1 or 2 above directly against the running app and confirm the generated structure is correct.
