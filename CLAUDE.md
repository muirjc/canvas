# canvas Development Guidelines

Auto-generated from all feature plans. Last updated: 2026-09-05

## Active Technologies
- `@dagrejs/dagre` (canvas-esn) added to `packages/diagram-core` — its first real runtime
  dependency besides `yaml`. Powers a new `autoLayout()` pure operation (DAG ranking/positioning)
  used by a new canvas toolbar action, flowchart-family only. No persistence/schema change; the
  computed positions round-trip through the existing DSL `canvas.positions` front-matter and
  `graph <direction>` header token exactly like a manually-dragged shape's position would.
- No new technology added in 005-modern-ui-redesign — a frontend-only visual redesign in
  `apps/web`. Zero runtime dependencies added: plain global CSS with custom properties, the
  native `<dialog>` element, and inline SVG icons. No persistence, schema, or API change.
- Vercel AI SDK (`ai`, `@ai-sdk/anthropic`, `@ai-sdk/openai`) added in 004-ai-diagram-chat,
  `apps/api` only — provider-configurable via env var, tool-calling against `diagram-core`'s
  model operations. One additive Postgres migration (`ai_personas`, `diagram_chats`,
  `chat_messages`, `ai_settings`); no new workspace/package.
- No new technology added in 003-parser-correctness-fixes — it extends `packages/diagram-core`
  only (no new package, no persistence/schema changes; every new model field is optional and
  reuses the existing `DiagramContainer`/`DiagramEdge`/`DiagramNode` entities).
- TypeScript 5.x end-to-end: React frontend, Fastify backend, Node.js 22 LTS. Shared
  `diagram-core` package (Mermaid DSL parser/serializer/validator) used identically by frontend
  and backend. PostgreSQL + a blob store for icon/shape library assets. (001-diagramming-platform)
- No new technology added in 002-editing-lifecycle-enhancements — it extends the same stack
  (one additive Postgres migration for diagram soft-delete; no new packages/services).
- No new technology added in 006-authoring-admin-console — zero runtime dependencies added. One
  additive Postgres migration on `standards` (`name`, `description`, `retired_at`) plus a backfill;
  seven new pure container operations in `packages/diagram-core`.
- No new technology added in 007-project-context — zero runtime dependencies added. One additive
  Postgres migration on `projects` (`owner_id`) plus a backfill; no new package or service.
- No new technology added in 008-shared-diagram-access — zero runtime dependencies added. One
  additive Postgres migration, index-only (`share_grants_grantee_idx` on `share_grants`); no new
  table, column, package, or service.
- No new technology added in 009-flowchart-node-shapes — zero runtime dependencies added. No
  persistence change (`NodeShape` is an in-memory/DSL-level type, not a database column); no new
  package or service. Touches `packages/diagram-core` and `apps/web` only.
- No new technology added in 010-ai-diagram-knowledge — reuses 004's existing
  `ai`/`@ai-sdk/anthropic`/`@ai-sdk/openai`/`zod` in `apps/api`. One additive Postgres migration
  (`ai_persona_reference_material`); no new workspace/package.
- No new technology added in 011-sequence-lifeline-rendering — a rendering-layer change only,
  touching `packages/diagram-core` (`src/dsl/sequence.ts`, a new `src/render/sequence-layout.ts`)
  and `apps/web/src/canvas/Canvas.tsx`. No new dependency, no new package, `apps/api` untouched.
  One deliberate, disclosed round-trip exception: `canvas.positions`/`canvas.containers`
  front-matter stops being read/written for this one diagram family, since sequence-diagram
  layout becomes fully computed from DSL order (participant/message declaration order) rather than
  a stored, draggable position — see `specs/011-sequence-lifeline-rendering/research.md` §1.

## Project Structure

```text
apps/web/src/{canvas,palette,standards,admin,projects,app}   # frontend
apps/api/src/{diagrams,standards,libraries,projects,sharing,admin,export,auth}  # backend
packages/diagram-core/src/{model,dsl,standards,libraries}    # shared parser/serializer/validator
```

## Commands

npm run test --workspace=@canvas/diagram-core && npm run test --workspace=@canvas/api && npm run test --workspace=@canvas/web

## Code Style

TypeScript, standard conventions. `diagram-core` round-trip and standards-validation contract
tests are NON-NEGOTIABLE and must exist (and fail) before implementing any diagram-type or export
work — see `.specify/memory/constitution.md` Principle IV.

## Recent Changes
- **Dev environment**: `apps/api/.env`'s `ANTHROPIC_API_KEY` was rotated to a working key
  2026-09-06 (the previous one was rejected by Anthropic as invalid, blocking every real-provider
  AI validation since 004). Confirmed live (a real chat call round-tripped correctly). This
  unblocked `canvas-tgf`'s own long-outstanding SC-002 manual validation — see
  `010-ai-diagram-knowledge`'s history entry below for what was actually checked. Note: the AI
  e2e suite (`ai-*.spec.ts`) is written against the mock provider by design (deterministic hex
  colors, exact response text, "mock mode" UI copy) — running it with `AI_PROVIDER=anthropic`
  instead of `mock` produces expected, not-a-regression failures on those provider-specific
  assertions; use `AI_PROVIDER=mock` for that suite, the real key for manual live-provider spot
  checks only.
- `canvas-7vs.11` (found while scoping `canvas-7vs.8`, filed under `jmuir-dtu`'s own Mermaid
  DSL-compliance roadmap since it's a parser/model gap, not a renderer one): C4's
  `BOUNDARY_START` parsed all five real boundary keywords (`Boundary`, `System_Boundary`,
  `Container_Boundary`, `Enterprise_Boundary`, `Deployment_Node`/`Node`/`Node_L`/`Node_R`) into the
  exact same untyped `DiagramContainer` — which one was actually used was discarded entirely,
  `role` left `undefined`, unlike every other container role in this codebase. A new
  `BOUNDARY_KEYWORD_TO_ROLE` map now captures it (`'boundary'`, `'system-boundary'`,
  `'container-boundary'`, `'enterprise-boundary'`, `'deployment-node'` — the four
  `Deployment_Node`-family shortcuts collapse to one role, matching `ELEMENT_TO_ROLE`'s own
  established precedent for element-kind variants), and `serializeC4` now picks the exact keyword
  back from that role instead of collapsing every boundary in a model to one keyword chosen purely
  from `diagramTypeId` (`Deployment_Node` for `c4-deployment`, `System_Boundary` for everything
  else) — a real round-trip fidelity improvement: the real bank-boundary example (which mixes
  `Enterprise_Boundary`/`System_Boundary`/`Boundary` in one diagram) now round-trips each one
  correctly instead of silently normalizing all three to `System_Boundary`. A container with no
  role at all (never having gone through C4's own boundary grammar — e.g. built directly via
  `addContainer()`) still falls back to that same diagramTypeId-driven default exactly as before,
  so nothing that never had a captured keyword changes behavior. Three existing tests needed
  updating as a direct, expected consequence (role is a new, real field on their fixture
  containers now) — not weakened, brought in line with what a real parse now correctly produces;
  one existing test's own throwaway placeholder arg value ("boundary") happened to collide with
  the new role string it was asserting the model never contained, fixed by picking a
  non-colliding placeholder ("perimeter") instead. `packages/diagram-core` 684/684 (up from 677 —
  7 new cases directly exercising this fix: all 5 keywords each getting their own role and
  round-tripping correctly, the 3 Deployment_Node-family shortcuts collapsing to one role, and the
  real mixed bank-boundary example keeping each of its three distinct keywords through a full
  round-trip). `npx eslint .`: 0 errors, run explicitly before pushing.
- `canvas-m0g`: nested containers (C4 `Enterprise_Boundary`/`System_Boundary`/`Container_Boundary`/
  `Deployment_Node`, UML `namespace`-within-`namespace`, flowchart nested `subgraph`) parsed their
  `parentContainerId` chain correctly but nothing ever converted that hierarchy into geometry —
  every node AND container, regardless of nesting depth, came from ONE flat, shared,
  containment-blind auto-position counter. Live-confirmed against the real bank-boundary C4
  example (`BankBoundary0` > `BankBoundary` > `{BankBoundary2, BankBoundary3}`): a child boundary
  landed 400px to the right of its own parent, zero geometric relationship. Adds a new shared, pure
  `computeContainmentLayout()` in `packages/diagram-core/src/model/containment-layout.ts` — a
  two-pass (bottom-up sizing, top-down placement) flow layout with row-wrapping, deliberately NOT a
  full dagre compound-graph/constraint solve (the same "an explicit fast-follow... not attempted
  here since the dagre wiki doesn't document it in enough depth" judgment call `canvas-esn`'s own
  `autoLayout()` already made) — just enough to guarantee every container's box strictly encloses
  its direct AND indirect children, at every nesting depth. Wired into `c4.ts`/`uml.ts`/
  `flowchart-parser.ts`'s auto-position fallback as a post-pass (each element gets a placeholder
  position during the main parse loop; the whole tree's real geometry is computed once every
  node/container is known, since a container's own size can't be known until every descendant,
  parsed on later lines, already has one) — scoped to a genuinely fresh import/paste (**no** stored
  front-matter geometry at all); a diagram with existing saved positions keeps the old per-element
  fallback unchanged for whatever individual element still lacks one, a disclosed scope boundary
  (reconciling new auto-placed elements amid already-hand-positioned ones is a harder problem
  nothing in this codebase solves for any family today, not a regression from this fix). A real,
  independent bug found and fixed along the way: `serializeUml`'s own `canvas.containers`
  front-matter only ever wrote `{x, y}`, never `{width, height}` (unlike C4/flowchart's own
  matching serializers) — so a namespace/note's newly-computed size was silently dropped on the
  very first save/reload, breaking round-trip idempotency; now mirrors C4's own
  `size ? {...x,y,width,height} : {x,y}` pattern exactly. `packages/diagram-core` 677/677 (up from
  668 — 6 new `containment-layout.test.ts` unit cases for the shared function, 9 new
  `containment-auto-layout.test.ts` cases exercising all three parsers end to end with real DSL
  text, including round-trip stability); `apps/web` E2E: new `containment-layout.spec.ts` against
  the real bank-boundary example in the actual interactive canvas, confirmed via a live PNG export
  too (every boundary visibly nested, not floating). No renderer changes needed at all — Canvas.tsx
  and svg-renderer.ts already draw any family's `node.position`/`container.position`+`size`
  correctly; the fix lives entirely in what position/size gets computed at parse time.
