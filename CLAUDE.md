# canvas Development Guidelines

Auto-generated from all feature plans. Last updated: 2026-07-29

## Active Technologies
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
