# canvas Development Guidelines

Auto-generated from all feature plans. Last updated: 2026-08-08

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