- `canvas-7vs` epic now fully complete (10/10) — closes with `canvas-7vs.8`/`.9`/`.10`, all built
  directly on `011-sequence-lifeline-rendering`'s geometry. **canvas-7vs.8** (every
  `DiagramContainer.role` rendered as the same generic dashed gray box): a new, shared
  `containerRoleStyle(role)` in `svg-renderer.ts` (mirrored exactly in `Canvas.tsx`'s own generic
  container JSX, SC-004) gives each role its own default fill/stroke/border — sequence/UML notes a
  pale-yellow solid-bordered box (real Mermaid's own note convention), a sequence `box` grouping a
  finer dash than a control-flow block, a UML `namespace` a filled header band (package/folder-tab
  look). Sequence's `loop`/`alt`/`opt`/`par`/`critical`/`break` (NOT `rect`, whose whole identity
  is its fill color, canvas-7vs.2) get their own indigo stroke plus a small corner-tab rect behind
  their label, matching real Mermaid's folded-corner convention — `activate`/`deactivate` needed no
  further work here, since `011`'s bar rendering already gives them a real, distinct geometry (a
  bar, not a box). Deliberately NOT covered: C4 boundary kinds (`System_Boundary`/
  `Container_Boundary`/`Enterprise_Boundary`/`Deployment_Node` all currently parse to the SAME
  `role: undefined` — confirmed live, a real parser/model gap, not a renderer one, since the
  boundary keyword itself was never captured at all) and flowchart subgraphs (also `role:
  undefined`) — both keep today's plain box unchanged; a real, larger, differently-shaped fix than
  this epic's own "renderer completeness" framing covers, left undisturbed rather than folded in.
  **canvas-7vs.9** (`attachedNodeIds` never drew a connector): a thin leader line (from the
  container's own center to each attached point) via a shared `renderAttachmentConnectors`,
  covering sequence notes (target: the participant's own lifeline, at the note's row) and UML
  `note for ClassName` (target: the class node's own center) — `box`/`namespace` never carry
  `attachedNodeIds` so need none. **canvas-7vs.10** (the "Add Shape" toolbar offered sequence
  diagrams four shapes `serializeSequence` silently discarded on every save): `getAddableShapes`
  now returns `[]` for `dslFamily === 'sequence'`, and the whole "Shapes" toolbar section is hidden
  rather than shown empty — participant declarations, not toolbar-added generic shapes, are how a
  sequence diagram actually gains a new lifeline. `packages/diagram-core` 662/662 (up from 656 — 6
  new `render-svg.test.ts` cases); `apps/web` E2E: `sequence-rendering.spec.ts` grew to 10/10, plus
  a 53-test regression subset (containers/auto-layout/edges/labels/style/import/flowchart-shape-
  toolbar) all green — the full suite was again not run start-to-finish in this environment (same
  disclosed gap as `011`'s own note).
- `011-sequence-lifeline-rendering` (canvas-7vs.1, all four user stories complete): sequence
  diagrams parsed and modeled every construct correctly but rendered through the exact same
  flat-row code path a flowchart uses (`sequence.ts`'s own `nextPosition()`: every participant/
  message/note/block placed at `y=40`, `x += 180`) — confirmed live, multiple messages between the
  same two participants rendered fully coincident, the single biggest finding of the canvas-7vs
  renderer-completeness audit. Adds one new shared, exported `computeSequenceLayout()` in a new
  `packages/diagram-core/src/render/sequence-layout.ts` (participant lifeline x-order from
  declaration order; message/activation/block/note y-position and horizontal bounds from the
  existing `sequenceOrder`/`parentContainerId`/`attachedNodeIds` fields — no new model field)
  called by BOTH `svg-renderer.ts` (a new `renderSequenceSvg`) and `Canvas.tsx` — deliberately
  avoiding a second, independently-hand-copied geometry calculation, the same class of canvas/
  export disagreement risk feature 009's research flagged for shape rendering (`cylinder`), here at
  whole-diagram scale; confirmed no drift both by unit tests asserting real geometric relationships
  (not just "renders without throwing") and by a live manual export check (`/export?format=svg`
  and `?format=png` against a running API) matching the canvas exactly. Per a decision resolved
  directly with the user: layout is computed-only, never dragged/stored — manual drag-to-reposition
  is disabled for sequence-family elements (`handleNodePointerDown`/`handleContainerPointerDown`
  skip starting a drag when `dslFamily === 'sequence'`), and `canvas.positions`/`canvas.containers`
  front-matter round-trip is intentionally dropped for this one family (research.md §1) — position
  was never real DSL content for sequence diagrams (declaration/message *order* is, and that's
  unaffected), so continuing to store now-ignored values would be a worse trap than omitting them.
  Participants get real vertical lifelines (full diagram height); messages (including a
  self-message, rendered as a loop, not a collapsed zero-length line) are ordered strictly by
  `sequenceOrder`; `activate`/`deactivate` pairs (statement or `+`/`-` shorthand) render as narrow
  vertical bars, nested/stacked activations offset into separate lanes; `loop`/`alt`/`opt`/`par`/
  `critical`/`break`/`rect` render as a bounding box spanning only the participants a message or
  attached note/activation inside it actually references (not the full diagram width), with
  `else`/`and`/`option` as a labeled divider inside the parent's bounds; `Note left/right/over` and
  `box` groupings position correctly against the real lifeline geometry. Scope was deliberately
  bounded, per the epic's own split: giving notes/boxes/blocks a genuinely distinct visual style
  (canvas-7vs.8) and drawing an attachment connector line (canvas-7vs.9) remain their own sibling
  beads, now unblocked by this feature's geometry but not delivered by it; a `create`/`destroy`'d
  participant's lifeline visually starting/ending partway down the timeline (rather than always
  spanning full height) was also deliberately left out of scope. A real, independent gap was found
  during research and intentionally not fixed here (filed as a follow-up instead): the "Add Shape"
  toolbar still offers sequence diagrams the four generic universal shapes, but `serializeSequence`
  silently discards whatever shape a toolbar-added node actually has and re-emits every node as a
  plain participant/actor line regardless. Full `packages/diagram-core` suite green (656/656, up
  from 633 — 23 new contract-test cases); `apps/web` E2E validated via the new
  `sequence-rendering.spec.ts` (7/7, exercising the real running app end to end: lifeline ordering,
  the confirmed bug-report shape's 4 non-coincident messages, a self-message loop, an activation
  bar, loop-block bounds, note positioning, and drag-disabled) plus a targeted 42-test regression
  subset across the shared Canvas.tsx code paths this feature touches (containers, auto-layout,
  edge selection, label/style affordances) — the full `apps/web` E2E suite was not run start-to-
  finish in this environment (it exceeded a 550s budget with no output even before this feature's
  changes) and is recommended as a final CI gate before merge. See
  `specs/011-sequence-lifeline-rendering/` for the full spec/plan/research/data-model/contracts/
  tasks (all 46 tasks complete).
- `010-ai-diagram-knowledge` (all four user stories complete, canvas-tgf): AI chat was hardcoded to
  `getDslFamily('flowchart')` regardless of the diagram's real type — a confirmed, live bug, not a
  hypothetical gap — so a chat request against any non-flowchart diagram errored out despite the
  chat panel being shown for every diagram type. **Foundational**: `diagram-chat.routes.ts` now
  resolves the diagram's real `dslFamily` via the existing `getDiagram`/`loadDiagramTypeDslFamily`
  lookup and threads it through `sendChatMessage`/`createDiagramTools`; a new
  `diagram-type-primers.ts` supplies one short plain-language orientation per family, composed into
  the system prompt between the persona's own prompt and `describeModel()`'s summary. **User Story
  1** (the confirmed bug fix itself) is covered by dedicated contract/E2E tests against all 5
  non-flowchart families, not just asserted fixed by Foundational's own change. **User Story 2**
  (the actual requested value — type-correct structured edits, not generic labeled boxes) adds 6
  new pure `diagram-core` operations (`updateNodeRole`, `updateEntityAttributes`,
  `updateClassMembers`, `updateEdgeRelationKind`, `updateEdgeArrowStyle`,
  `addPointMarkerContainer`) and 8 new family-conditional AI tools (`setNodeRole` on c4/sequence,
  `setEntityAttributes` on erd, `setClassMembers`/`setRelationshipKind` on uml, `setConnectorStyle`
  on sequence/flowchart, `groupIntoContainer` on architecture/c4/uml/sequence,
  `activateParticipant`/`deactivateParticipant` on sequence) — `createDiagramTools(context,
  family)` only returns a tool when it applies to that diagram's own family, so an out-of-family
  request has no tool call to make at all (FR-004), not merely a refusal string layered on top of
  one; `addNode`'s own `shape` enum was likewise widened from a single hardcoded flowchart list to
  each family's real `NodeShape` subset, confirmed against each family's own `dsl/*.ts` parser. A
  dedicated regression test confirms an AI-tool-driven mutation that violates the diagram's active
  Standard is flagged by the same `computeValidation` path a manual edit already goes through
  (Constitution Principle II — no bypass for AI-tool-driven mutations); 6 new mock-provider E2E
  scenarios cover every new tool plus the FR-004 decline case. **User Story 3** adds the FR-005
  anti-drift guard: a new contract test walks every tool's live Zod schema per family at test time
  (not a hand-copied enum list), collects every reachable enum value, and asserts each is mentioned
  in that family's primer text — ran red against the original T007 primer wording (all 6 families
  had real gaps: several shape/arrow/line-style/visibility-marker/relationship-kind values were
  never mentioned), fixed by revising `diagram-type-primers.ts`'s prose until every value is
  covered. **User Story 4** adds persona-scoped reference material: a new
  `ai_persona_reference_material` table (migration `0010`), `persona-reference-material.service.ts`
  (CRUD + family-id validation mirroring `InvalidPersonaCategoryError`'s pattern), 4 new admin-only
  routes, and `PersonaAdminPage.tsx` CRUD UI (per-entry content + 6 family-scoping checkboxes,
  reusing canvas-23t.1's card/field primitives) — entries scoped to the diagram's own family, or
  unscoped, are composed into the system prompt after the family primer and before
  `describeModel()`'s summary, never ahead of or in place of the persona's own `systemPrompt`
  (FR-008); editing/deleting an entry never touches already-persisted `chat_messages` rows
  (FR-009). A real regression was found and fixed while writing User Story 4's E2E coverage: the
  new per-entry `<textarea>` made `ai-persona-admin.spec.ts`'s bare `row.locator('textarea')`
  selector ambiguous (two textareas per row now) — fixed by scoping to
  `textarea[data-testid^="persona-prompt-"]`. **Polish**: full regression green
  (`packages/diagram-core` 633/633, `apps/api` 303/304 + 1 skipped perf test, clean `tsc --noEmit`/
  `eslint`/build across all three workspaces); SC-002's manual live-provider validation (User Story
  2 against a real Anthropic model, following 004's own T033 precedent) was initially attempted but
  blocked — the dev environment's `ANTHROPIC_API_KEY` was rejected by Anthropic as invalid (a real,
  environment-specific credential problem unrelated to this feature's own code). **Completed
  2026-09-06** once the key was rotated: `POST /diagrams/:id/chat/messages` against a fresh ERD
  diagram ("give CUSTOMER a primary key attribute id of type string") correctly fired
  `setEntityAttributes` and produced real ER attribute+PK syntax (`CUSTOMER { string id PK }`), not
  a generic labeled box; a second UML check ("Car inherits from Vehicle... give Car a private
  string field called licensePlate") correctly fired BOTH `setRelationshipKind` and
  `setClassMembers`, producing real UML inheritance-token/visibility-marker syntax
  (`Car <|-- Vehicle`, `-string licensePlate`). `canvas-tgf` (the bead tracking this exact
  outstanding item) closed on this result. See `specs/010-ai-diagram-knowledge/` for the full
  spec/plan/research/data-model/contracts.
- Azure deployment fixes, found live during the first-ever real deploy of `infra/azure/`
  (canvas-ycu/canvas-ycu.1's infrastructure), not anticipated in advance:
  - **`apps/api/src/auth/idp-proxy.routes.ts`**: Fastify's own built-in `application/json`
    content-type parser always takes precedence over a `'*'` wildcard registration, regardless of
    order (confirmed against Fastify's own `ContentTypeParser` docs) — so every JSON-bodied
    request forwarded through the `/idp` reverse proxy (every Keycloak admin-API write: `PUT` a
    client, `POST` a new one, ...) was silently parsed into a JS object by that default parser,
    then handed to `fetch()`'s `body` option as that object, which stringifies to the literal text
    `"[object Object]"` — Keycloak rejected every one with a generic `"Cannot parse the JSON"`.
    Fixed with `removeAllContentTypeParsers()` before registering the wildcard buffer parser, so
    the proxy is genuinely a byte-for-byte pass-through for every content type, not just the ones
    Fastify has no built-in opinion about (`application/x-www-form-urlencoded`, which is why
    Keycloak's own login-form POSTs already worked and this went undetected). New regression test
    in `idp-proxy.test.ts` sends a JSON-bodied `PUT` and asserts the forwarded bytes match exactly.
  - **`infra/azure/deploy.sh`**: the Postgres admin password was generated via
    `openssl rand -base64 24`, which can (and did) produce `+`/`/`/`=` — embedded directly in
    `DATABASE_URL`, this broke `pg-connection-string`'s strict WHATWG `URL()` parsing with
    `TypeError: Invalid URL`, failing every DB connection (migrations, the API itself) with no
    indication the password was the cause. Now filtered to alphanumeric-only
    (`tr -dc 'A-Za-z0-9'`), still ~140 bits of entropy from 24 characters, comfortably above Azure
    Postgres Flexible Server's own complexity floor.
  - **`infra/azure/modules/apiapp.bicep`** / **`modules/keycloak.bicep`** / **`main.bicep`**: both
    modules independently declared their own `AcrPull` role assignment for the same shared managed
    identity — functionally redundant, since RBAC grants are additive per identity+role+scope, but
    redeploying both hit `RoleAssignmentExists`, which Azure's Role Assignments API won't resolve
    via a normal incremental redeploy (a role assignment's `principalId` is effectively immutable
    once created, and `what-if`'s own comparison of an unresolved `reference()` expression against
    an already-resolved literal value made Azure think a real change was being requested). Fixed
    by removing `apiapp.bicep`'s redundant declaration entirely — `keycloak.bicep`'s alone already
    covers both apps, with an implicit deploy-order dependency already in place via
    `keycloak.outputs.fqdn`.
  - Not yet fixed, known and documented instead: `deploy.sh`'s own Keycloak-client reconciliation
    step (redirect URI / web origin / client secret) authenticates as the Keycloak master-realm
    admin via `grant_type=password` direct-grant, but Keycloak 25+/26's
    `KC_BOOTSTRAP_ADMIN_PASSWORD`-created admin is explicitly *temporary* and REST direct-grant
    rejects it outright (`invalid_user_credentials`) — only the browser-style Authorization Code
    flow (PKCE) accepts it, confirmed by successfully logging in that way and patching the client
    manually. `deploy.sh` silently skips reconciliation every time
    (`WARNING: could not reach Keycloak's admin token endpoint after 6 attempts`), leaving the
    realm's dev-placeholder `redirectUris`/`webOrigins` (`http://localhost:3000`) in place — this
    is why a fresh deploy's real SSO login fails with `Invalid parameter: redirect_uri` until the
    client is patched by hand. Filed as follow-up work, not fixed in this pass.
- `jmuir-dzd.2`: flowchart's own `:::` classDef-shorthand (`A:::className`, equivalent to a
  separate `class A className` line) was missing — `erd.ts`/`uml.ts` both gained it earlier this
  session, but `flowchart-parser.ts`'s own `classDef`/`class` support (grouping C) never picked it
  up, so a real flowchart file using the shorthand hard-errored. New `CLASS_SHORTHAND` pattern,
  applying the same second-pass `classDefs`/`classAssignments` timing/precedence the explicit
  `class` form already had (forward-referenced `classDef`s resolve correctly; an explicit `style`
  line on the same node still wins). Matches erd.ts/uml.ts's own established convention of
  accepting (but only applying the first of) a comma-separated class list after `:::` — real
  Mermaid's own `flow.jison` grammar (`vertex STYLE_SEPARATOR idString`) only ever accepts a
  single class name there, but staying consistent with this codebase's own two prior `:::`
  implementations was judged more valuable than a third, stricter variant. A node referenced only
  via the shorthand is auto-created as an implicit rectangle, matching every other "no element
  silently dropped" convention already established for edge endpoints. Deliberately out of scope
  (fails cleanly with a structured parse error, not a silent misparse): combining the shorthand
  with an inline shape+label on the same token (`A[Label]:::className`) — would need touching
  every one of `NODE_PATTERNS`' ~13 shape regexes plus the edge-endpoint token matcher, a
  meaningfully larger surface than the bare-id case — filed as `jmuir-dzd.3`.
- `jmuir-dtu.2.1`: the follow-up `jmuir-dtu.2` filed for its own three deliberately-scoped-down
  items — all three now given a real decision and implemented, none left deferred further.
  **Lollipop interfaces** (`Foo ()-- Bar` / `Foo --() Bar`): added as two more literal tokens in
  `uml.ts`'s existing relationship-token table (`'lollipop-source'`/`'lollipop-target'` on
  `DiagramEdge.umlRelationKind`, one kind per token like every other relationship already there) —
  confirmed against Mermaid's own `classDiagram.jison` grammar (LOLLIPOP as a `relationType`
  combinable with `lineType` on either side) and its docs example ("the interface with the
  lollipop connects to the class") that the circle always renders on whichever endpoint sits
  textually adjacent to the `()` token, independent of source/target position — parse/model/
  round-trip fidelity only, matching this field's own pre-existing "no renderer differentiates
  relationship kinds yet" precedent, not a new gap. **Namespace dot-notation**
  (`namespace A.B.C { ... }`): confirmed against Mermaid's `classDb.ts` that this auto-creates
  parent namespaces `A` and `A.B`, chained via `parentContainerId`; implemented by qualifying
  EVERY namespace's container id by its full enclosing-namespace chain, not just its own
  dot-notation segments — needed so an explicit `namespace X { namespace Y { ... } } ` block
  produces the identical id as the equivalent dot-notation form, which in turn is what makes
  serialize→reparse idempotent (`serializeUml` always canonicalizes dot-notation to the
  equivalent nested-block form, mirroring flowchart's own chained-edge/fan-out canonicalization
  precedent) and, as a side effect, closes jmuir-dtu.2's own disclosed same-name-different-parent
  namespace id collision risk. **Bracketed namespace display label**
  (`namespace Name["Label"]`): the declaration identifier is always derived from the container id's
  own last dot-segment, kept distinct from `label` (which the bracket form overrides) — the
  bracket form is only re-emitted on serialize when `label` actually differs from that short name,
  so an unrelabeled namespace still round-trips to its own plain form. Also corrected two now-stale
  claims left over from `jmuir-dtu.2`'s own test-file comments (`serializeUml` DOES emit a
  `canvas.containers` position block, contrary to what that file's header comment said) while
  touching the same file for this bead's own coverage.
- `jmuir-dtu.4.1`: the follow-up `jmuir-dtu.4` filed for its own three deliberately-scoped-down
  items, each given a real decision (per the bead's own acceptance criteria) rather than left as
  an unexplained parse error forever. **Implemented**: `create participant/actor <id> (as
  <alias>)?` and `destroy <id>` participant-lifecycle statements — modeled exactly like
  `activate`/`deactivate` (their own `role: 'create'`/`'destroy'` `DiagramContainer`,
  point-in-time, no linked pairing) via a shared `pushPointItem()` helper, rather than the
  node-level ordering field the original bead description sketched — turned out unnecessary, and
  nesting inside `loop`/`alt`/`rect` works correctly for free via the same `currentContainerId()`
  mechanism activation already used (live-verified, not assumed). A `create`d node is skipped from
  the top-of-file participant declarations and instead emitted inline at its own position.
  **Deferred permanently, not implemented**: the newer "half-arrow" tokens (v11.12.3+, 14 token
  variants) — too new/niche relative to their implementation cost, a closed decision. **Deferred,
  tied to an existing open decision**: actor `link`/`links` menu directives — the same security
  class as flowchart's own still-unimplemented `click <id> href` (`jmuir-dzd` grouping G, which
  needs scheme-allowlisting + XML-escaping to avoid a stored-XSS vector); implementing this first
  would mean solving that shared problem twice independently, so it waits for grouping G instead.
  Also fixed a real (if non-security) CI defect found along the way: gitleaks' `generic-api-key`
  entropy heuristic flagged the plain-English phrase "explicit/shorthand" in a doc comment as a
  possible secret — confirmed via a local, unredacted gitleaks run. New root `.gitleaksignore`
  suppresses the already-pushed historical commit (content can't be edited after the fact without
  rewriting shared history); the live wording was also fixed so no future commit re-triggers it.
- `jmuir-dtu.2`: Class/UML diagram gaps beyond feature 003 — closes the previously-disclosed
  "class bodies are recognized but their contents skipped entirely" limitation, the largest single
  gap left in the `jmuir-dtu` epic. `packages/diagram-core/src/dsl/uml.ts` was almost entirely
  rewritten to add: class members (a new `ClassMember`/`DiagramNode.members`) — attributes
  (`visibility type name`) and methods (`visibility name(params) returnType`), visibility markers
  (`+`/`-`/`#`/`~`), generics via `~T~` (including types with internal spaces/commas like
  `Map~string, int~`, handled by treating "everything except the last whitespace token" as the
  type rather than assuming a single token), and static (`$`)/abstract (`*`) modifiers — always
  the very last character, after the return type for methods, not right after `()`; the full
  relationship-token set with cardinality (`<|--` inheritance, `*--` composition, `o--`
  aggregation, `-->` association, `--` link-solid, `..>` dependency, `..|>` realization, `..`
  link-dashed, plus optional quoted multiplicity labels on either side) via a new
  `DiagramEdge.umlRelationKind`/`sourceCardinality`/`targetCardinality` — a dedicated field rather
  than overloading the shared `arrow`/`lineStyle` vocabulary, since a class diagram's arrowhead
  shape carries real semantic meaning those fields' existing values don't fit; `<<Stereotype>>`
  annotations in all three documented placement forms (inline, standalone-referencing-by-name,
  nested-in-body) via a new `DiagramNode.umlStereotype`; `namespace Name { ... }` grouping
  (nestable, member classes reference it via `containerId` like every other container-membership
  pattern in this codebase) — using the namespace's own given name as its container id (stable
  across re-saves, like C4 boundaries/ERD entities' own author-given ids) rather than a counter;
  notes (`note "text"` / `note for ClassName "text"`); style/classDef/class/`:::` (resolving a
  real ambiguity unique to this family: UML's `class` keyword is BOTH the node-declaration keyword
  AND, in its multi-identifier form, the style-assignment keyword — disambiguated purely by
  pattern specificity/anchoring, no special-case logic needed); and `direction`. Namespace/note
  container positions now round-trip via a new `canvas.containers` front-matter block (mirroring
  C4's own) — a real gap found while writing tests (serialize→reparse silently drifted their
  auto-assigned positions every time) and fixed as part of this same pass, not deferred. Lollipop
  interface syntax, namespace dot-notation, and the v11.15+ bracketed namespace-label form are
  deliberately out of scope — filed as `jmuir-dtu.2.1`.
- `jmuir-dtu.4`: Sequence diagram gaps beyond feature 003 — the largest of the `jmuir-dtu` DSL
  sub-beads tackled so far. `packages/diagram-core/src/dsl/sequence.ts` gains the `actor` keyword
  (`role: 'actor'`, `shape: 'person'`, vs `participant`'s `role: 'participant'`, `shape:
  'rectangle'`) plus `as <alias>` on both, order-independent like every other alias convention this
  epic has built; the full arrow-token set (`->`, `-->`, `-x`, `--x`, `-)`, `--)`, `<<->>`,
  `<<-->>`, alongside the pre-existing `->>`/`-->>` — the latter two now actually distinguished by
  `lineStyle` instead of collapsing to one shape, closing a previously-disclosed limitation) via a
  new `ARROW_TOKEN_TO_STYLE` map, adding two sequence-only `DiagramEdge.arrow` values (`'cross'`,
  `'open'`); activation (`activate`/`deactivate` statements and the `+`/`-` message-arrow
  shorthand) — confirmed against Mermaid's own `sequenceDiagram.jison` grammar source (not
  guessed) that `+` activates the arrow's TARGET while `-` deactivates the arrow's SOURCE, a real
  asymmetry easy to get backwards by eye alone; each occurrence becomes its own independent
  `DiagramContainer` (`role: 'activate'`/`'deactivate'`) rather than a linked start/end pair, so
  stacked activations for one participant just work with no special-casing; `rect <color> ... end`
  background highlighting, joining the same block-with-`end` family as `loop`/`alt`/etc but storing
  its color in `style.fillColor` rather than `label`; `box <color>? <title>? ... end` participant
  grouping, sitting outside the message timeline entirely — members reference it via their own
  `containerId`, mirroring C4/ERD container membership; and `autonumber`/`autonumber off`/
  `autonumber <start> <step>` via a new single model-wide `DiagramModel.sequenceAutonumber` field
  (last statement wins — a disclosed simplification for the rare multi-toggle-mid-diagram case).
  Deliberately deferred (confirmed via live reproduction to still fail with a clean, structured
  parse error rather than a silent misparse): `create`/`destroy` participant lifecycle statements
  (need a new node-level ordering concept nothing else in the model requires), the newer "half-arrow"
  tokens (v11.12.3+, niche), and actor `link`/`links` menu directives — filed as `jmuir-dtu.4.1`.
- `jmuir-dtu.5`: Architecture diagram (`architecture-beta`) gaps beyond feature 003.
  `packages/diagram-core/src/dsl/architecture.ts` gains junction nodes (`junction <id> (in
  <groupId>)?` — a routing-point node with no icon/label, `role: 'junction'`, `shape: 'circle'`;
  edges reference a junction's id exactly like any service); the `{group}` edge modifier
  (`serviceId{group}:ANCHOR --> ANCHOR:serviceId{group}`), escalating an edge endpoint's
  connection point to the *service's parent group boundary* — new `DiagramEdge.sourceIsGroup`/
  `targetIsGroup` booleans, purely a rendering-escalation hint since `sourceId`/`targetId` still
  reference the service (real Mermaid forbids bare group ids in edge lines entirely); `align row/
  column <id> <id> ...`, round-tripping as a literal DSL body line (real Mermaid grammar, unlike
  `positions`/`styles`/`icons`) via a new `DiagramModel.architectureAlignments` field, mirroring
  `direction`'s own front-matter-free precedent — no auto-layout consumes it yet, preserved for
  round-trip only; and iconify.design custom icon packs (`service s(logos:aws-lambda)[...]`) via a
  new `resolveIconFromName()` helper detecting the `prefix:name` format and tagging it
  `libraryVersion: 'iconify'`, distinct from this app's own bare curated-library icon ids (none of
  which ever contain a colon) — parse/model/round-trip fidelity only, no actual iconify artwork
  fetching implemented or attempted.
- `canvas-ycu.1`: `canvas-ycu`'s Bicep foundation (`infra/azure/`) had no way to actually run
  `canvas-mi9`'s Keycloak/MFA code — `ALLOW_LOCAL_AUTH` stayed `true` by default there since no
  OIDC provider was reachable at all. Adds `modules/keycloak.bicep` (internal-ingress-only
  Container App, never reachable from a browser directly, its own `keycloak` Postgres database) and
  a transparent `/idp/*` reverse proxy on `canvas-api`'s own container
  (`apps/api/src/auth/idp-proxy.routes.ts`) forwarding to it — `/idp`, not `/auth`, since canvas's
  own API already owns the `/auth/*` route namespace for its session routes, unlike the sibling
  reference project this mirrors. `apiapp.bicep`'s `allowLocalAuth` now defaults to `false`. A new
  internal/public issuer split (`OIDC_INTERNAL_ISSUER_URL`/`KEYCLOAK_INTERNAL_URL`, `oidc.ts`'s
  `customFetch` override) works around a real, independently-reproduced Container Apps limitation:
  a container calling its own public ingress FQDN from inside the same environment doesn't reliably
  route back to itself. Real user provisioning is decided, not deferred again:
  `infra/keycloak/create-users.mjs` (admin-REST-API, idempotent, assigns one of
  admin/architect/viewer as a realm role, sets `requiredActions: ["CONFIGURE_TOTP"]` explicitly per
  user since a realm's own `defaultAction` never reaches admin-API-created users) runs via a new
  manual-trigger `canvas-keycloak-users` Container Apps Job
  (`modules/usersjob.bicep`) — `KC_USERS` (real account data) is supplied per-invocation, never
  baked into the template. `deploy.sh` reconciles the realm-imported `canvas-api` client's
  redirect URI/web origin/secret against the real, only-known-after-first-deploy API FQDN via the
  admin REST API on every run, since Keycloak's `--import-realm` is skip-if-exists. Also fixed a
  real, independently confirmed latent bug found while validating this: `.dockerignore`'s bare
  `*.tsbuildinfo` pattern only ever excluded a build-context-ROOT file (unlike `.gitignore`
  semantics) — a nested `packages/diagram-core/tsconfig.tsbuildinfo` (created by any ordinary local
  `npm run build`) was silently slipping into every real `docker build`/`az acr build`, since
  canvas-ycu shipped, fooling `tsc`'s incremental cache into skipping `diagram-core`'s emit
  entirely with zero errors — added a `**/*.tsbuildinfo` sibling line, matching the `**/node_modules`/
  `**/dist` pattern already used elsewhere in the same file, and verified against a from-scratch
  `--no-cache` build with a real leftover host tsbuildinfo file present.
- `jmuir-dtu.3.2`: C4Deployment diagram support, the follow-up `jmuir-dtu.3` deliberately deferred
  (a distinct diagram type, out of scope for that pass's "no new diagram types" instruction) —
  picked up as its own explicit follow-up. New `diagramTypeId: 'c4-deployment'`
  (`C4Deployment` header, added to `packages/diagram-core/src/dsl/c4.ts`'s `HEADER_TO_LEVEL`) and
  a matching `apps/api` seed catalog entry (Technical-only persona, matching `c4-component`/
  `c4-code`'s precedent — infrastructure topology is an implementation-level artifact). Confirmed
  against Mermaid's own `c4Diagram.jison` grammar that `Deployment_Node`/`Node`/`Node_L`/`Node_R`
  (`Node` is documented as simply "short name of `Deployment_Node()`", `Node_L`/`Node_R` add a
  left/right layout-alignment hint with no rendering equivalent here — accepted, not modeled, same
  treatment as the other pure layout hints already in this file) are grammatically the *exact same*
  nestable-boundary construct as `System_Boundary`/`Container_Boundary`/`Enterprise_Boundary` — so
  implemented as more accepted keywords on the same `BOUNDARY_START` pattern rather than a parallel
  code path, with arbitrary-depth `Deployment_Node` nesting (an infrastructure tree) and regular C4
  elements (`Container`, `Component`, ...) nesting inside exactly like inside a `System_Boundary`
  already did. Serialization picks `Deployment_Node(...)` vs `System_Boundary(...)` purely from
  `model.diagramTypeId`, not a per-container flag, since every container in a `c4-deployment` model
  necessarily came from `Deployment_Node`-family parsing. Deliberately lenient, matching
  `System_Boundary`'s own pre-existing (unenforced) header-scoping: `Deployment_Node` parses
  successfully even inside a `C4Context` diagram, same as `System_Boundary` always could. The
  optional third `"type"` string arg (e.g. `Deployment_Node(live, "Live", "Azure")`) is accepted
  but not modeled/round-tripped, matching this file's established "capture optionally, don't
  model" precedent for `Person(...)`'s own optional description arg.
- `jmuir-dtu.6`: ER diagram gaps beyond feature 003, second `jmuir-dtu` child picked up.
  `packages/diagram-core/src/dsl/erd.ts` gains entity aliases (`id[Alias Label]`, standalone or
  combined with an attribute block start `id[Alias Label] {`) — the entity's own `id` stays the
  identifier used everywhere else (relationships, attribute blocks), alias resolution is
  order-independent (a relationship referencing the entity before its alias line appears later in
  the file still ends up correctly aliased); a top-level `direction TB|BT|LR|RL` statement, reusing
  `DiagramModel.direction`/`FlowchartDirection` (now documented as shared by both flowchart and ER,
  not flowchart-only); and `style`/`classDef`/`class`/the `:::` shorthand, identical grammar and
  second-pass-application precedent to flowchart's own `style`/`classDef` support (jmuir-dzd
  grouping C) — folds into the existing `NodeStyle` fill/stroke fields, unrecognized properties and
  unknown ids silently ignored. Entity styles now round-trip via a `canvas.styles` front-matter
  block that `serializeErd` previously never emitted at all (a real, separate pre-existing gap this
  closes as a side effect). Also fixes a genuine, independently-confirmed bug: an entity with no
  attribute block and no relationship (an alias-only declaration, or any bare standalone entity —
  now also valid syntax on its own, matching Mermaid's own grammar where the relationship half of
  an entity line is optional) used to vanish entirely on serialize; FR-003 requires no element be
  silently dropped. Two more bugs found and fixed during test-writing: `style`/`classDef`/`class`
  directives were checked *after* the relationship pattern, so a single-character entity id like
  `o` (a plausible abbreviation for "Order") collided with the relationship regex's cardinality
  character class and misparsed `style o ...` as a bogus relationship — reordered to match
  flowchart-parser.ts's own directive-before-edge ordering; and an aliased entity appearing only in
  a relationship (no attribute block) lost its alias on serialize, since a relationship line only
  ever references an entity by its bare id — fixed with an explicit alias-declaration pass before
  the edges loop.
- `jmuir-dtu.3`: C4 diagram gaps beyond feature 003, first child of the `jmuir-dtu` "Mermaid DSL
  full-compliance roadmap" epic to be picked up. `packages/diagram-core/src/dsl/c4.ts` gains the
  full Db/Queue/`_Ext` element-kind matrix (`SystemDb_Ext`, `SystemQueue(_Ext)`, `ContainerDb(_Ext)`,
  `ContainerQueue(_Ext)`, `ComponentDb(_Ext)`, `ComponentQueue(_Ext)` — Db reuses the existing
  `cylinder` shape, Queue reuses `stadium`, `_Ext` variants collapse to their base kind's role+shape
  exactly like the pre-existing `Person_Ext`/`System_Ext`/etc already did); `BiRel`/`Rel_Back`/
  directional `Rel_U`/`D`/`L`/`R` (and `Up`/`Down`/`Left`/`Right` long forms) — `BiRel` sets
  `arrow: 'both'`, `Rel_Back` swaps source/target endpoints (mirrors canvas-7rr's "Reversed" edge
  direction, no new arrow value needed), directional hints parse successfully but have no
  layout-model equivalent here (accepted, not modeled, same treatment as the new
  `UpdateLayoutConfig` macro); and `UpdateElementStyle`/`UpdateRelStyle` (both the positional and
  named `$key="value"` argument forms) folding into the existing `NodeStyle` fill/stroke fields —
  properties with no modeled equivalent (`textColor`, `offsetX`/`offsetY`, `shadowing`, ...) are
  silently ignored, matching flowchart's own `style`/`classDef` "other properties silently ignored"
  precedent exactly, including applying styling macros as a second pass after all elements/edges
  are parsed so a forward reference or an unknown id doesn't hard-error. Edge styles now round-trip
  via a new `canvas.edgeStyles` front-matter block, mirroring flowchart's `linkStyle` round-trip.
  `C4Deployment` (`Deployment_Node`/`Node_L`/`Node_R`) was explicitly excluded from this pass — a
  distinct C4 diagram type, not just more vocabulary within the existing four — per this session's
  "no new diagram types" scoping; filed as `jmuir-dtu.3.2`, not silently dropped.
- `canvas-esn`: no way existed to auto-arrange a diagram — every node/container position was set
  manually (drag, or the grid-placement fallback used when adding a shape).
  `DiagramModel.direction`/`DiagramContainer.direction` already round-tripped through the DSL but
  neither drove layout, per both fields' own doc comments. Adds a new `autoLayout()` pure operation
  in `packages/diagram-core` (backed by the newly-added `@dagrejs/dagre`) and a "Auto Layout"
  button + TD/LR/BT/RL direction picker in `Canvas.tsx`'s toolbar, gated to flowchart-family
  diagrams (`dslFamily === 'flowchart'`, the same scoping `getAddableShapes` already uses) — C4,
  architecture, ERD, UML, and sequence are out of scope (sequence in particular is fundamentally
  not a DAG-layout problem). v1 is deliberately FLAT: only container-less nodes and top-level
  containers (as one sized unit each) are laid out directly by dagre; a container's own contents
  keep their existing position *relative to* it via the existing `moveContainer` (already handles
  arbitrary-depth nested descendants) — full dagre compound-graph/`setParent` support, which would
  lay out *inside* every container too, is an explicit fast-follow, not attempted here since the
  dagre wiki doesn't document that feature in enough depth to commit to without its own spike.
  `nodeSize`/a new `containerSize` were exported from `svg-renderer.ts` (matching the existing
  `computeBounds`/`clipEdgeEndpoint` reuse pattern) so `autoLayout` sizes dagre's input nodes
  identically to how both renderers already do, rather than adding a third/fourth hand-copied
  default. Edges are untouched — still drawn as straight lines between the new positions; no use of
  dagre's `points` polyline output in v1.
- `canvas-u7e`: `Canvas.tsx` imported `removeEdge` but never called it — edges had no selection
  state, no click handler, and no way to delete one short of removing an endpoint node (which
  cascades but also destroys the node) or hand-editing the DSL. A new `selectedEdgeId` state
  (single-select, mirroring `selectedContainerId`'s own pattern rather than folding into the
  multi-select `selectedIds` used for nodes) tracks which edge, if any, is selected; a new
  `handleEdgePointerDown` sets it and clears any node/container selection (and vice versa — the
  three selection kinds are mutually exclusive). A selected edge's `<line>` turns the same
  `SELECTION_STROKE` blue used for node selection (now exported from `shapes.tsx` for reuse). The
  existing Delete Selected button and Delete/Backspace shortcut now also work when only an edge is
  selected, calling the existing `removeEdge` operation via the same confirm-dialog flow, with a
  new connector-specific message. `removeEdge` only ever touches the edge itself — endpoint nodes
  are untouched.
- `canvas-0s3`: `Canvas.tsx` rendered its `<svg>` at a hardcoded 800x500 regardless of actual
  content, so a shape placed beyond that became clipped and unreachable — no scrollbar, no pan.
  The SVG now sizes itself to `Math.max(measured visible container via ResizeObserver, actual
  content bounds via a newly-exported `computeBounds` from `svg-renderer.ts`)`, so
  `.editor__canvas`'s existing `overflow: auto` finally has something to scroll to. Two additional
  CSS bugs were found and fixed along the way: `.editor__body`'s grid had no `grid-template-rows`
  (its implicit row auto-sized to content instead of staying capped at available viewport space),
  and `.app-shell` used `min-height: 100vh` (a floor, not a cap, so a tall canvas grew the entire
  page instead of scrolling internally) — changed to `height: 100vh` with `.app-content` gaining
  `overflow-y: auto` as the one scroll region other screens (e.g. the Projects list) now rely on
  instead of page-level scroll.
- `canvas-mup`: `style-affordance.spec.ts`'s "clicking Clear" test flaked intermittently since
  PR #41 (`canvas-i2q`), then started reproducing on every CI run. Root cause: a single-shot
  `dsl-panel.inputValue()` read immediately after clicking Clear raced the click's React state
  update, occasionally reading stale content still containing the cleared color. `updateNodeStyle`/
  `mergeStyle` themselves were already correct — this was a test-timing bug, not a product bug.
  Fixed with `expect.poll()` instead of a single-shot read.
- `canvas-3vq.3` (third and last of the canvas-3vq "Option A" navigation-flow epic, now complete):
  `GET /projects` takes no query params (the clarified scale was assumed to be "tens of projects"),
  but the dev DB alone had 600+ accumulated test-debris projects rendered unpaginated in one page.
  Since the full list is already fetched in one call, adds a plain client-side filter
  (`projects-page-filter`) over the already-fetched array — zero API change, no network request per
  keystroke.
- `canvas-3vq.2` (second of the canvas-3vq "Option A" navigation-flow epic): `ProjectsPage.tsx` was
  a dead end (`docs/navigation-flow-brief.md` Finding A) — clicking a project's name did nothing,
  and there was no way to reach that project's diagrams short of closing the screen and using the
  header's `ProjectPicker` `<select>` instead. Adds an always-visible "View Diagrams" button per
  row that switches to that project and returns to `ProjectBrowser`, reusing `App.tsx`'s existing
  `applyProjectChange`/`setViewingProjects(false)` — no new state shape. `ProjectBrowser` gains a
  breadcrumb naming the current project with a link back to Projects, wired to the existing
  `requestViewProjects` guard — same unsaved-changes confirm dialog the header's own "Projects"
  button already uses.
- `canvas-3vq.1` (first of the canvas-3vq "Option A" navigation-flow epic, from
  `docs/navigation-flow-brief.md` Finding B): `GET /projects/:projectId/diagrams?query=&type=`
  already existed, fully implemented (`search.service.ts`) and perf-tested at 1,200 diagrams
  (`search.perf.test.ts`, SC-007), but had zero frontend callers — `ProjectBrowser.tsx` always
  rendered the full recursive project/diagram tree with no way to narrow it. Adds a search input
  and diagram-type filter above the tree; while either is active, results render as a flat list via
  a new shared `DiagramRow` component (Open/Move/Delete identical to the tree view, same testids)
  instead of the recursive tree, and clearing both returns to the unmodified tree view. Known,
  documented (not fixed) limitation carried over from the brief itself: the search only covers the
  current project's own direct diagrams, not recursively into child projects — harmless today since
  this app has no UI to create nested projects, so every project's diagram set is one level deep in
  practice. No backend changes.
- `canvas-23t.4`: every diagram type's `default_palette_library_ids` included `"generic"`, whose
  five entries (Rectangle, Rounded Rectangle, Circle, Diamond, Cylinder) are non-visual shape-alias
  sentinels, not real icon artwork — they duplicated the shape toolbar and rendered as broken,
  artwork-less boxes when placed via the icon search path. Drops `"generic"` from `CLOUD_LIBRARIES`
  and every c4-* type (already have azure-icons/aws-icons or c4-notation); kept as the sole entry
  for diagram types with no other icon library at all (plain flowchart variants, sequence, erd,
  uml). Written test-first against the real `seedDiagramTypes()` function — `libraries.test.ts`'s
  existing cloud-infrastructure test already hardcoded the "correct" answer via a manual `INSERT`,
  which never exercised the real seed data and would not have caught this bug.
- `canvas-228.2` (third and last of the canvas-228 "project management" sub-features — the epic
  is now complete): no `deleteProject` route existed at all. New migration
  (`0008_project_soft_delete.sql`) adds `deleted_at`/`deleted_by_user_id`/`restored_at`/
  `restored_by_user_id` to `projects`, mirroring diagrams' own soft-delete columns exactly. `DELETE
  /projects/:id` (owner-or-admin) rejects with a 409 unless the project has zero direct diagrams
  and zero child projects (the latter a defensive guard — this app has no UI to ever create a
  nested project). `projectExists`/`ancestorChain`/`ACCESSIBLE_PROJECT_IDS_SQL` and
  `getProject`/`renameProject`/`getProjectTree` all now treat a soft-deleted project as not-found
  for every regular purpose, matching a soft-deleted diagram's existing behavior. Admin recovery
  mirrors `DeletedDiagramsPage` exactly: new `GET /admin/deleted-projects` +
  `POST /projects/:id/restore` (admin-only, 30-day window) and a new `DeletedProjectsPage.tsx`, a
  sixth `AdminShell` destination. Delete surfaces as a button on each manageable row of the
  Projects screen, disabled with an explanatory title whenever the project still has diagrams.
  Written test-first (14 new contract tests).
- `canvas-228.3` (second of three canvas-228 "project management" sub-features): no
  `updateProject` route existed — a project's name was permanent once created — and there was no
  way to move an existing diagram to a different project. Rename: new `PATCH /projects/:id`,
  gated by a new `requireProjectOwnerOrAdmin` middleware (a direct copy of the existing
  `requireDiagramOwnerOrAdmin` pattern — ownership only, not the permissive edit-share ladder),
  surfaced as a click-to-edit control on each owned row of the Projects screen (canvas-228.1).
  Move: new `PATCH /diagrams/:id/project`, needing a two-resource check with no existing
  precedent — `requireDiagramAccess('edit')` on the diagram plus a manual destination-project
  edit check inside the handler (the destination id arrives in the body, not a route param) —
  surfaced as a new "Move" action on each `ProjectBrowser` diagram row, opening a `Modal` with a
  destination-project picker. Written test-first (13 new contract tests).
- `canvas-228.1` (first of three canvas-228 "project management" sub-features): `createFirstProject`
  in `App.tsx` only rendered when the user had zero projects — once they had one, there was no way
  to create another, and no dedicated project-management surface existed at all. Adds a new
  `ProjectsPage.tsx`, reachable from anywhere via a "Projects" button in `AppShell`'s header (shown
  once the project list has loaded, unlike `ProjectPicker` which needs ≥2 projects to render at
  all); lists every accessible project with its diagram count and lets the user create another via
  the same `createProject` API. Navigating to it is guarded by a new `requestViewProjects`, added
  alongside — not inside — the existing `requestGoHome`, so its own confirm dialog and testids stay
  untouched. `GET /projects` now returns each project's direct non-deleted diagram count
  (`diagramCount`), needed here and for `canvas-228.2`'s upcoming "delete only if empty" rule.
- `canvas-xig`: manually coloring a shape or connector was only possible via AI chat (canvas-kwa)
  or hand-editing the DSL panel's `style`/`classDef`/`linkStyle` syntax. Adds a second, separate
  small icon next to the existing pencil edit-affordance — not merged into the same popup, so
  `label-affordance.spec.ts`'s rename-flow coverage stays untouched — that opens a small
  color-picker popup: fill color for shapes, stroke color for connectors, reusing
  `updateNodeStyle`/`updateEdgeStyle` exactly as canvas-kwa built them. `diagram-ops.ts`'s
  `StylePatch` fields widen to `string|null|undefined`: an explicit `null` clears a field back to
  unset (the popup's Clear button), distinct from omitting one (unchanged AI-tool behavior).
  Two real bugs found via e2e coverage and fixed before shipping: Escape didn't close the popup
  (nothing moved focus into it on open — fixed with `autoFocus` on the color input) and the
  connector's affordance could land inside the adjacent node's own rect for the standard
  close-together two-node layout, making it unclickable (nodes paint over edges) — fixed by
  stacking it vertically above the pencil instead of beside it.
- `canvas-uaq`: export always read the diagram's last-SAVED `dslContent`, never live editor
  state, with no warning. Reproduced live: exporting right after adding shapes but before Save
  downloaded a near-empty Mermaid file and a technically-valid-but-blank SVG/PNG — no separate
  rendering bug found (`resvg-js`/`renderToSvg` output was structurally sound). `ExportMenu` now
  takes `hasUnsavedChanges` (from `DiagramEditor`'s existing local value) and disables all three
  export buttons with an explanatory tooltip plus a visible "Save to enable export" message
  whenever there are unsaved changes.
- `canvas-40t`: `ProjectBrowser.tsx`'s `confirmDelete` had no try/catch around
  `api.deleteDiagram` — `DELETE /diagrams/:id` requires `requireDiagramOwnerOrAdmin()`, so a user
  with only edit access (not the owner, not an admin) got a 403 that left the confirm dialog open
  forever with no error, indistinguishable from a hang. Now closes the dialog and shows the
  server's actual message via a new `delete-diagram-error` alert, matching
  `DeletedDiagramsPage`'s existing restore-error pattern.
- `canvas-7rr`: `Canvas.tsx`'s connect-mode `addEdge` call had no arrow parameter — every
  interactively-drawn connector defaulted to a plain forward arrow, with no way to reverse it or
  make it bidirectional/arrowless short of drawing a second edge on top to fake it.
  `DiagramEdge.arrow` already supported `'none'`/`'both'` with both renderers already drawing them
  correctly — purely an interactive-authoring gap. `addEdge` (diagram-core) gained an optional
  `arrow` input; the toolbar shows a "Direction" picker (Forward/Reversed/Bidirectional/No
  arrowhead) only while connect mode is active. "Reversed" needs no `arrow` value — it's just
  `sourceId`/`targetId` swapped at the moment the second shape is clicked, so one connection
  replaces what used to require two.
- `canvas-kwa`: `createDiagramTools` exposed exactly 6 tools (add/remove node, add/remove edge,
  update node/edge label) — none could set or change a node's or edge's style, even though
  `NodeStyle` (fillColor/strokeColor/strokeWidth/strokeDasharray) was already a full model field,
  fully expressible via DSL (`style`/`classDef`/`linkStyle`). Adds `updateNodeStyle`/
  `updateEdgeStyle` pure operations to `diagram-core` (merging a partial patch onto any existing
  style — only the fields supplied change) plus matching AI tool wrappers following the existing
  not-found-reports-a-reason convention. `mock-nlu.ts` gained a "make/color X `<color word>`" rule
  so an e2e spec (`ai-node-color.spec.ts`) can exercise the new tool through the real HTTP/tool-
  execution/persistence pipeline, no real LLM call, matching every other mock-NLU-backed spec.
- `canvas-f9q`: only `CreateViaChatDialog` ("Create via AI Chat", for a brand-new diagram) ever
  collected a persona. FR-008a fixes a diagram's persona at its first chat message, but any
  diagram not created through that one dialog — imported, hand-created, or created via the plain
  "New Diagram" flow — had no UI path to ever set one, permanently stuck on the default assistant
  prompt (found live during T033 validation, jmuir-4m0.1: imported a diagram, used its chat, had
  no way to pick a persona). `ChatPanel` now shows the same optgroup-by-category picker before a
  diagram's first message, hidden again once history exists since the choice no longer does
  anything past that point; the selection is passed through as `personaId` on that first
  `sendChatMessage` call. `groupByCategory` had been duplicated three ways
  (`PersonaAdminPage`/`CreateViaChatDialog`/now `ChatPanel`) — extracted to a shared
  `persona-grouping.ts` so the three pickers can't drift apart.
- `canvas-23t.1` (post-005 UI consistency review, `docs/ui-review-brief.md` finding #1 — the one
  screen the review called genuinely broken, not just unremarkable): `PersonaAdminPage.tsx` had
  zero classNames anywhere, and each persona's `<textarea>` (an inline-level replaced element with
  no flex/grid container around it) visibly overlapped the next category heading and crowded its
  own Archive button. Each persona is now its own bordered `.card` with a `.row` header (name,
  status, Archive) and the prompt textarea beneath it; categories use `.section-label` headings;
  lists reuse the existing `.project-node__list`/`.stack` utilities for spacing. The chat-enabled
  toggle and create-persona form reuse the same `.card`/`.field` primitives already used elsewhere
  (`SharedDiagramsList`, `StandardsEditor`) — the minimum-bar option from the bead's own open
  question, not a bespoke persona-card redesign. No testids, element types, or behavior changed.
- `canvas-23t.2` (part of the post-005 UI consistency review, `docs/ui-review-brief.md` finding
  #2): `project-switch-confirm` and `home-nav-confirm` (both in `App.tsx`) were plain
  `<div role="alertdialog">`s with no overlay scrim, centering, or `--shadow-modal`/`--radius-xl`
  panel — a gap `home-nav-confirm` inherited by deliberately mirroring the pre-existing
  `project-switch-confirm`, not a regression of its own. Both now render through the existing
  `ui/Modal.tsx`, matching every other dialog in the app and `ui-design-spec.md` §3.4. Existing
  testids and `role=alertdialog` semantics are unchanged.
- Editor "back to Diagrams" navigation: once a diagram was open, there was no way back to the
  project browser short of switching to a different project (a no-op if you picked the current
  one) or signing out. The doc-bar gains a "Diagrams" button (`DiagramEditor`'s new
  `onRequestClose` prop); `App.tsx`'s new `requestGoHome` guards it exactly like
  `requestProjectChange` already guards switching project — same unsaved-changes check via
  `diagramEditorRef`, same discard/keep-editing confirm pattern, just worded for "returning to
  Diagrams" and under new testids (`home-nav-confirm`/`confirm-home-nav`/`cancel-home-nav`) rather
  than reusing the project-switch ones. Reuses the existing `chevron-right` icon (already
  flipped 180° for "back" in `AdminShell`'s own back link) via a new generic `.icon--flip`
  utility, rather than a new icon asset.
- Feature 004 (AI-assisted diagram chat) completion + a real bug fix found via live-provider
  validation (T033, `jmuir-4m0`/`jmuir-4m0.1`): all 33 tasks were already implemented, but the
  final manual-validation task against a real (non-mock) AI provider had never been run. Doing so
  surfaced a genuine bug the mock-provider e2e suite could never catch (it only ever exercises
  single-node creation with no edges): describing a multi-step business process, a real model
  correctly created every node via `addNode` but then failed every `addEdge` call, since it had no
  way to learn the opaque generated ids `addNode` had just assigned — it could only guess (the
  label text, `"node-1"`, `"0"`, ...), and every guess was rejected. `diagram-tools.ts`'s `addNode`
  tool result now also returns the new node's `nodeId` (the persisted/API-facing `toolCalls`
  summary is unchanged — only the value fed back to the model for that turn gained the field),
  plus a note in the tool's description telling the model to use it for `addEdge`. Re-validated
  against the real Anthropic API post-fix: a full "order comes in, gets validated, then approved
  or rejected" description now produces a correctly wired 5-node, 4-edge flowchart with a proper
  Yes/No decision branch.
- Project-switch unsaved-changes race fix (`canvas-eow`): `App.tsx` used to learn whether the open
  diagram had unsaved edits through a child->parent mirror — `DiagramEditor.tsx` computed
  `hasUnsavedChanges` synchronously but reported it to `App` via a `useEffect` calling
  `onUnsavedChangesChange`, which only lands on `App`'s NEXT render, one commit after the child's
  own DOM update. A project switch requested in that gap read a stale `false` and silently
  discarded unsaved work instead of confirming — a real race, not a test defect. `DiagramEditor`
  is now a `forwardRef` exposing `hasUnsavedChanges: () => boolean` via `useImperativeHandle`;
  `App` reads it synchronously through a ref at the moment of the switch request instead of a
  mirrored `useState`. Verified against the live dev server (15 repeated runs of the exact flaky
  e2e scenario, all passing) rather than just unit/type checks, since the bug only manifested as
  real browser event timing.
- Icon artwork rendering fix (`canvas-8n7`, not part of the flowchart-completeness-brief
  groupings): grew beyond its original filing during investigation — the bug's own premise
  ("export already renders the true icon") was false in production; `export.service.ts` called
  `renderToSvg(model)` with no `resolveIcon` at all, so real exports never drew icon artwork
  either. Fixed in four places: (1) `flowchart-parser.ts` now infers shape `'icon'` when a
  bracket-matched-as-`'rectangle'` node carries an icon ref in front-matter (the two shapes share
  identical `[label]` delimiters, so a saved icon node previously reverted to a plain rectangle on
  reload) — an already-unambiguous explicit shape like `cylinder` carrying icon metadata is never
  overridden; (2) `library.service.ts` gained a batched `resolveIconAssets` lookup and
  `export.service.ts`'s `exportSvg`/`exportPng` are now async and wire a real `resolveIcon`; (3)
  `Canvas.tsx` resolves `node.icon` refs to real SVG markup via a new `api.getLibraryIcons` call,
  cached per library+version, and draws it the same way `svg-renderer.ts`'s `renderNode` already
  does (SC-004) — via an SVG `<image>` element's `data:` URI (`iconMarkupToDataUri`), not
  `dangerouslySetInnerHTML`: browsers never execute script/event-handler content loaded as an
  image resource, a stronger guarantee than string sanitization alone (GitHub code scanning's
  Bearer check correctly flagged the original `dangerouslySetInnerHTML` version as unsanitized-
  input XSS, even though `assetRef` is also sanitized at admin-only library-ingestion time); (4)
  `shapes.tsx` gained a `case 'cylinder'` (was silently a
  plain rectangle on canvas only). Rendering real icon thumbnails in the Palette picker itself
  (currently text-only) was explicitly scoped out after discussion.
- Edge arrowhead visibility fix (`canvas-1rq`, not part of the flowchart-completeness-brief
  groupings): edges were drawn center-to-center with nodes rendered on top, hiding the arrowhead
  (and the line segment inside each node) underneath the target's opaque fill. Both renderers now
  clip each endpoint to the node's own shape boundary via a new shared `clipEdgeEndpoint` (exported
  from `svg-renderer.ts`, same reuse pattern as `splitLabelLines`) — exact ellipse boundary for
  circle/double-circle, exact rhombus boundary for diamond, rectangle bounding-box intersection for
  every other shape. Endpoint is clamped so it never crosses past the other node's own center.
  Canvas and export call the identical function, so they can't disagree (SC-004).
- Multi-line node/edge labels via `<br/>` (grouping F of `docs/flowchart-completeness-brief.md`,
  tracked under bead `jmuir-dzd` — not its own numbered spec): a literal `<br/>` (any case,
  self-closing or not) or a raw newline in a label now renders as an actual line break (stacked
  `<tspan>`s) instead of literal text. Rendering-only — label capture was already a greedy `.+`, so
  no parser/model change. `splitLabelLines` is exported from `svg-renderer.ts` specifically so the
  interactive canvas imports and reuses the same split logic rather than reimplementing it, so the
  two renderers can never disagree about where a label breaks (SC-004). Applies to node and edge
  labels; container/subgraph captions were deliberately left single-line-only, a scope line drawn
  on purpose since real-world subgraph titles are essentially always short. Has an e2e spec — unlike
  grouping E, this one IS visually distinguishable on the canvas.
- Subgraph direction override (grouping E of `docs/flowchart-completeness-brief.md`, tracked under
  bead `jmuir-dzd` — not its own numbered spec): a `direction <TD|LR|TB|RL|BT>` statement inside a
  `subgraph`/`end` block sets that container's own layout direction. Unlike style/classDef/
  linkStyle, this is native Mermaid grammar with no generic field to fold into — `DiagramContainer`
  gained its own `direction` field and the serializer emits a real `direction` line, not a
  front-matter entry. Only recognized inside a subgraph body; a top-level `direction` line is an
  error like any other out-of-place construct. Scoped to parse/serialize fidelity only — per the
  brief's own note, neither the top-level direction nor a subgraph override drives auto-layout
  today, and this grouping deliberately left that alone. No e2e spec: purely textual/import
  fidelity with nothing visually distinguishable to assert, same as the `style` directive and
  `graph` alias groupings before it.
- classDef/class flowchart styling (grouping C of `docs/flowchart-completeness-brief.md`, tracked
  under bead `jmuir-dzd` — not its own numbered spec): Mermaid's `classDef <name> <props>` defines a
  named style and `class <id1>,<id2>,... <name>` assigns it to one or more nodes. Reuses the same
  prop parser as `style`/`linkStyle` (fill/stroke/stroke-width/stroke-dasharray; other properties
  silently ignored) and folds directly into the existing `NodeStyle` field — no model or serializer
  change needed. Same import-compatibility precedent as `style`/`linkStyle`: front-matter remains
  the canonical round-trip mechanism, `classDef`/`class` lines are never re-emitted on serialize. A
  `class` line may reference a `classDef` declared later in the file; an explicit `style` directive
  on the same node overrides its class-applied properties.
- Additional flowchart edge/link syntax (grouping B of `docs/flowchart-completeness-brief.md`,
  tracked under bead `jmuir-dzd` — not its own numbered spec): Mermaid's dotted (`-.-`/`-.->`),
  thick (`===`/`==>`), no-arrowhead (`---`), bidirectional (`<-->`), and invisible (`~~~`) edge/link
  connectors, plus chained edges on one line (`A --> B --> C`) and fan-out via `&`
  (`A --> B & C`). `DiagramEdge` gained a `lineStyle` field; `arrow` now also accepts `'both'`. Both
  renderers give dotted/thick a default dasharray/width (overridable by an explicit `linkStyle`) and
  correct marker treatment for invisible/no-arrow/bidirectional edges. The serializer canonicalizes
  chains/fan-out to separate plain edges on output rather than re-compressing them.
- linkStyle edge styling (PR #12, alongside 009 — not its own numbered spec): Mermaid's
  `linkStyle <index[,index...]|default> <props>` directive is now supported — edges are styled by
  0-based declaration order (not the platform's internal `e1`/`e2` ids), with stroke color/width/
  dasharray. `DiagramEdge.style` already existed on the model but neither renderer read it;
  `NodeStyle` gained `strokeWidth`/`strokeDasharray` (closing part of the same "parsed but ignored"
  gap for node `style` too). Round-trips via front-matter (`canvas.edgeStyles`), mirroring how node
  `style` already round-trips rather than re-emitting `linkStyle` lines literally.
- Real Azure Architecture Icons (PR #12, alongside 009 — not its own numbered spec): the 8-icon
  placeholder `azure-icons` manifest is replaced with 257 real Microsoft icons across Compute/
  Storage/Database/Networking/Security/Identity/Containers/Analytics/IoT, generated by
  `packages/diagram-core/scripts/generate-azure-icons.mjs` from a local, gitignored copy of
  Microsoft's official download — each icon uniformly scaled into the renderer's normalized 48x48
  space, never a distorting scale, per Microsoft's published usage terms. The placeholder's
  synthetic `blob-storage` id is renamed to the real `storage-accounts` icon it now maps to (the
  current pack has no separate Blob Storage icon).
- 009-flowchart-node-shapes: Feature 002 deferred "additional node shapes" as a named follow-up;
  this adds the seven Mermaid flowchart shapes still missing (stadium, subroutine, double-circle,
  hexagon, parallelogram, trapezoid, asymmetric) — parsed, rendered (canvas and export), and
  authorable from a toolbar that becomes diagram-family-aware for the first time (scoped by
  `dslFamily`, not `diagramTypeId`, since six diagram types share the flowchart family). Standards
  enforcement needed no code change — already generic over `NodeShape`.
- 008-shared-diagram-access: A user granted access to a diagram, but not the project containing
  it, previously had no way to discover or reach it, and the home screen actively told them they
  had no work. Adds one self-scoped read endpoint listing a user's direct diagram-level grants and
  a home-screen section rendering it; access resolution (`resolveDiagramAccess`) is unchanged —
  this closes a discovery gap deliberately left open by feature 007's access-control fix, not a
  new access rule.
- 007-project-context: The project a user works in becomes real application state with an
  in-app chooser, instead of a query parameter the UI read but never wrote (landing on the root
  and clicking New Diagram failed outright). Projects gain an `owner_id`, and project visibility
  becomes access-controlled — closing a pre-existing hole where any signed-in user could read any
  project's entire diagram tree by id, since no route taking a project id checked more than
  authentication.
  resize, drag membership; deleting one releases its shapes) backed by seven new `diagram-core`
  operations; a shared admin shell centres every admin screen and adds persistent navigation; a
  visible affordance for the existing label editor; standards gain a name, description and
  retirement date; version history is capped at five with search.
  stylesheet at all. Adds a global CSS token layer, restructures the diagram editor into a
  document bar plus a palette rail and a tabbed secondary rail (DSL/Chat/Issues/History),
  converts dialogs to native modals, and defines empty/loading/error states. Diagram element
  rendering and the export renderer are deliberately untouched; admin screens inherit
  bare-element styling without being edited.
  author "AI personas" (name, architect-category tag, system prompt); users pick one to generate
  a diagram via natural language, then keep refining it through a persistent in-editor chat panel
  that applies targeted `diagram-core` operations (new `addNode`/`addEdge`) rather than
  regenerating the whole diagram.
  a hard defect — only plain `--` worked); ER diagrams support attribute blocks (`{ type name
  PK/FK/UK }`); sequence diagrams support notes and nestable control-flow blocks (`loop`/`alt`/
  `opt`/`par`/`critical`/`break`); and `%%` comments are now honored in every parser, not just
  flowchart's.
  deletion (with confirmation), diagram soft-delete + admin restore, and flowchart parser
  extensions (`graph` header alias, `style` directive, `%%` comments).
  for a governed, multi-persona (Business/Enterprise/Solution/Technical Architect) diagramming
  platform with Mermaid DSL/SVG/PNG export and Azure/AWS icon libraries.

<!-- MANUAL ADDITIONS START -->
<!-- MANUAL ADDITIONS END -->


<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:6cd5cc61 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->
