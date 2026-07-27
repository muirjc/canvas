# Phase 0 Research: AI-Assisted Diagram Chat

## 1. Where AI tool calls execute

**Decision**: Tool calls execute **server-side**, in the Fastify API, using the Vercel AI SDK's
standard tool-calling loop (`generateText` with a `tools` map whose `execute` functions run
synchronously and whose results the SDK automatically feeds back to the model for a final
natural-language reply — no bespoke round-trip protocol). Each tool's `execute` function calls a
shared, pure function from `packages/diagram-core`'s model-operations module (the same module the
canvas's manual "Add Shape" buttons already use, extended with two new functions per Decision 2).
**Rationale**: `diagram-core` is already explicitly designed to be used identically by frontend
and backend (README, plan.md precedent from 001) — executing tool calls server-side against the
shared pure functions is calling the *same* code the canvas UI calls, not a second, parallel
mutation path to keep in sync. It also lets the AI SDK's tool loop work in its idiomatic form
(synchronous `execute`, automatic follow-up text generation), rather than requiring the frontend
to reimplement that loop against a list of "proposed" operations relayed from the server.
**Alternatives considered**: Client-side execution (server only decides *which* tools to call and
relays that list; the browser applies them). Rejected — it would require reimplementing the AI
SDK's tool-result-feedback loop in the frontend just to get a final natural-language reply, for no
benefit, since the shared functions are equally callable from either side.

## 2. New `diagram-core` model operations needed

**Decision**: Add `addNode(model, { shape, label? }): DiagramModel` and
`addEdge(model, { sourceId, targetId, label? }): DiagramModel` to
`packages/diagram-core/src/model/diagram-ops.ts`, alongside the existing `removeNode`/
`removeEdge`/`updateNodeLabel`/`updateEdgeLabel` from feature 002. `apps/web/src/canvas/Canvas.tsx`
is refactored so its existing "Add Shape" button and connect-mode gesture call these new shared
functions instead of building the node/edge object inline, exactly as it already does for
`removeNode`/`updateNodeLabel` etc.
**Rationale**: This is the "known technical prerequisite" named in the spec's Input — the AI tool
surface (FR-009) needs real functions to call, and today's canvas add-shape/add-connector logic is
inline in `Canvas.tsx`, not a reusable function. Extracting it also removes duplication that
already exists between the button handler and the connect-mode handler.
**Alternatives considered**: Give the AI its own separate node/edge-creation functions, distinct
from what the canvas uses — rejected; would mean two different ways to "add a shape" with no
guarantee they stay behaviorally identical (e.g. default sizing/positioning), violating
Constitution I's single-source-of-truth spirit at the model layer.

## 3. Persistence model for chat-driven edits

**Decision**: A chat turn parses the diagram's **current client-side DSL** (including any
manually-made, not-yet-saved edits) into a model, mutates a server-side copy of it for the
duration of that one request via the tool-calling loop, serializes the result back to DSL, and
returns it to the client — which adopts it as its new live (still unsaved) state, exactly as
`useDslSync`'s `applyDsl` already does for a manually-typed DSL edit. The chat turn does **not**
call `saveDiagram` itself; the existing manual "Save" button remains the only persistence
trigger, for both manual and chat-driven edits alike.
**Rationale**: Directly satisfies FR-011 (freely alternating manual and chat edits, in any order,
without either undoing the other) — both kinds of edits live in the same client-side session
state until the user saves, so there's no ordering/conflict question between "committed chat
edit" and "uncommitted manual edit." It also satisfies FR-012 (same governance as manual edits)
for free: standards validation already only runs at save time today (`saveDiagram` →
`computeValidation`), so routing chat edits through the *same* unsaved-state-then-save path means
they're validated identically, with zero new validation code.
**Alternatives considered**: Have the chat endpoint call `saveDiagram` directly, immediately
persisting each chat-driven edit — rejected; it would make chat edits behave differently from
manual edits (auto-saved vs. requiring an explicit click), complicate FR-011's "any order"
requirement (a chat edit could persist a version that a subsequent manual edit then discards
without ever saving), and require duplicating `saveDiagram`'s validation call outside of the one
place it already correctly happens.

## 4. Terminology collision: "persona"

**Decision**: The existing schema already uses `personas` (on `users` and `diagram_types`) to mean
a simple architect-category tag array (`'Business' | 'Enterprise' | 'Solution' | 'Technical'`) —
an unrelated, pre-existing concept scoping *which diagram types a persona/user can see*
(Constitution III). This feature's new admin-authored AI-framing entity is named `AiPersona` in
code and `ai_personas` at the schema level, to avoid colliding with that existing meaning. The new
entity's `category` field reuses the exact same four string values for consistency. User-facing
copy (spec, UI) continues to say "persona" — the ambiguity is a code/schema-level concern only,
resolved by the `AiPersona` prefix.
**Rationale**: Renaming the existing `personas` columns would be a much larger, unrelated,
unjustified change (Constitution VI) purely to free up a word; prefixing the new concept is a
one-file naming decision with no migration risk to existing data.
**Alternatives considered**: Naming the new entity bare `Persona` — rejected once the existing
column usage was found (would create two different, easily-confused meanings of the same
identifier in the same codebase); renaming the existing columns instead — rejected as
disproportionate scope creep for this feature.

## 5. AI provider selection vs. platform-wide enable/disable

