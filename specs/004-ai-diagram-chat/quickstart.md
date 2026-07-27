# Quickstart: AI-Assisted Diagram Chat

Builds on `specs/001-diagramming-platform/quickstart.md`. New setup step: an AI provider must be
configured (`apps/api/.env`) and AI chat must be enabled via the admin toggle before any of this
is testable — see below.

## One-time setup

```bash
# apps/api/.env additions:
AI_PROVIDER=anthropic          # or: openai
ANTHROPIC_API_KEY=sk-...       # (or OPENAI_API_KEY=... if AI_PROVIDER=openai)
```

```bash
npm install                                       # pulls in the ai/@ai-sdk/* packages
npm run build --workspace=@canvas/diagram-core     # picks up the new addNode/addEdge ops
npm run migrate --workspace=@canvas/api            # applies the new ai_personas/diagram_chats/chat_messages/ai_settings tables
npm run seed --workspace=@canvas/api               # seeds one default AiPersona per architect category
```

As an admin, turn AI chat on: `?admin=ai-settings` → toggle "Enable AI Chat" (FR-020). Without
this, every chat action below returns a clear "AI chat is currently disabled" message rather than
silently failing.

## Manual validation by user story

### US1 — Create a flowchart diagram from a natural-language description

1. From the main screen, choose "Create via AI Chat."
2. Confirm you're required to pick a persona before the chat opens (FR-005).
3. Pick a Business Architect persona, describe a simple process ("an order comes in, gets
   validated, then either approved or rejected").
4. Confirm a flowchart diagram opens in the canvas editor with shapes/connectors reflecting that
   description, and that every element is a normal, draggable/editable shape — no different from
   one added by hand.

### US2 — Refine an open diagram through chat

1. On the diagram from US1, manually drag a shape to a new position and change another shape's
   fill color.
2. In the chat panel, ask to add a new shape connected to an existing one.
3. Confirm the new shape/connector appear, and the manually-moved shape and manually-changed
   color are untouched.
4. Ask the chat to rename a shape, then to remove a different one; confirm each request affects
   only what was asked.
5. Ask the chat to remove a shape by a name that doesn't exist; confirm the chat explains it
   couldn't find it, and the diagram is unchanged.
6. Alternate a few more manual drags and chat requests in any order; confirm nothing is ever
   silently undone by the other.

### US3 — Admin manages the persona library

1. As an admin, open the persona admin screen.
2. Create a new persona under the "Enterprise" category with a custom system prompt; confirm it
   immediately appears in the chat's persona dropdown, grouped under "Enterprise."
3. Edit an existing persona's system prompt; start a new diagram with that persona and confirm
   the AI's framing reflects the edit.
4. Create a second persona under a category that already has one; confirm both appear as distinct
   options.
5. Archive a persona; confirm it disappears from the dropdown for new chats, but any diagram that
   already used it keeps working.
6. As a non-admin user, confirm the persona admin screen is not reachable.

### US4 — Resume a diagram's prior chat conversation

1. Close the diagram from US1/US2 and reopen it later.
2. Confirm the chat panel shows the full prior conversation, in order.
3. Open a diagram that was imported or created by hand (never chatted with); confirm its chat
   panel starts empty and has no persona framing.

## Test commands

```bash
npm run build --workspace=@canvas/diagram-core    # required before api/web tests
npm run test --workspace=@canvas/diagram-core      # addNode/addEdge contract tests
npm run test --workspace=@canvas/api               # persona CRUD, ai-settings toggle, chat endpoint contract tests (needs Postgres running)
npm run test:e2e --workspace=@canvas/web           # create-via-chat, chat-driven edit, persona admin, resume-conversation E2E specs
```

All of the above run against the AI SDK's mock test provider (research.md §8) — no API key
needed, no real network call. To verify real provider integration once actual credentials are
configured:

```bash
RUN_LIVE_AI_TESTS=1 npx playwright test tests/e2e/ai-create-diagram.spec.ts   # opt-in, excluded from CI
```