**Decision**: *Which* AI provider services requests (FR-018) is environment-variable
configuration (e.g. `AI_PROVIDER=anthropic|openai` plus each provider's API key), read once at
server start — the same pattern already used for OIDC configuration in this codebase
(`OIDC_ISSUER_URL` etc., `apps/api/src/config.ts`). *Whether* AI chat is available at all
(FR-020) is a separate, database-backed singleton setting (`ai_settings`, one row), toggleable at
runtime via a new admin-only route, checked on every chat-related request.
**Rationale**: FR-018/SC-006 only require provider switching to be "a configuration change, not a
code change" — an env var change (plus restart) satisfies that literally, consistent with
existing precedent. FR-020/SC-007 explicitly require the on/off control to take effect "without a
code change **or redeploy**" — an env var alone can't satisfy that (changing it requires a
restart in this deployment model), so it must be backed by something read per-request, i.e. the
database.
**Alternatives considered**: A single mechanism for both (e.g., provider config also
database-backed) — rejected; provider identity plus API keys are deployment/secret-level
configuration, not something to expose as an admin-clickable UI control (mirrors why OIDC
configuration isn't UI-editable either).

## 6. Reporting a failed tool call back to the user (FR-014)

**Decision**: Each tool's `execute` function checks whether its target (a node/edge id named in
the tool call) exists in the model *before* calling the underlying `diagram-core` operation, and
returns a structured `{ found: false, reason: '...' }` result if not, instead of invoking the
operation. `removeNode`/`removeEdge`/`updateNodeLabel`/`updateEdgeLabel` are lenient/no-op on a
missing id today (needed for the canvas's own idempotent-delete UX) — that leniency is preserved
at the `diagram-core` level, but the AI-tool wrapper around each one adds the explicit
existence check the chat feature needs, and the AI SDK's tool-loop automatically surfaces that
result to the model, which explains it in its final reply. No new error-plumbing is needed beyond
what the tool-calling loop already provides.
**Rationale**: Keeps `diagram-core`'s existing idempotent-delete contract (relied on elsewhere)
completely unchanged, while still satisfying FR-014 at the one layer (the AI tool wrapper) that
actually needs to distinguish "nothing to do" from "the user should be told this didn't work."
**Alternatives considered**: Making the underlying `diagram-core` functions throw on a missing id
— rejected, would be a breaking change to their existing, relied-upon idempotent contract
(feature 002 relies on `removeNode` being safely re-callable).

## 7. Non-streaming chat responses for v1

**Decision**: The chat endpoint is a single request/response — the frontend shows a loading state
while the full AI turn (including any tool calls) completes server-side, then renders the
assistant's message and adopts the updated DSL in one update. No token-by-token streaming UI in
this feature.
**Rationale**: Nothing in the spec requires seeing the response typed live (SC-001 only requires
a diagram within "a single conversational exchange"); streaming would require wiring Fastify to
the AI SDK's streaming UI-message protocol and handling partial tool-call state mid-stream, real
added complexity for no requirement it satisfies (Constitution VI). A later feature can add
streaming without changing this one's data model or tool contracts.
**Alternatives considered**: Streaming from day one — deferred, not rejected outright; noted here
so a future "streaming chat responses" feature has an explicit place to start from.

## 8. Testing without a live AI provider

**Decision**: `diagram-chat.service.ts`'s core function takes the `LanguageModel` to use as an
explicit, optional parameter, defaulting to `getLanguageModel()` from `apps/api/src/ai/provider.ts`
(which reads `AI_PROVIDER=anthropic|openai` in production) when not supplied. Contract tests call
the service directly with a hand-constructed `MockLanguageModelV4` (from `ai/test`, canned
`doGenerate` results including tool calls) passed in as that parameter — no env var, no mode
switch inside `provider.ts` itself. E2E tests exercise the same injection one layer up: the test
app build used by Playwright's web-server is started with the route wired to a mock model the
same way. A separate, opt-in-only smoke test against a real configured provider (gated by an env
flag, e.g. `RUN_LIVE_AI_TESTS=1`, mirroring the existing `RUN_PERF_TESTS` pattern) is included for
manual/pre-release verification, excluded from default CI.
**Rationale**: Plain dependency injection at the function-signature level is simpler and more
standard than teaching the production provider-selection module about a fake "mock" provider
identity — `provider.ts`'s only job stays "resolve `AI_PROVIDER` to a real provider," and nothing
about testing leaks into it. Hitting a real, paid LLM API on every CI run and every local test run
would also be slow, non-deterministic (models don't reliably reproduce the exact same tool calls
for the same input), and require committing to secrets management for API keys in CI — none of
which this feature needs to prove itself. The AI SDK ships `MockLanguageModelV4` in `ai/test`
specifically for this seam; using it is the standard approach, not a workaround.
**Alternatives considered**: An `AI_PROVIDER=mock` env-var mode inside `provider.ts` itself —
rejected once it became clear each test needs a *different* canned response, which a single
global "mock mode" can't express; parameter injection handles that naturally. Requiring real
provider credentials in CI — rejected as slow, flaky, and costly for no correctness benefit over
a deterministic mock; skipping AI-path test coverage entirely and only testing the tool functions
in isolation — rejected, since it would
leave the tool-calling *loop* itself (persona framing, multi-tool-call turns, the "not found"
outcome path) unverified, exactly the part most likely to have integration bugs.

---

All Technical Context items are resolved above; no `NEEDS CLARIFICATION` markers remain in
`plan.md`.
