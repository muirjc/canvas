# canvas Development Guidelines

Auto-generated from all feature plans. Last updated: 2026-10-02

## Active Technologies
- `mermaid` (`12.2.0`, exact) added to `apps/web` as a **test-only devDependency** (canvas-8ucs) -- the version
  GitHub runs (`GITHUB_MERMAID_VERSION`), used only by `tests/e2e/mermaid-export.spec.ts` to draw every corpus
  export in Chromium. Not shipped; not in the notices. Lockfile: npm dropped rollup's platform packages when it
  was added -- they were put back by hand (check `@rollup/rollup-*` entries survive any lockfile regeneration).
- `qrcode` (`1.5.4`, exact) added to `apps/web` (canvas-ez1.5, two-step verification) — renders
  the authenticator-app set-up QR code client-side. Its only use; TOTP itself is implemented
  in-house (`apps/api/src/auth/totp.ts`, RFC 6238 on `node:crypto`), no OTP library.
- `jose` (`^6.2.2`) added to `apps/api` as a **test-only devDependency** (canvas-haz epic,
  Microsoft Entra ID migration) — resolves to the copy already transitively installed by
  `openid-client`, so nothing new is actually downloaded. Used solely by
  `tests/contract/oidc-callback.test.ts` to generate an RS256 keypair and sign synthetic ID tokens
  for a locally-controlled fake IdP; no production code imports it.
- `kysely` (`^0.29`) added to `apps/api` (canvas-jtm epic) — a typed SQL query **compiler**, not
  an ORM (Constitution Principle VI amended, v1.1.0, to explicitly draw that line), replacing raw
  `pg.Pool`/hand-written SQL string queries across every `apps/api/src` file. `better-sqlite3`
  (`^13`) added alongside it as a second supported Kysely dialect: `apps/api` now runs against
  **either PostgreSQL (default) or SQLite**, selected by `DB_CLIENT`/`TEST_DB_CLIENT` — see
  `RUNBOOK.md`'s "Database engine" section and `docs/solution-architecture-document.md` §12 for
  the SQLite-is-dev/small-deployment-only trade-off. Schema changes bundled into the same epic:
  all 7 `TEXT[]` array columns became real join tables (native arrays have no SQLite equivalent)
  and every table's `id` became app-generated (`crypto.randomUUID()`) instead of a DB-side
  `gen_random_uuid()` default, removing the `pgcrypto` extension dependency entirely. SQLite's own
  schema is one squashed migration (`apps/api/migrations/sqlite/0001_init.sql`) expressing the
  final shape directly, not a replay of the 13 incremental Postgres-only migrations. CI
  (`.github/workflows/ci.yml`) runs `apps/api`'s suite as a `db-client: [postgres, sqlite]` matrix;
  the Playwright E2E suite stays Postgres-only.
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
- TypeScript 5.x end-to-end: React frontend, Fastify backend, Node.js 26 LTS. Shared
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
apps/api-py/src/canvas_api/{routes,auth,ai,github,jobs,seed,diagram_core,front_door}  # backend (Python)
apps/api-py/{migrations,contract}                            # schema (Postgres + sqlite/), frozen API contract
packages/diagram-core/src/{model,dsl,standards,libraries}    # parser/serializer/validator (browser, validator CLI)
packages/diagram-bridge                                      # test-only TS reference for the Python port
```

## Commands

npm run test --workspace=@canvas/diagram-core && npm run test --workspace=@canvas/web
cd apps/api-py && uv run ruff check . && uv run mypy && TEST_DB_CLIENT=sqlite uv run pytest   # and =postgres

## User and admin guides

`docs/user-guide/` and `docs/admin-guide/` (canvas-unk) describe what people see. A change to
user-visible behaviour updates the matching page in the same PR; re-run
`npm run docs:screenshots --workspace=@canvas/web` (local app on AI_PROVIDER=mock, demo data only)
when a pictured screen changes.

## Code Style

TypeScript, standard conventions. `diagram-core` round-trip and standards-validation contract
tests are NON-NEGOTIABLE and must exist (and fail) before implementing any diagram-type or export
work — see `.specify/memory/constitution.md` Principle IV.

## Recent Changes
- `canvas-8uh1.4` (composite diagrams, part 4 of 7): **links reach exports and GitHub.** `RenderOptions.diagramLinkBase`
  (TS) / `render_to_svg(..., diagram_link_base=)` (Python): the start of a Canvas address (`diagram_links.
  diagram_link_base(public_url)` = `<CANVAS_PUBLIC_URL>/?diagramId=`); `withDiagramLink` / `with_diagram_link` wraps a
  linked node, group, sequence participant or Wardley element/annotation/note in `<a href>` (encodeURIComponent of the
  id, link check, XML-escaped; a node's own click link wins); no base = drawing unchanged. `toPortableMermaid({
  diagramLinkBase })` / `to_portable_mermaid(..., diagram_link_base)`: flowchart and state shapes get `click X href`
  (other families: front matter only, stripped with it). The export route and GitHub pass the base (PNG loses it).
  GitHub: `submission_links` (index rows + each target's current version, name, and its open/merged folder in the same
  repo); `SubmissionLink`; `canvas.json` gains `links` [{elementId, diagramId, versionId, versionSequence}] and the
  README a "Linked diagrams" list (relative `../<folder>/README.md` or the Canvas address) ONLY when something links,
  so other diagrams' files are byte-identical. Bridge ops take `diagramLinkBase`. Tests: diagram-links.test.ts,
  `test_exports_link_as_typescript_does` (seeded, corpus vs bridge), test_github_submit.py, test_export.py.
- `canvas-8uh1.3` (composite diagrams, part 3 of 7): **the editor makes and follows links.** Canvas: Tools
  `link-to-diagram` ("Change link…" when linked) / `remove-diagram-link` for one selected shape or group (not a
  sequence block); `renderLinkBadges` draws `diagram-link-badge-<id>` (data-status) at each linked element's corner in
  every family (Wardley beside the dot, sequence on the participant header), blue = opens, orange "!" = can't (role
  button, Enter works, read-only too). Ctrl/Cmd-click stays add-to-selection (design doc amended). `links/
  LinkPickerDialog.tsx` (project, type with the next C4 level "suggested" via `SUGGESTED_LINK_TYPES`, name search
  over `searchProjectDiagrams`; "Create and link" makes an empty diagram in this project, only when the project list
  says you may). `links/LinksPanel.tsx` = the editor's Links rail tab (links with state, Open/Change/Remove; Used in;
  `links-broken` count). `app/diagram-links.ts` `useLinkTargets`: targets from GET /links, refreshed with
  `versionRefreshToken`; a link made since the last save looked up with GET /diagrams/:id (404 = missing; other
  failures retried after a save). Trail: `navigation.ts` `readTrail`/`trailState` (history.state `canvasTrail`,
  <= 20, UUIDs only); App's `navigate(to, { trail })`, popstate restores it, following a link back up the trail
  cuts it; DiagramEditor `editor__trail` nav (`link-trail-<i>`) and `key={diagram.id}`. Tests: unit `trail`,
  `links-panel`, `link-picker`, `canvas-diagram-links`; e2e `diagram-links.spec.ts`. User guide "Linked diagrams".
- `canvas-8uh1.2` (composite diagrams, part 2 of 7): **the API knows which diagrams link to which.** Table
  `diagram_links` (Postgres `0037`, SQLite `0025`): source diagram (FK, cascade), `kind` ('link'; 'frame' for .6),
  element id, target diagram id as TEXT (no FK, so a link to a purged diagram is still found), `position`.
  `canvas_api/diagram_links.py`: `rebuild_links` from the parsed model in `create_diagram` and `_save` (so save,
  version restore, import and template import; a 409 conflict leaves it as it was); purge deletes the rows (soft
  delete keeps them, so a restore brings links back). Routes: `GET /diagrams/{id}/links` (in model order, each
  `status` available | unavailable (someone else's draft) | deleted (bin, or its project's) | missing (no such
  diagram, or not a UUID) and the target's name/type/project when available) and `GET /diagrams/{id}/used-in`
  (diagrams whose current version links here, not in the bin, not others' drafts, with their element ids); both
  view access, 404 for a binned/missing diagram. Contract schemas `DiagramLink`, `DiagramUsedIn`. No backfill:
  nothing could make links before this (no UI yet). Tests `tests/test_diagram_links.py` (both databases).
- `canvas-8uh1.1` (composite diagrams, part 1 of 7; design `docs/composite-diagrams-design.md`): **an element can link to
  another diagram.** `DiagramRef {diagramId}` as `diagramRef` on nodes and containers; front matter `canvas.links`
  (element id -> diagram id; `isDiagramLinkId`: letters/digits/`-`/`_`, <= 100) in every family, TS + Python:
  `applyLinks` at the end of each parse (unknown ids, bad values, a non-map section dropped, never an error;
  `links` is an id-keyed section, so `constructor` works), `withLinks(fm, model, savedId)` in each writer (nodes then
  groups). State keys groups by `savedId`; sequence keeps participant links only (block/note ids are made up);
  Wardley writes front matter only when something links and keys each link by the id the element has once its text
  is read back (`wardleySavedIds`: name; pipeline parent + name; a note's place among notes), so a rename keeps the
  link. `setDiagramLink(model, elementId, diagramId | null)` (diagram-ops; Python `set_diagram_link`, in the ops
  vectors). Corpus `<family>-diagram-links` (8); `diagram-links.test.ts`; `tests/test_diagram_core_links.py` (seeded
  fuzz vs the bridge: random links + renames on every corpus diagram; caught a planted key-order bug). Nothing in the
  editor/API/exports yet (8uh1.2-.7). Portable export strips the links with the rest of the front matter.
- `canvas-4h1j.2` (Wardley maps, part 2 of 2; closes canvas-4h1j): **Wardley Map is a diagram type** (seed `wardley`,
  Business + Enterprise, descriptive starter standard; family capabilities `circle`/`rectangle`). Edits:
  `model/wardley-ops.ts` / Python `wardley_ops.py` (identical, `tests/data/wardley_ops_vectors.json` from
  `make_wardley_ops_vectors.ts`): `addWardleyElement` (kind, optional coordinates, else a stepping grid; anchor and
  component names made distinct), `moveWardleyElement` (0-1, two decimals, clamped; a pipeline component along
  evolution only; a parent carries its pipeline), `setWardleyMarkings` (strategy/inertia/evolve; a pipeline
  component only evolve -- its text line can't hold the rest), `addWardleyPipelineComponent`,
  `removeWardleyElement` (a parent takes its pipeline), `setWardleyLinkFlow` (`A +> B`), `wardleyNameTaken`. Editor:
  `canvas/WardleyLayer.tsx` draws the map from `computeWardleyLayout` (testids `wardley-element-<id>`,
  `wardley-link-<id>`, ...; never node-/edge-), dragging rewrites the coordinates (a < 2px jitter isn't a move),
  `canvas/WardleyToolbar.tsx` (Map elements; the selected element's name, coordinates, strategy, inertia, evolve,
  Add to pipeline; a link's flow, dotted, label). No containers, Auto Layout, legend, shapes or icon palette for
  wardley; Connect refuses notes/annotations/accelerators (a Mermaid link names components). AI: `addComponent`,
  `moveComponent`, `setComponentMarkings` (`strategy: none`, `removeEvolve`), `addPipelineComponent`, `setLinkFlow`
  (forward/backward/both/none); removeNode = removeWardleyElement, updateNodeLabel refuses a taken name, addEdge only
  between anchors/components; no addNode/style/group/layout tools; a primer; `describe_model` lists each element's
  [visibility, evolution] (a percentage shown as 0-1), markings and pipeline. Tests: `wardley-ops.test.ts`,
  `wardley-toolbar.test.tsx`, `test_ai_wardley_tools.py`, `test_diagram_core_wardley_ops.py`, e2e
  `wardley-map.spec.ts`. User guide: editor.md "Wardley maps".
- `canvas-4h1j.1` (Wardley maps, part 1 of 2; decided with the user: the text's coordinates are the only position,
  dragging rewrites them, no Auto Layout; part 2 = the diagram type for Business/Enterprise Architects, editor, AI,
  docs): **diagram-core reads, writes, draws and exports Mermaid `wardley-beta`** (11.14+, grammar unchanged
  11.15-12.3; TS `dsl/wardley.ts`, `model/wardley-geometry.ts`, `render/wardley-render.ts`; Python `wardley.py`,
  `wardley_render.py`; family `wardley`, `diagramTypeId` 'wardley'). Model: anchors/components/pipeline components
  are nodes (roles `anchor`/`component`/`pipeline-component`, id = name, a repeated name merges, later wins;
  pipeline child id `<parent>_<name>`, the parent's visibility); notes, annotations, (de)accelerators are nodes too
  (`~note1` ...); `node.wardley` = coordinates AS WRITTEN (0-1 or a percentage, Mermaid's toPercent) + label
  offset, strategy, inertia, evolve target, annotation number; `position` = the drawn centre (900x600 or `size`,
  48px margin). A save writes the written coordinates unless the position moved (then 0-1, two decimals, clamped).
  Pipelines = containers (role `pipeline`, `~pipeline:<parent>`, attached to the parent; box as Mermaid's, the
  parent drawn on its top edge); links = edges (`edge.wardley`: arrow, flow ports, `+'label'>`; `-.->` = dotted;
  resolved by id then label; an unknown end kept, not drawn). Statements take effect by kind, so the writer groups
  them; no front matter written. Canvas reads names more loosely (`notebook` unquoted) and quotes them on save;
  `evolve` of an unknown name is an error (Mermaid ignores it). Renderer after Mermaid's (`renderToSvg` branches on
  'wardley' like sequence; angles rounded to 2 decimals, trig constants written out, so Python needn't match libm).
  Corpus: 9 `wardley-*` + 4 `error-wardley-*` (Mermaid's own examples among them); `dsl-wardley.test.ts` (109);
  `tests/test_diagram_core_wardley.py` (seeded fuzz vs the bridge: parse, export, save as read and after moves/
  renames/stripped data, drawing; caught two planted bugs). mermaid-export.spec draws every export in Mermaid 12.2.
- `canvas-ra2f`: **Canvas builds on Node.js 26 LTS** (26.13.0, Active LTS since 2026-10-28; was 22). CI
  `NODE_VERSION: '26'`, the image's build stages `node:26-slim`, the example validator workflow, docs. Its npm
  (11.20) **blocks dependency install scripts** unless the root `package.json`'s `allowScripts` allows them: only
  esbuild has one, denied (`"esbuild": false`). The lockfile had none of esbuild's `@esbuild/*` platform packages
  (the same npm bug as rollup's, see Active Technologies), so esbuild had been downloading its binary in that
  script; the 52 entries (0.28.1 and vite's 0.25.12) were added from the registry's metadata, nothing else moved.
  Check that `@esbuild/*` entries survive any lockfile regeneration too. The validator and bridge bundles still
  target node20 (a repository's CI may run an older Node).
- `canvas-jpcn`: **the Python API runs on Python 3.15** (3.15.2; was 3.13). pyproject `>=3.15,<3.16`, ruff
  `py315` (formats `except A, B:`, PEP 758), mypy `3.15`; `uv.lock` re-resolved with no version changes (every
  compiled dependency already had cp315 wheels at its locked version). CI and the Docker image: uv 0.13.6 (the
  first that knows 3.15.2), `python:3.15-slim`. **PyYAML 6.0.3 has no 3.15 wheels**: it installs from its source
  package, pure Python (jsyaml only uses `yaml.SafeLoader`); canvas-4rlz switches back once wheels ship. Windows
  installer: python-build-standalone 20261026 / CPython 3.15.2; `licenses/windows-python` reviewed again (Expat
  2.9.0, VC++ runtime 14.51.36247, `python3t.dll`, new zstd 1.5.7 in `_zstd.pyd`, zlib-ng 2.2.4 listed as it ships
  with the build); Tcl/Tk 9 (`tcl90.dll`, `tcl9tk90.dll`, `libtommath.dll`) removed with tkinter. SBOM: a package
  built from source records its locked sdist's hash and URL. `scripts/third-party-notices.mjs` finds the venv's
  `python3.X` folder.
- `canvas-vvi.3` (live co-editing, part 3 of 3): **other people's selections in their colour.** Canvas reports every
  selected id (`onSelectedIdsChange`); `LiveSession.select` sends `select {ids}` at most every 100 ms (only when it
  changed; again after reconnecting); the hub keeps `Client.selection` (in `people`, <= 500 ids of <= 200 chars, any
  access level) and sends `selection {connectionId, ids}` to the others. `live-presence.tsx`: `personColor(userId)`
  (8 colours, none the selection blue), `othersSelections` (this tab left out; own other tab = "You, in another
  tab"). Canvas draws `OthersSelections` (outline per person, nested when several, name tag; connectors a wide
  translucent line), pointer-events none, not for sequence (computed layout). testids `others-selection-<id>`.
- `canvas-vvi.2` (live co-editing, part 2 of 3): **the editor joins live sessions.** `apps/web/src/app/live-session.ts`
  `LiveSession` (no React; tested with a fake socket and clock): `confirmed` (room model) + `pending` (sent, not
  acked) + `unsent` (flushed every 50 ms) = the view; a remote patch goes onto `confirmed` and own changes are put
  back on top; on `hello` whatever differs from the last confirmed model (edits before connecting / while
  disconnected) is sent again on the room's model; reconnects 1-30 s, stops on 1008/4401/4403/4404; pings 25 s.
  `useLiveDiagram` wraps the editor's `setModel`: each edit is diffed against the model the canvas LAST DREW and
  applied to the newest view (so an edit made before a redraw can't undo a remote change). Canvas, DSL Apply, AI
  chat and palette inserts all go through it. Editor (`DiagramEditor.tsx`): `onSaved` moves `baseVersionRef` and
  `lastSavedDsl` (anyone's Save = everyone's), `onReset` replaces the baseline (restore), `onHello` catches up when
  someone saved between load and join; `handleRestored` leaves the model to the room's reset while live; Save
  flushes first; an unsaved Create with AI draft joins only after its first save. Presence banner from the live
  people list (editors + "is watching"; HTTP heartbeat only while not live); `LiveStatusNote` ("Reconnecting…",
  off); the leave dialog says others still editing keep the changes (`othersEditing()` on the handle). DSL panel:
  a change while you type keeps your text and shows `dsl-behind` (Load latest / Apply replaces); tracked in
  state, not a ref (StrictMode renders twice: a ref mutated in render broke Apply). `edit-conflict.spec.ts` now
  refuses the live socket (`routeWebSocket`) to test the fallback; `live-editing.spec.ts` (two browsers + viewer).
  Docs: user guide "When someone else is editing", RUNBOOK "Live editing". Follow-ups: canvas-vvi.4 (check on
  Azure), canvas-yg53 (more than one replica).
- `canvas-vvi.1` (live co-editing, part 1 of 3; decided with the user: merge per element, anyone's Save saves for
  everyone, viewers watch live): **the engine and the server side; the editor doesn't use it yet** (part 2).
  `packages/diagram-core/src/live/model-patch.ts`: `diffModels`/`applyPatch`/`applyPatches` (top-level fields set/
  unset; per collection `added`/`removed`/`changed` (fields set/unset)/`order`; a change to a removed element is
  dropped). Python `diagram_core/live_patch.py` applies them identically (`tests/data/live_patch_vectors.json`,
  `make_live_patch_vectors.ts`, 2,403 patches) and checks their shape (`patch_problem`). `canvas_api/live/hub.py`:
  one in-memory room per open diagram (live model, seq, version last saved), patches applied in arrival order and
  sent to all (the sender's copy = its ack), checked at most every 100 ms per room: the patched model must write and
  read back, and every `href`/`url`/`img`/`src` must pass the link check (the writer silently drops a bad link, so the
  round trip alone misses it). `WS /diagrams/{id}/live` (`routes/live.py`) checks Origin (WEB_ORIGINS or same host),
  paused mode, the session cookie (`read_session` now takes any `HTTPConnection`) and access itself (a WebSocket
  skips the HTTP middleware), re-checks at least every 60 s. Saves/restores tell the room after commit (`saved` /
  `reset`), delete closes it. Messages and close codes: `docs/live-editing-design.md`. One API process only (rooms in
  memory). Pitfall: pytest run through `rtk proxy` hangs on these WebSocket tests; run `uv run python -m pytest`.
- `canvas-znz5`: **the performance workbook's SQL and outbound panels get data from the Python service.**
  `telemetry.py`: `instrument_queries(engine)` (SQLAlchemy cursor events, as the TypeScript Kysely hook: one
  CLIENT span per query inside a request, `<FIRST WORD> <dialect>`, `db.system.name` + `db.query.text`
  parameterised, cut at 1000), `work_span(name, attrs)` around `render svg`, `rasterize png`, `validate
  standard`, each `ai chat` model step; `configure_telemetry(app, conn, engine)` instruments the existing app
  explicitly (`FastAPIInstrumentor.instrument_app`, send/receive spans excluded): left to the distro's class
  swap, each request also emitted FastAPI dependency/endpoint INTERNAL spans, which App Insights stores as
  "InProc" dependencies. httpx was already instrumented by the distro. The exporter keeps every `db.*`
  attribute OUT of customDimensions: the workbook (monitoring.bicep) now reads the query from `data` and splits
  on `type` ("postgresql", "SQL" = SQLite). Tests: `tests/test_telemetry.py` (in-memory spans; the exporter's
  own envelope conversion; the real app in a subprocess, `tests/data/telemetry_smoke.py`). Not yet seen live
  (Azure paused, deploy needs the user's go-ahead).
- `canvas-pc76`: **a flowchart link to a subgraph connects to the subgraph.** `Start --> one` (with `subgraph one`
  anywhere in the text) used to make a separate node `one` beside the group (an extra box; the link missed the
  group). As in Mermaid's flowDb (a vertex with a subgraph's id merges into the group node), after reading,
  flowchart-parser.ts / flowchart.py drop any node whose id is a subgraph's: links keep the id and end on the
  group (renderers already draw to groups); the node's label/shape/style are dropped (Canvas keeps no flowchart
  group styles); if the node was named inside another subgraph, that becomes the group's parent (unless it would
  loop). Corpus `flowchart-link-to-subgraph`; `flowchart-subgraphs-and-styles` had recorded the bug (`b1 -->
  outer`). Editor connect mode and the AI's `addEdge` (`GROUP_ENDPOINT_FAMILIES`) accept flowchart groups; primer
  says so. The C4 e2e spec's "flowchart subgraph cannot be an end" test now checks it can.
- `canvas-lwa4` part 5 (Mermaid 12 extras, flowchart; closes canvas-lwa4): **subgraph options are read and kept.**
  `one@{ view: collapsed }` / `one@{ algorithm: elk.box }` after a CLOSED subgraph (Mermaid 11.17; Mermaid looks
  for a subgraph before an edge id) merge into `DiagramContainer.mermaidData` (new field), written back after the
  edge options (`one@{ … }`, plain ids only); Canvas still draws the subgraph open. Inside the subgraph's own body
  or with a class it's an error. The other flowchart extras from the bead (datastore/folder/bucket/console/
  browser/person shapes, edge `step`/`curve`) already worked since canvas-8wxq; state `%` alone was already
  refused. Corpus `flowchart-subgraph-options`, error case extended; parity fuzz generates options and edits them.
  Filed canvas-pc76: a flowchart link to a subgraph id makes a stray node.
- `canvas-lwa4` part 4 (Mermaid 12 extras, ER subgraphs): **ER diagrams have groups.** erd.ts / erd.py read
  `subgraph Id [Title]` / `subgraph "Quoted id"` ... `end` (nestable, `direction` inside = the group's own) as
  containers (no role; `parentContainerId` for nesting). Membership as Mermaid's erDb: after reading, subgraphs
  in the order they CLOSE (inner first) take the entities named directly inside them (declarations, attribute
  blocks, aliases, `:::`, relationship ends) that no subgraph has yet. A relationship end naming a subgraph is
  the group (implicit entity removed); a quoted end must be a subgraph; an id both declared as an entity and a
  subgraph, a duplicate subgraph, an unclosed one = errors. Places/sizes in front matter `canvas.containers`
  (written only when there are groups; only stored NUMBERS are trusted, else placed again); a fresh import with
  subgraphs uses computeContainmentLayout. Writer: subgraph blocks first (entities declared inside; an aliased
  entity without attributes as `ID[Alias] {` `}` because Mermaid's bare `ID[Alias]` doesn't join the subgraph),
  then the old top-level passes, relationships last (Mermaid resolves a subgraph id only after its block);
  ids/ends quoted when not plain, titles quoted unless plain words. Before this, Add Container worked in ER but
  saving dropped the group. Editor: connect mode ends on an ER group; AI: `groupIntoContainer` for erd,
  `addEdge` to an ER group, primer. Corpus `erd-subgraphs`, `error-erd-subgraphs`; Python fuzz
  `_subgraph_diagram` (parse, serialize, portable, render, Auto Layout; caught a reversed membership order).
- `canvas-lwa4` part 3 (Mermaid 12 extras, ER attributes): **backtick attribute words.** `` string `first name` PK ``
  was misread (name `` `first ``, keys lost). erd.ts `ATTRIBUTE_WORD` (Python `ATTRIBUTE_WORD`) reads a backticked
  type or name (backticks dropped); `attributeWord` / `_attribute_word` writes one back in backticks when it holds
  whitespace or `"` (and no backtick). Optional types (`string? x`) already worked and draw in Mermaid 12.2.
  Corpus `erd-attribute-backticks`, `erd-optional-types`; ER fuzz generates backtick words. ER subgraphs are a
  support note until their own part. Pitfall: the mermaid-export spec imports diagram-core's BUILT copy -- rebuild
  (`npm run build --workspace=@canvas/diagram-core`) before running it locally, or it tests the old parser.
- `canvas-lwa4` part 2 (Mermaid 12 extras, C4): **a relationship can end on a boundary** (Mermaid 12.0). Parsing,
  saving and drawing already worked (renderers use `containerAsEndpoint`); now the editor's connect mode accepts a
  C4 boundary click (Canvas.tsx `handleContainerPointerDown`, as for state composites) and the AI's `addEdge` takes
  a C4 container id (`tools.py`, family in state/c4; C4 primer says so). `update_ai_vectors` now also rewrites
  primers (only the 12 C4 entries changed). Corpus `c4-rel-to-boundary`; e2e in apps/web/tests/e2e. Validation
  treats a boundary end as an unclassified element.
- `canvas-lwa4` part 1 (Mermaid 12 extras, sequence): **participant types and the rest of autonumber.**
  `participant|actor|create … ID@{ "type": "database", "alias": "x" }` (block read up to the first `}`, by
  `parseShapeData`, which now also takes quoted keys `"type":` for every family): the block is `node.mermaidData`,
  kept and written back (`participantDeclaration` / `_participant_declaration`); `type` sets the shape drawn
  (`PARTICIPANT_TYPE_SHAPES`: boundary/control/entity circle, database cylinder, queue stadium, collections and
  unknown types rectangle; type beats the keyword, as in Mermaid); the block's `alias` is the label unless an `as`
  alias other than the id is given (written as `as` only when the label differs from what the block shows; alias
  dropped when the label is back to the id). `autonumber 10` (step 1) and Mermaid's NUM (two decimals at most,
  `.5`); written `autonumber <start>`. `properties`/`details` lines stay unread (support note). Corpus
  `sequence-participant-types`, `error-sequence-participant-data`; Python fuzz `participants_diagram` (checked to
  catch a wrong type shape). Still to do in canvas-lwa4: C4 Rel to a boundary, ER subgraphs / optional types,
  flowchart shape and option extras.
- `canvas-xl3a.5` (Windows install, SBOM): **`packaging/windows/sbom.py`** (stdlib only, run by build.ps1 on the
  staged Python) writes a CycloneDX 1.6 JSON SBOM: Canvas as metadata.component; the runtime from
  licenses/windows-python/manifest.json (nested `file` components with each installed file's SHA-256; CPython
  names the python-build-standalone download + sha256); every installed .dist-info (purl pkg:pypi, SHA-256 of
  the uv.lock wheel whose tags match the WHEEL file's `Tag:` lines; a package not in packages.json stops the
  build); npm packages with `webApp` (purl pkg:npm, lockfile integrity as SHA-512 hex). Licences: an SPDX
  expression, else by name. Shipped as `licenses\canvas-sbom.cdx.json`, copied beside the installer and kept in
  CI's artifact. **`licenses/packages.json`**: scripts/third-party-notices.mjs now also writes the package list
  as data (npm integrity, `webApp` = reachable from apps/web, Node-style resolution; Python incl. not-for-Linux
  with marker); `licenses:check` checks it. Tests: `tests/test_windows_sbom.py` validates against the vendored
  CycloneDX 1.6.2 schema (`tests/data/cyclonedx-1.6`); the real Windows SBOM (120 components) validates too.
- `canvas-xl3a.4` (Windows install, docs and licences): **`docs/admin-guide/installing-on-windows.md`** (install,
  SmartScreen, first sign-in, Start menu, %LOCALAPPDATA%\Canvas, backup/restore, upgrade, uninstall, recovery, AI
  via settings.json "env") + RUNBOOK "The Windows installer". **`python -m canvas_api.desktop reset-admin`**: asks
  for an email and a new temporary password (policy-checked, typed twice) and runs bootstrap_admin's reset mode
  (unlocked admin, MFA off, signed out); the lone-admin recovery on a single PC. **Licences**:
  `licenses/windows-python/` (manifest + reviewed texts: CPython's Doc/license.rst at v3.13.17, OpenSSL 3.5.9,
  SQLite 3.53.1, zlib 1.3.2, libffi 3.8.0, xz 5.8.4, bzip2 1.0.8, Expat 2.8.5, mpdecimal 4.0.0; VC++ runtime via
  CPython's LICENSE.txt); build.ps1 writes `licenses\PYTHON-RUNTIME-NOTICES.txt` from it and FAILS when the
  python-build-standalone release isn't the reviewed one, a DLL isn't listed, or an installed package isn't in
  THIRD-PARTY-NOTICES.md (Linux-made; tzdata, psycopg's Windows-only dependency, now excluded too). The private
  Python drops tkinter/Tcl/Tk, IDLE, tests, pip, headers (193 -> 162 MB).
- `canvas-xl3a.2` + `.3` (Windows installer): **`packaging/windows/`**. `build.ps1` (Windows PowerShell 5.1 or pwsh;
  needs uv, `npm ci`, Inno Setup 6 unless `-SkipInstaller`; `-WebDist` takes a prebuilt same-origin web build):
  python-build-standalone CPython 3.13.17 (release 20261021, stripped, sha256 pinned in the script) to
  `stage\python`, the locked production deps via `uv export --frozen --no-dev` WITHOUT psycopg (SQLite only), the
  API to `stage\app\{src,migrations}` + VERSION, `canvas.pth` (`..\..\..\app\src`) so the private Python finds
  canvas_api, the web app (VITE_API_BASE_URL empty, set through node: PS 5.1 deletes an empty env var) to
  `stage\app\web`, licences to `stage\licenses`; then ISCC. `canvas.iss`: per user (`PrivilegesRequired=lowest`,
  %LOCALAPPDATA%\Programs\Canvas), Start menu Canvas / Stop Canvas (`pythonw -m canvas_api.desktop open|stop`),
  first-install wizard page for the first admin (email + temporary password, checked with a COPY of the password
  policy -- `tests/test_windows_installer.py` fails when it drifts) written as ASCII-escaped JSON to
  first-admin.json; silent installs never take a password (Setup logs its command line). Upgrades stop Canvas
  (PrepareToInstall), replace python/app whole and keep the data; uninstall stops it and asks before deleting
  %LOCALAPPDATA%\Canvas. CI job `windows-installer` builds it and runs `smoke-test.ps1` (install, first start,
  sign-in, shortcuts, upgrade over a running copy, stop, uninstall keeps data); artifact kept 7 days. First start
  on a fresh PC was ~60 s (seed 1 s; the rest importing freshly unpacked files, likely the virus scanner; warm
  import 4 s, mostly `anthropic`). Unsigned (SmartScreen warns). SBOM is canvas-xl3a.5.
- `canvas-xl3a.1` (Windows installer, phase 1; decided with the user: one person on their own PC, a Setup .exe, a
  Start-menu launcher, local accounts with the first admin set up on first run): **`canvas_api.desktop`** --
  `python -m canvas_api.desktop start|open [--no-browser] | stop | status`. Per-user data folder
  (CANVAS_DATA_DIR, else %LOCALAPPDATA%\Canvas / $XDG_DATA_HOME/canvas): settings.json (secrets + port 3888,
  generated once, "env" overrides), SQLite canvas.db, logs/, canvas.pid. Seeds the catalog on first run and when
  APP_ROOT/VERSION changes, else migrates; creates the first admin from first-admin.json (bootstrap_admin,
  one-time password) and always deletes it; serves on 127.0.0.1 only with WEB_DIST_DIR, AUTH_MODE=local,
  MFA_REQUIRED=false; single instance (a running copy just gets the browser opened); a taken port -> a free one,
  saved. Tests `tests/test_desktop.py` (19, incl. end to end in a subprocess).
- `canvas-mywp`: **`npm run dev:local` runs Canvas with no containers** (Linux/macOS/Windows; Node 22 + uv).
  `scripts/dev-local.mjs`: copies `apps/api-py/.env` from the example on first run, reads it (shell env wins;
  `scripts/dotenv.mjs` `readEnvFile`, typed by `dotenv.d.mts`), builds diagram-core if missing, seeds demo data
  for a new SQLite file else runs `migrate`, then runs uvicorn (`--reload`) and Vite with `[api]`/`[web]` output,
  each in its own process group so Ctrl-C/SIGTERM stops both (taskkill /T on Windows). `API_PORT`/`WEB_PORT`,
  `--seed`. `.env.example` now defaults to SQLite (`./data/canvas.db`); `db.create_db_engine` creates the SQLite
  file's folder. The e2e global setup reads `apps/api-py/.env` and runs its jobs from `apps/api-py` (a relative
  SQLite path meant a different file from the repo root). README "Getting started" and RUNBOOK rewritten around
  it. Groundwork for canvas-xl3a (Windows installer).
- `canvas-c8zl`: **THIRD-PARTY-NOTICES covers the C libraries psycopg-binary bundles** (decided with the user:
  licence texts, image unchanged). `licenses/psycopg-binary/manifest.json` maps each `psycopg_binary.libs` file
  stem to its library, exact version and reviewed licence text(s) in that folder: libpq 18.6, OpenSSL 3.5.8,
  OpenLDAP 2.6.14 (psycopg's own build, tag 3.3.6), libxcrypt 4.5.2 (manylinux2014 image), and the CentOS 7
  packages from the wheel's auditwheel SBOM (krb5 1.15.1, Cyrus SASL 2.1.26, PCRE 8.32, keyutils 1.5.8, libcom_err
  1.42.9, libselinux 2.5). scripts/third-party-notices.mjs renders a "C libraries bundled in psycopg-binary"
  section and fails `licenses:check` when the wheel version differs from the manifest's, or a bundled file and the
  list disagree -- bumping psycopg means re-reviewing these.
- `canvas-rfds`: **the AI primer drift guard is back, in Python.** `tests/test_ai_primer_coverage.py` walks every AI
  tool's input schema per family (`list_tools`) and requires each enum value to be named in that family's primer
  (`primer_for`; case-insensitive, hyphens as spaces), so a new shape/arrow/kind can't ship without the model being
  told. Exempt: values under `side`, `alignment`, `axis`, `direction` (the layout tools' self-describing geometry);
  a test checks those properties exist. No gaps today. (The TypeScript original went with apps/api.)
- `canvas-xpuk`: **connector labels in state diagrams no longer pile up.** svg-renderer.ts exports
  `edgeLabelPlacement(mid, laneShift)` (Python `edge_label_placement`): a lone connector's label is unchanged; one of
  several between the same two shapes goes on its own outer side (`text-anchor` start/end beside an up-down or
  slanted line, below/above a level one). A connector to or from a group (composite state) labels the middle of
  the clipped line, not of the centres. `selfLoopGeometry` keeps a loop at the corner of a big box
  (`min(w/4, 40)`, `min(h/4, 40)`; boxes up to 160 unchanged). Canvas.tsx uses the same helpers. Still open: two
  different pairs fanning from one state can meet between them (no general label collision avoidance).
  Tests: `edge-label-placement.test.ts`; 7 corpus renders changed.
- `canvas-ltfa`: **a flowchart node's later definition wins, as in Mermaid.** `a --> b` then `b{Question?} --> c`
  left b a plain box labelled `b` (ensureNode only set label/shape on creation). `matchNodeToken` /
  `_match_node_token` now say whether a token was explicit (a shape and text); an explicit mention, on its own line
  or as an edge end, updates an existing node's label and shape (icon tie-break as on creation). Bare ids,
  `A:::cls`, `A@{…}` keys and implicit edge ends don't. Corpus `flowchart-later-definition`;
  `flowchart-comments-and-directives` now shows `C[Done]`.
- `canvas-3vcj` part 2 + `canvas-rshf`: **the architecture diagrams are on Azure** (project "Canvas solution
  architecture", owned by the perf-test account; 18 diagrams imported through the API after Auto Layout). New
  `docs/architecture/flowchart-access.mmd` (how a diagram's access level is worked out). Found: Auto Layout's
  top-down direction is `TD`, which ER/class serializers wrote as `direction TD`, which their parsers (and Mermaid)
  refuse -- such a diagram couldn't be reopened. Both now read `TD` and write `TB` (TS + Python; corpus
  `erd-direction-td`, `uml-direction-td`). Also filed: canvas-ltfa (a flowchart node's later shape/label is ignored
  after a bare first mention), canvas-xpuk (state diagram label overlaps).
- `canvas-hl75` + `canvas-op8q` (flaky e2e): **changing your own role always lands on sign-in.** UsersPage's
  `update()` compared against `currentUserId`, loaded separately by `api.me()`; a change made before that answered
  refreshed the list instead of reloading (a real race, not only a test one). It now resolves `me` first. The
  role-change spec waits for the page to know your row (no `delete-user-<you>` button) and for the PATCH's 200;
  project-context's Projects list gets 30 s (GET /projects, fetched once at sign-in, is slow late in a CI run).
  Unit test `users-page-role.test.tsx`.
- `canvas-ra0g`: **the first save of an imported diagram is already stable.** Writers group elements (a boundary's
  shapes inside its block, a state's declaration before the transitions), so the model's order wasn't the text's and
  the front matter came out reordered on the second save (a no-op save showed a diff in version history / GitHub
  PRs). `dsl/read-order.ts` `inReadOrder` (Python `read_order.in_read_order`): write, read back, re-sort nodes and
  containers by first appearance in the read model (missing ids last, stable), write again. `serializeFlowchart`,
  `serializeC4`, `serializeErd`, `serializeUml`, `serializeState` wrap their old bodies (`writeX` / `_write_x`)
  this way (one extra parse + write per save). The golden corpus now requires saving the saved text to change
  nothing (it used to allow one reorder); 22 cases' `serialized.mmd` reordered.
- `canvas-8ucs`: **the Mermaid export always writes the diagram again in Canvas's own form** (decided with the
  user: anything Canvas opens draws in Mermaid; typed comments/spacing are left out of the file only).
  `withMermaidForms` / `_with_mermaid_forms` no longer return the text when nothing needs fixing; state diagrams are
  re-serialized too; text that doesn't parse goes out as is. `withOriginalKeys` / `_with_original_keys` put the
  original front matter's own Mermaid keys (title, config) back first (a moved flowchart title wins). CI check:
  `apps/web/tests/e2e/mermaid-export.spec.ts` (no app needed) draws every corpus case's export, typed and saved, in
  Mermaid 12.2.0 (devDependency, must equal `GITHUB_MERMAID_VERSION`) with a `KNOWN_FAILURES` list (BPMN on 12.2,
  `constructor` ids, an image URL) that also fails when a listed case starts drawing.
- `canvas-zayd`: **family detection passes over `%%{...}%%` config directives** before the header (TS `detect.ts`
  `CONFIG_DIRECTIVE`, Python `_CONFIG_DIRECTIVE`, JS `.` spelled out). Canvas's own serializers write the directive
  first, so text Canvas wrote couldn't be detected (import, syntax_report). Plain `%%` comments before the header
  are still not passed over (the parsers refuse them). Corpus `c4-config-directive-first`,
  `erd-config-directive-first`; `test_detection_passes_over_config_directives_as_typescript_does`.
- `canvas-0t84` part 2: **every family's export draws in real Mermaid.** `withMermaidForms(dsl, family)` (TS) /
  `_with_mermaid_forms` (Python) re-serialize only when needed: C4 drops `Lay_*` (C4-PlantUML) and empty
  boundaries (repeatedly); ER quotes EVERY relationship label and alias (`#quot;` inside; Mermaid's ER keywords
  `many`/`one`/`to`/`class`/numbers can't be bare; empty -> `"relates to"`, `DEFAULT_RELATIONSHIP_LABEL` now
  exported); class: `:` in labels -> `#58;`, empty notes and empty namespaces dropped; sequence: a note over 3+
  participants spans first..last; flowchart: body `title` -> front matter `title:` (first key), `"` in labels ->
  `#quot;`. The family for the style lines is read once from the original text (a rewritten text can start with
  `%%{init}%%`, which detection misses: canvas-zayd). Before re-serializing, TS drops `null` fields
  (`withoutNulls`) and Python `None` ones (`_defined`): Python can't tell null from undefined. `strokeWidth: null`
  no longer writes `nullpx` (TS `!= null`); Python's style lines ignore non-object styles (it crashed). Parsers
  (flowchart, C4, UML, sequence, state) give each placeholder-positioned element its own `{x:0,y:0}` (a shared
  object made YAML anchors `&a1`/`*a1` in the front matter, and a mutation moved them all). Real Mermaid render of
  every corpus case's saved-text export: 113/116 on 12.3 (left: Mermaid's own `constructor`-id crash, an image URL;
  12.2 also can't draw BPMN shapes). The C4/ER/class/sequence fuzzers now compare exports (typed and saved text,
  both strip modes). CI render check: canvas-8ucs.
- `canvas-0t84` part 1: **architecture exports draw in real Mermaid.** `toPortableMermaid` (TS) / `to_portable_mermaid`
  (Python) now rewrite text Mermaid refuses, export only (`withMermaidForms` / `_with_mermaid_forms`; saved DSL
  unchanged). Architecture, when needed (else the text is untouched): connectors and align ids naming missing
  services dropped; only the first connector per `source-target` (Mermaid's edge id; a second throws); each
  missing side faces the other end (centers: node position + nodeSize/2, or the group's box for `{group}`;
  |dx| >= |dy| -> R/L else B/T, ties R/B; loop R->T; a given side kept), then `serializeArchitecture`. Real
  Mermaid 12.3/12.2 render of every corpus export: all architecture cases now draw (96/116 on 12.3). Tests:
  `portable-architecture.test.ts`, architecture fuzz compares portable (both strip modes, grid positions for ties),
  `test_a_group_end_takes_its_side_from_the_group`.
- `canvas-8wxq.1`: **Canvas follows Mermaid 12.3.** `MERMAID_SYNTAX_VERSION` '12.3' (was '11.15'); GitHub still draws
  with 12.2.0 (read from viewscreen's mermaidMarkdown bundle, checked 2026-11-05), so the Admin overview's
  major-version note no longer shows. 12.3 syntax added: an edge id straight after a shape (`A[x]e1@--> B`; a bare
  id still needs the space, `EDGE_ID` lookbehind on `]`/`)`/`}`) and the BPMN shape names (`bpmn-start` ...
  nearest Canvas shape; GitHub's 12.2 can't draw them). Corpus `flowchart-mermaid12-3`. Export check: every
  corpus case's saved text exported (`stripFrontMatter`) and rendered in real Mermaid 12.3.0/12.2.0 in Chromium:
  25 of 116 don't draw (architecture connectors without sides, C4 `Lay_*` and empty boundaries, ER unquoted
  labels/aliases, flowchart body `title`/`\"`, sequence notes over 3+, UML `:` labels/empty namespaces/`note ""`),
  filed as canvas-0t84. Dry run on the local DB: 0 unopenable, 1,075 rewrites (1,009 front matter added,
  66 sequence participant spacing; none from this change).
- `canvas-sfz7`: **flowchart longer links.** Connectors follow Mermaid's LINK rule at any length (`--->`, `----`,
  `-..->`, `===>`, `<--->`, `~~~~`; no `x`/`o` ends): one regex alternation (arrowed form before open form) +
  `readConnector` (TS) / `_read_connector` (Python), length as Mermaid's destructEndLink (dots for dotted, else
  line length - 1). `DiagramEdge.mermaidLength` only when > 1, capped at `MAX_LINK_LENGTH` (1000,
  mermaid-shape-data); the serializer writes it back (invalid = 1); Auto Layout ignores it. Inline labels take long
  closes and arrowless closes (`A -- t --- B`). The bug: `E --> F ---> G` was read as one edge E->G labelled
  `> F -`; now the inline opener can't start a longer link (`--(?![->])`, `-.(?![.-])`, `==(?![=>])`) and the
  label can't hold a whole link, so `A -- a --> B --> C` is an error, not a misread. Corpus `flowchart-long-links`,
  `error-flowchart-link-inside-label`; parity fuzz has long/near-miss connectors, tricky lines, bad
  `mermaidLength` edits; `dsl-flowchart-long-links.test.ts`.
- `canvas-8wxq` part 2 (Mermaid 12.x): **flowchart `@{ … }` shape data and edge ids.** `dsl/mermaid-shape-data.ts`
  / Python `mermaid_shape_data.py`: the `@{ key: value }` block (YAML flow subset: double-quoted with `\" \\ \n \t
  \r`, single-quoted, bare true/false/number(<=9.6 digits)/text; a key twice, a missing colon or value = error),
  `mermaidShapeToCanvas` (every Mermaid shape name/alias -> nearest Canvas shape, unknown names -> rectangle),
  `MERMAID_SHAPE_NAME` (written when the shape was changed in Canvas). `A@{…}` / `A:::kind@{…}` as a line or an
  edge end (class BEFORE the block, as Mermaid's grammar has it): `node.mermaidShape` (as written) + `shape`,
  `label`, other keys in `node.mermaidData`; applied over an existing node; `img` must pass `isAllowedLinkHref`.
  Edge ids `A e1@--> B` on every edge form but fan-out: `edge.mermaidId` (Canvas's `e<n>` ids unchanged), a
  repeated id = error; a later `e1@{…}` line = `edge.mermaidData` (before the edge exists it's a node, as in
  Mermaid); `one@{…}` on a subgraph = "not read yet" error. Serializer writes them back (edge options after the
  edges). Not drawn: edge animate/curve/step, icon/img. Corpus `flowchart-mermaid12-shapes`,
  `flowchart-edge-ids`, `error-flowchart-shape-data`; `dsl-flowchart-mermaid12.test.ts`; the flowchart parity fuzz
  generates the syntax and also serializes edited models (reshaped nodes, odd labels, duplicate/bad edge ids).
  Found: canvas-sfz7 (`--->` long links misread).
- `canvas-8wxq` part 1 (Mermaid 12.x): **class display labels and sequence half arrows, central connections and link
  menus.** UML: `class A["Label"]` (also with `~T~`, `<<x>>`, a body) sets the label; written back when it differs
  from the id. Sequence: `DiagramEdge.arrow` gains `SequenceHalfArrow` values (`half|stick`-`top|bottom`[`-reverse`],
  tokens `-|\ -|/ /|- \|- -\\ -// //- \\-`, `--` = dotted); `centralSource`/`centralTarget` (`A()->>()B`);
  `DiagramNode.sequenceLinks` from `link A: Label @ url` / `links A: {json}` (http(s)/relative only, else a parse
  error; JSON object of strings; written back as `link` lines; Python orders integer-like JSON keys first, refuses
  NaN). The export draws half arrowheads/barbs and central circles via the exported `sequenceMessageGlyphs` (no
  marker for half arrows), shared with the canvas. Corpus `sequence-mermaid12`, `uml-class-labels`,
  `error-sequence-bad-links`; the old "half arrows/links still fail" tests became feature tests; sequence/UML fuzz
  generators produce the new syntax and the sequence fuzz now compares drawings. Mermaid version notes updated.
  Extras found in the changelog are canvas-lwa4.
- `canvas-y2yf`: **connectors sharing the same two shapes no longer draw on top of each other; a connector back to
  its own shape is a loop** (it drew nothing). svg-renderer.ts exports `edgeLanes(edges)` (index/count per unordered
  pair, in model order), `laneShift(edge, lane, from, to, fromSize, toSize)` (perpendicular to the pair's axis from
  the id that sorts first -- JS `<`, so A->B and B->A separate; `PARALLEL_EDGE_GAP` 18, squeezed to fit 80% of the
  narrower shape across the line) and `selfLoopGeometry(position, size, index)` (a cubic loop off the top-right
  corner, bigger per extra loop). `renderEdge` shifts centers and the clipped endpoints by the lane; sequence keeps
  its own path. Python `svg_render.py` mirrors it (`edge_lanes`, `lane_shift` with `js_string_gt`,
  `self_loop_geometry`); the canvas uses the same helpers. 12 corpus renders changed (every case with repeated
  connectors). Tests: `parallel-connectors.test.ts`; the render fuzz caught a deliberately wrong gap (26 failures).
- `canvas-3vcj` part 1: **Canvas documented as Canvas diagrams** in `docs/architecture/` (README index): C4
  context/container/component, C4 Deployment of infra/azure, ERD (from the real schema), UML class of diagram-core's
  model, 4 sequences (sign-in + MFA, compare-and-set save, AI chat turn, GitHub approval), 3 flowcharts (validation,
  Auto Layout, purge), 4 state lifecycles (diagram, standard, GitHub submission, account; titles in front matter as
  Mermaid requires). `architecture-docs.test.ts` parses, round-trips and renders every file -- keep them in step with
  the code. Uploading them to an Azure project waits for a deploy. Found: canvas-y2yf (parallel connectors overlap).
- `canvas-bnnh` part 2: **State Diagram is a diagram type.** Seed `state` ("State Diagram", Solution/Technical,
  family `state`) + a descriptive starter standard; `DSL_FAMILIES`/`BUILTIN_DIAGRAM_TYPE_IDS`/constants.json/
  `FAMILY_DEFAULT_TYPE` include it. diagram-core: `addStateNode(model, {kind, label?, containerId?})` +
  `statePseudoId` (TS + Python `add_state_node`; one start/end per scope, an existing one = no change; ops vectors
  regenerated with it); the state serializer now takes a node's role from its shape when it has none, writes any
  group that isn't a region/note as a composite, and puts a scope-less connector inside the group both ends share.
  AI: state family gets `addState` (kind/label/groupId/near) instead of addNode, `groupIntoContainer` (kind
  composite), connectors may end on a composite, layout tools (POSITIONED_FAMILIES), a primer. Web: see the editor
  changes (state toolbar, pseudo-state shapes, connectors to composites). Tests: `tests/test_ai_state_tools.py`
  (AI build + API create/save/export), stripped-role fuzz in test_diagram_core_state.py, dsl-state.test.ts.
- `canvas-bnnh` part 1: **diagram-core reads, writes, draws and lays out Mermaid state diagrams** (`stateDiagram-v2`
  and `stateDiagram`, Mermaid 12.3 syntax; TS `dsl/state.ts`, Python `diagram_core/state.py`, family `state`). Not
  a diagram type yet (part 2: editor, seed type, standards, AI, docs). Model: states = nodes (role `state`,
  rounded-rectangle; `state "Label" as id` = label, `id : text` lines = description); `[*]` = one start/end per
  scope (`root_start`/`<container>_start`, shapes `state-start`/`state-end`); `<<choice>>` (small unlabelled diamond),
  `<<fork>>`/`<<join>>` (`fork-bar`); composite = container role `composite` (connectors may END ON IT: renderers
  draw to its box via `containerAsEndpoint`); `--` regions = child containers `<id>__region<n>` (role `region`);
  notes = containers `note-left`/`note-right` attached to a state (`note<n>`, wrapped text in the non-sequence render
  path only). An edge's `containerId` = the scope it was written in; the serializer emits composite blocks where
  their first connector was, so edge ids (`e<n>`, text order) survive a save; edgeStyles/note ids are keyed by the
  emitted order. classDef/class/`:::`/style fold into front-matter styles (empty classes add nothing); `click href`
  uses the link check, `call` refused; title in front matter (`joinFrontMatter` now writes non-canvas keys);
  `hide empty description`/`scale` accepted, not kept. Portable export colours states with `classDef canvasStyleN`.
  Auto Layout covers `state` (and writes its direction). Also fixed in Python's jsyaml: a `\uD83C\uDFA8` escape
  pair loads as one character (was two lone surrogates). Tests: corpus `state-*` (8) + 2 error cases,
  `dsl-state.test.ts`, `tests/test_diagram_core_state.py` (400 generated diagrams vs the bridge: parse, serialize,
  render, Auto Layout, portable; caught 2 deliberate bugs). Mermaid version notes gained a State entry.
- `canvas-2h2w.3`: **share with Entra groups** (decided with the user: build now, verify live later with Azure on
  Entra; only groups ASSIGNED TO THE CANVAS APP). Setting `ENTRA_GROUPS=true` (deploy.sh `CANVAS_ENTRA_GROUPS`,
  bicep `entraGroups`), only with Entra sign-in; `/auth/config` `groupsEnabled`. Migrations Postgres `0036`, SQLite
  `0024`: `entra_groups` (picked groups' names), `user_group_memberships` (from the ID token's `groups` claim at each
  Entra sign-in, `groupMembershipClaims=ApplicationGroup`; overage keeps the old record), `share_grants.
  grantee_group_id` (person XOR group; partial unique index for groups; SQLite table rebuilt). access.py's two grant
  queries also match `grantee_group_id IN (user's memberships)`; highest of direct and group grants. `auth/graph.py`
  `GraphClient.assigned_groups()` (servicePrincipals(appId)/appRoleAssignedTo, groups only, paged, cached 5 min) with
  `OidcClient.app_token()` (client credentials, same secret/managed-identity assertion). Routes: `GET /groups?q=`;
  share bodies take `granteeUserId` XOR `granteeGroupId` (group checked against Graph AFTER the access guard; 503 if
  Graph fails); grants/members carry `granteeGroupId`/`groupId` (userId null). No notifications for group shares.
  Tests: `tests/test_entra_groups.py` (fake IdP + fake Graph). RUNBOOK "Entra groups"; admin guide people.md.
- `canvas-2h2w.4`: **in-app notifications about access** (decided with the user: in-app only, quiet, no opt-out;
  email stays canvas-q9v). Table `notifications` (Postgres `0035`, SQLite `0023`): kind `added` | `level_changed` |
  `removed` | `ownership`, subject (project|diagram, no FK; `subject_name` snapshotted so a later rename never
  reaches someone who lost access), levels, actor, `read_at`. `canvas_api/notifications.py` `notify()` is called
  inside the change's transaction from routes/sharing.py (`_share` when the level changes, `revoke_share`,
  `transfer_ownership`); nobody is told about their own change. `GET /me/notifications` (newest 50 + unreadCount),
  `POST /me/notifications/read` (`{ids}` or nothing = all; others'/malformed ids ignored). Purge: with a purged
  diagram/project, and older than 90 days (nightly job; prints a line); deleted users' rows go. Web:
  `notifications/` (context polled every 60 s while visible + on focus, bell + panel in the header, sentences in
  `notification-text.ts`), "New" tag on Shared with me (`shared-new-<id>`). Tests: `test_notifications.py`,
  `notifications.test.tsx`, e2e `notifications.spec.ts`.
- `canvas-7p3y`: **the Mermaid version is recorded and shown.** `packages/diagram-core/src/mermaid-version.ts`:
  `MERMAID_SYNTAX_VERSION` ('11.15', the release whose syntax the parsers follow; Canvas doesn't run mermaid.js),
  `GITHUB_MERMAID_VERSION` (hand-recorded with its check date; GitHub draws submitted diagrams), and
  `MERMAID_SUPPORT_NOTES` per family. `mermaid-version.test.ts` pins the values and checks each "not read" note
  still fails to parse (and each "read" one parses), so notes can't go stale. Shown on the Admin overview (decided
  with the user: overview page, recorded GitHub value, docs + dry-run report). Mermaid 12 changed default layout/
  look (ELK), not syntax. Upgrade process: docs/admin-guide/operations.md "Moving to a newer Mermaid version"
  (keep reading old forms; no per-diagram syntax version). Dry run: `python -m canvas_api.jobs.syntax_report`
  (read-only, no migrations; lists diagrams the build can't open -- exit 1 -- or would rewrite on next save;
  `--json`; skips the bin and unsaved drafts). Local databases only: the Azure DB is private to its VNet; an Azure
  job is canvas-dfam, for when a real syntax change needs it (user chose this).
- `canvas-rqm6` part 2: **pinned shapes and groups.** `DiagramModel.pinned` (ids), front matter `canvas.pinned`
  in every family but sequence (`readPinned`/`withPinned` in front-matter.ts, `read_pinned`/`with_pinned` in Python;
  ids the diagram lacks, duplicates and non-strings dropped on read AND write). `setPinned(model, ids, pinned)`
  (diagram-ops.ts). `autoLayout` ends with `anchorToPins` (TS and Python, every family incl. architecture): the new
  layout is shifted by the pins' average move (`Math.round`), then each pin -- and everything inside a pinned group,
  any depth -- is put back as the ORIGINAL element (Auto Layout only changes positions/sizes). Decided with the
  user: several pins far apart can leave a shape on top of a pin. Dragging still moves pinned things. Editor:
  Pin/Unpin button after Auto Layout (`pin-toggle`, acts on the selected group or the selected shapes) and a pin
  badge (`pin-badge-<id>`, editor only, not in exports). AI: `describe_model` adds `, pinned`; `arrange` says pins
  stay. Vectors: pins in random/hand-made auto-layout models; corpus `flowchart-pinned`, `c4-pinned`; e2e
  `pin-elements.spec.ts`.
- `canvas-rqm6` part 1: **Auto Layout follows C4's side hints.** `DiagramEdge.layoutHint` ('up'|'down'|'left'|
  'right', from `Rel_U/D/L/R` and the long forms) and `DiagramModel.layoutHints` (`Lay_U/D/L/R`, `{from, to,
  direction}`) are parsed and saved back (`Rel_U`.., `Lay_*` after the Rel lines; BiRel drops a hint). Before, saving
  turned them into plain `Rel` and dropped `Lay_*`. In `autoLayout` (TS `auto-layout.ts`, Python `auto_layout.py`,
  per level, hints mapped to that level's items): a hint ALONG the layout direction orients its connector for dagre
  (`Rel_U` in TD ranks the target first); one ACROSS it joins the two into a line (a row in TD/BT, a column in
  LR/RL), lines joined end to end in hint order (connectors first, then Lay_*), a hint inside one line skipped, so
  contradictions can't loop; dagre places each line as one box (members `nodesep` apart, centred across). No hints =
  exactly the old layout. Vectors: `make_auto_layout_vectors.ts` adds hinted random models and two hand-made cases;
  corpus `c4-layout-hints`. Pinning (part 2) is next.
- `canvas-p2g8.2` part 2: **the AI chat can lay diagrams out.** New tools (every family but sequence, whose layout
  is computed): `moveElements`, `alignElements`, `distributeElements`, `placeRelative` (pure ops in
  `diagram_core/layout_ops.py`; bounds = the drawn `node_size`/`container_size`; a group moves with its contents;
  an unknown id refuses the whole call) and `arrange` = `auto_layout` (part 1's port, so it equals the toolbar's
  Auto Layout; `direction` only where Auto Layout uses one). `addNode`/`addElement` take an optional
  `near: {anchorId, side}`. `describe_model(model, rules, family)` now gives each shape's/group's position and
  size, its group, and a "Current groups" section. The AI vectors are golden output now:
  `uv run python -m tests.data.update_ai_vectors` rewrites tool lists, descriptions and the unavailable-tool
  error only (it reproduces the old file exactly on the old code); new tools are tested in
  `tests/test_ai_layout_tools.py`.
- `canvas-p2g8.2` part 1 (AI layout tools): **Auto Layout runs in Python, giving TypeScript's answer exactly**, so
  the AI chat's arrange tool (part 2) can put a diagram where the editor's button would.
  **User-visible fix in TypeScript first:** dagre 3.1.0 keeps the previous layout in module state (`_oldGraph`/
  `_rawOldNodes`): it reverses edges and reorders nodes to suit the last graph with the same ids. So the result
  depended on what the tab had laid out before (after laying out `B -> A`, a later `S -> A, S -> B, A -> B` drew
  B above A). `autoLayout` now calls `dagre.layout(g, { useDynamic: false })`. Auto Layout depends on the diagram
  alone, so a diagram can come out differently from before. Regression test in `auto-layout.test.ts`.
  **The port:**
  - `diagram_core/auto_layout.py` ports auto-layout.ts: levels bottom-up, the `#` keys, the `from->to` text
    de-dup (collisions included), an edge to an undeclared id adding an empty 0x0 node as graphlib does, and
    JS `Math.round`.
  - `diagram_core/dagre/` ports the dagre path it reaches, with MIT `LICENSE` and a THIRD-PARTY-NOTICES entry:
    graphlib's Graph (insertion-ordered dicts; no key is integer-like, so JS object order is plain insertion
    order), DFS acyclic, network simplex, normalize, ordering (barycenter, the reversed-pair handling, cross
    count, sweeps) and Brandes-Koepf with balance, rankdir transforms and translate.
  - Left out, as no-ops for this input: clusters, self-loops, edge labels and points, empty-rank removal, and
    the dynamic paths.
  - `DiagramCore.auto_layout`.
  **Parity:**
  - `tests/data/auto_layout_vectors.json` (`make_auto_layout_vectors.ts`): every corpus case in every
    direction, 400 seeded random models and 300 dagre-only graphs.
  - A seeded native-vs-bridge fuzz over whole models (new bridge op `auto-layout`).
  - The tests were checked against deliberate bugs.
  **Pitfalls:**
  - Undirected-graph edge ids and BK conflicts compare ids as JS strings (UTF-16 units, `js_string_gt`).
  - The `asNonCompoundGraph` copies are rebuilt, not reused: predecessor order differs after edge removals.
  - dagre recurses as deep as the longest path, so `layout()` raises the recursion limit to 20,000.
  - Plain dagre throws (edge clipping) on `ranksep: 0` with zero-height nodes; Auto Layout's ranksep is 60.
- `canvas-4e0`: **admin pages are in-app screens.** `Location` gained `{ screen: 'admin', page, userId? }`
  (`ADMIN_PAGES` in navigation.ts; `?admin=true`/unknown = standards; `?admin=` still wins; `userId` only for
  the audit log). App's separate `adminParam` state is gone. Links that move within the app use
  `ui/InAppLink` (plain click = `navigate()`, so history, focus, titles and the unsaved-changes dialog; a
  modified click is the browser's; outside App's `InAppNavigationContext` it's a plain link): the header's
  Admin link, the admin nav, Users "View activity", Audit "Show all activity", the persona page's AI usage
  link. `AuditLogPage` takes `userId` as a prop and reloads when it changes. A non-admin on `?admin=` gets
  the rest of the address (`admin`/`userId` removed, replaceState), e.g. the project they were on.
- `canvas-62y`: **the contract describes requests too, and tests hold them to it.** Added the 8 missing request
  bodies (AI persona/reference-material create+edit, `/auth/local/login`, standards create/PUT via a new
  `StandardBody` component generated from `standards_schema.py`, legacy `POST /libraries`). `check_contract`
  now also checks every request the API ACCEPTED (2xx; tests send bad ones on purpose): body vs the
  requestBody schema (or none), query parameters by name and schema. That found 7 contract errors, fixed:
  delete-user body optional, import-svg `license` / import-manifest `name` nullable, ai-prices and
  ai-settings accept unknown keys, search `query`/`type` and deleted-diagrams `limit`/`q` were missing.
  `test_every_body_and_query_parameter_a_route_takes_is_in_the_contract` compares FastAPI's own OpenAPI
  document with the contract; the AI usage routes now declare `from`/`to` (`Query(alias="from")`).
- `canvas-qeo8`: **fewer queries per request.** A diagram read went from 16 statements to 6, presence from
  ~13 to 8. (1) `current_user` writes the session only when that moves its stored expiry by
  `TOUCH_INTERVAL_MS` (60 s) or more, or the session changed (other callers of `save_session` always write);
  the cookie still goes out on every response, so idle expiry can end up to a minute early. (2) `access.py`:
  `require_diagram_access` reads the diagram row once (owner, project, draft), the role once, and the user's
  project + diagram grants in one query (`_GRANTS`), and RETURNS the level, so GET /diagrams/:id no longer
  resolves it twice. Tests: `test_reading_a_diagram_works_out_access_once` (no statement runs twice, no
  session write), the session throttle test; `counting_queries` moved to tests/api.py.
- `canvas-y3qt`: **the standards list reads shapes in two queries, not two per version.**
  `standards_for_type` fetches every version's allowed/mandatory shapes for the type at once
  (`_shapes_for_type`, a JOIN on standards.diagram_type_id) and hands them to `standard_record`/`rules_of`
  (which still read them per standard when called alone). 158 versions: Postgres 56 -> 4 ms, SQLite 12 -> 2 ms.
  Test: `test_listing_versions_takes_the_same_queries_however_many_there_are` counts statements with a
  SQLAlchemy `before_cursor_execute` listener (`counting_queries` in tests/test_standards.py).
- `canvas-dyvn`: **PNG exports draw their text.** resvg ran with system fonts off and no font, so every label was
  silently dropped. The API now bundles Liberation Sans Regular + Bold 2.1 (`apps/api-py/src/canvas_api/fonts`,
  SIL OFL 1.1, `OFL.txt` beside them, and in THIRD-PARTY-NOTICES.md) and `routes/export.py` passes them to
  resvg-py as every generic family (the SVG's stack ends in `sans-serif`; system fonts stay off). Test:
  `test_the_png_draws_the_labels` decodes the PNG and counts pixels of the text's own colour at the label.
- `canvas-1bty.16` part 2 (Python phase 12b): **the TypeScript API is gone.** `apps/api` deleted (tag
  `typescript-api-final` is the last commit with it; comments citing `apps/api/...` mean that tag), with the
  repo-root Dockerfile, `infra/azure/modules/tsapiapp.bicep` and the `canvas-api-ts` app (deploy.sh deletes it).
  Moved: migrations to `apps/api-py/migrations`, the contract (`openapi.json`, `constants.json`, now frozen and
  edited by hand with the route; `routeGroups` dropped) to `apps/api-py/contract`. Removed from Python: the
  TypeScript fallback (`TYPESCRIPT_API_URL`/`TYPESCRIPT_ROUTE_GROUPS`, `front_door/route_groups.py`,
  `match_route`), `TRUST_CLIENT_IP_HEADER` (a client-sent `X-Canvas-Client-IP` is ignored), `/py/me`; deploy.sh
  refuses `CANVAS_TYPESCRIPT_ROUTE_GROUPS`. `/docs` is FastAPI's Swagger page and `/openapi.json` its document,
  both only with `ENABLE_API_DOCS=true` (before, /openapi.json was always served). The bridge lost its AI ops
  (they bundled apps/api's AI code; `tests/data/ai_tools_vectors.json` stays as fixed data); tests that ran
  TypeScript at test time (seed parity, Python-made hashes/ciphertexts/TOTP checked in Node) are gone, the
  TypeScript-made vectors stay. CI: `unit-tests (postgres|sqlite)` (required checks) now run the Python suite
  plus the TS packages' tests, so a red Python suite blocks merging (it didn't, #303); e2e starts only Python.
  Licence notices cover the Python packages (`npm run licenses`). Local settings: `apps/api-py/.env`
  (`uv run --env-file .env ...`; `.env.example`).
- `canvas-1bty.16` part 1 (Python phase 12a): **the jobs are Python.** `apps/api-py/src/canvas_api/jobs/`:
  `migrate`, `seed_catalog`, `seed_demo`, `bootstrap_admin`, `purge` (`--dry-run`), `e2e_reset`, each run as
  `python -m canvas_api.jobs.<name>` (env: `DB_CLIENT`, `DATABASE_URL`, `SESSION_SECRET`, plus each job's own, same
  names and output as TypeScript). The five Azure jobs (migration, catalog seed, demo seed, bootstrap admin, purge)
  now run the `canvas-api-py` image. Catalog data in `canvas_api/seed/` (diagram types, starter standards, personas)
  and the bundled icon manifests as JSON in `canvas_api/seed/manifests/` (diagram-core's
  `python-seed-libraries.test.ts` fails on drift, `UPDATE_SEED_LIBRARIES=1` regenerates); `library_store.py`
  (ingest, shared with the admin routes), `retention.py` (purge, shared with the routes). Seeded rows are identical
  to the TypeScript seed, table by table, on both databases (`test_jobs_seed_parity.py`, skips without tsx).
  Differences on purpose: each job runs in one transaction (TypeScript could stop half done); SQLite migrations
  are atomic per file; on SQLite the draft purge compares times with `julianday()` (TypeScript compared text, so
  a draft minutes old could go on the cutoff's date). e2e: global-setup runs the Python `e2e_reset`/`seed_demo`;
  CI seeds with Python and runs `tests/fake_github_server.py` (Python) instead of the TypeScript fake GitHub. The
  TypeScript API still runs behind Python until 12b. Pitfall: two Postgres pytest sessions at once break each
  other (each drops the `canvas_py` schema).
- `canvas-1bty.20` (security): **icon artwork is clipped to its box** in the server renderer, TypeScript and Python
  together (`clipIconArtwork` / `clip_icon_artwork`): node and group icons are wrapped in
  `<svg x="0" y="0" width="48" height="48" viewBox="0 0 48 48" overflow="hidden">`, so manifest/bundled artwork
  reaching outside the icon space can't paint over or pass for the rest of an exported diagram (resvg honours it:
  the PNG export draws a hostile 2000x2000 rect only inside the 48x48 box). Checked the other `assetRef` users: the
  canvas and the admin library page load artwork as an image of a complete 48x48 SVG (clipped, no script, no
  fetch); an `assetRef` that isn't markup is inert text in either path, never fetched; GitHub submissions render
  without icon artwork.
- `canvas-1bty.15.9`: **ids named like Object.prototype members are ordinary ids in TypeScript too**, matching
  Python (decided with the user: change TypeScript). `splitFrontMatter` copies each id-keyed canvas section
  (positions, containers, styles, edgeStyles, icons, kinds) into an object with no prototype (a non-map section
  counts as empty), and a missing section falls back to the frozen `NO_ENTRIES`, not `{}`: a node `constructor`/
  `toString`/`__proto__` used to pick up a function as its style/icon/position, and serializing then crashed
  ("Tag not resolved for Function value"). A container's `width: null`/`height: null` in front matter is now no
  size (was a size of nulls), as in Python. `getDslFamily` reads own keys; Auto Layout gives dagre `#`-prefixed
  keys (dagre's graph is a plain object, so these ids crashed it). Corpus: one `<family>-object-prototype-ids`
  case per family; the Python parse fuzzers' id pools now include these names.
- `canvas-1bty.15.8` part 2 (Python phase 11h-2): **the bridge is gone from the Python app, kept only by its
  tests.** `DiagramCore` (diagram_core/core.py) is native-only: no bridge, no modes, no shadow logging; same
  method names and answer shapes, so callers didn't change. `BridgeError` became `DiagramCoreError` (raised where
  TypeScript throws: YAML errors, a model/standard missing a field -- only the error's type kept --, an unknown
  family); `canonical_json`/`JsonObject` moved to core.py. Settings `DIAGRAM_BRIDGE_URL`/`DIAGRAM_CORE_MODE` are
  removed; `app.state.diagram_core` replaces `app.state.diagram_bridge`, and every `bridge` parameter/helper in
  routes, GitHub and chat code is now `core`/`_diagram_core`. The HTTP client moved to `tests/diagram_bridge.py`
  (with `BridgeError`), used only by the comparison tests (`bridge_url`/`needs_bridge` fixtures); route tests no
  longer need the bridge, so they run without Node. `test_diagram_core_modes.py` became `test_diagram_core_api.py`
  (native answers and errors). Also deleted in Azure, with the user's OK: the unused `canvas-diagram-bridge` ACR
  repository. Decided with the user: an unexpected exception in an AI tool fails the request (Python's stricter
  behaviour), unlike TypeScript, which handed its message to the model.
- `canvas-1bty.15.8` part 1 (Python phase 11h-1): **the diagram-core bridge is out of production.** Before the
  cutover, main was deployed to Azure in shadow mode and driven through every diagram-core path (95 corpus diagrams
  imported as drafts and saved, 285 exports, 36 template compiles; then cleaned up): no `diagram-core shadow
  mismatch`, with a known mismatch (`constructor` node id, canvas-1bty.15.9) imported as a control to prove the
  warnings arrive (App Insights logs are not sampled: `enable_trace_based_sampling_for_logs` is off; requests are,
  ~5/s). Then: `create_app` always builds a `DiagramCore` (native without `DIAGRAM_BRIDGE_URL`; it used to leave
  diagram-core unset, so routes 503'd); the `canvas-api` sidecar, `DIAGRAM_BRIDGE_URL` and the `diagramCoreMode`
  param are gone from Bicep (the `api` container took the sidecar's 0.25 CPU / 0.5Gi: 0.75 / 1.5Gi); deploy.sh no
  longer builds `canvas-diagram-bridge` and refuses `CANVAS_DIAGRAM_CORE_MODE`; CI's e2e job no longer starts the
  bridge; the stale `/py/diagram-core` probe and `packages/diagram-bridge/Dockerfile` are deleted. Decided with the
  user: the bridge stays as a **test-only reference** (the browser still runs TypeScript diagram-core, so CI's
  Python tests keep comparing against it, `REQUIRE_BRIDGE=1`). Part 2 (the "bridge" naming in routes,
  `DiagramCore`'s modes, tests that needlessly need the bridge) is cleanup.
- `canvas-1bty.15.7` part 2 (Python phase 11g-2): **the AI chat's diagram tools are native.**
  `diagram_core/ai/` ports diagram-tools.ts (`tools.py`: every tool, offered by family and standard, the
  not-found/standard checks, kind limits, returned ids, `newViolations`), the primers (`primers.py`, generated from
  TypeScript's text), standard-prompt.ts and describe-model.ts (`prompt.py`), and the bridge's ai.ts
  (`list_tools`/`run_tool`/`prompt_sections`). `schema.py` is a small zod: one definition gives the JSON Schema
  byte for byte as zod's toJSONSchema writes it (an optional field's description first, a required one's last;
  `minItems` before `type`) and the input check with zod's issues and the AI SDK's "Invalid input for tool ..."
  text; decided with the user: the common failures (missing field, wrong type, enum, too short) match word for
  word, rarer wording may differ (only the model reads it). `DiagramCore.ai_tools`/`ai_tool`/`ai_prompt` go
  through the modes; in shadow mode the native tool run reuses the ids the bridge generated
  (`diagram_ops.ids_from`, a ContextVar, per request), so answers compare. A tool that throws ValueError (empty
  label, bad link) is `{ok: false, error}` as in TypeScript; any other exception is a BridgeError. Nothing is
  bridge-only now (11h retires the bridge). Tests: `test_diagram_core_ai.py` replays
  `tests/data/ai_tools_vectors.json` (`make_ai_tools_vectors.ts`, run in packages/diagram-bridge's vitest: tool
  lists for 7 families x 12 rule sets, prompt sections, 202 seeded tool-call sequences (1,616 calls, some input broken)),
  checked to catch 15 deliberate bugs; the chat tests in shadow mode compare every AI call with no mismatch.
- `canvas-1bty.15.7` part 1 (Python phase 11g-1): **the model edits are native.** `diagram_core/diagram_ops.py`
  ports diagram-ops.ts (all 32 edits: nodes, edges, styles, links, roles, ER/UML/architecture edge patches,
  containers and nesting, sequence markers and autonumber) and `standard_ops.py` ports standard-ops.ts
  (`add_element_of_kind`, `apply_element_kind`, `apply_connector_rule`). Not wired into `DiagramCore` yet: the AI
  tools that call them are 11g-2. Conventions: None in a model is undefined; where TypeScript writes a maybe-
  undefined field (`label: input.label`) Python writes None, so the key keeps its slot and a later edit lands
  where TypeScript puts it (JSON key order matches); in a patch, absent = untouched, None (null) = clear.
  `generate_id` is a module function, so tests supply TypeScript's ids. Tests: `test_diagram_core_ops.py` replays
  `tests/data/diagram_ops_vectors.json` (`make_diagram_ops_vectors.ts`: 2,400+ seeded random steps on corpus
  and hand-made models, JSON text compared after every step), checked to catch 13 deliberate bugs.
- `canvas-1bty.19` (security): **the icon SVG clean-up is hardened, in TypeScript and Python together**
  (`svg-import.ts` / `diagram_core/svg_import.py`, identical, parity-fuzzed). From an appsec review of the 11f
  port, which matched TypeScript, so both had the holes: (1) time: the tag pattern backtracked EXPONENTIALLY (26
  quoted attributes and no `>` took 5.4 s) and comment/CDATA/`<?xml`/DOCTYPE removal was quadratic; now a tag
  can't cross `<` and an unquoted value can't start with a quote, removals are index loops, and a closer is
  matched through a per-name open count (all linear, < 0.1 s at 200 KB); (2) no external loads: values may hold
  only the five named XML references (any other `&` drops the attribute), no `\`, no
  javascript:/vbscript:/data:, and only `url(#id)`, transforms, `rgb(a)`/`hsl(a)` as functions; `style` keeps
  allowlisted presentation properties; (3) balanced output (stray closers dropped, open elements closed);
  (4) `xmlns*` and prefixed attributes dropped, `xlink:href` written as `href` (exports never declared xlink);
  (5) well-formed XML: names `[A-Za-z_][\w.-]*`, duplicates dropped, `hidden` -> `hidden=""`, bare `&`/`<`/`>`
  in text escaped, XML-illegal characters removed. Refused: artwork over 200 KB (manifests had no cap), nesting
  over `MAX_ICON_DEPTH` (100), more than `MAX_ICON_USES` (16) `<use>`. The legacy `POST /libraries` (both
  services) now runs markup artwork through the strict cleaner; the seed still loads the bundled packs as
  shipped, and every bundled icon passes the new rules unchanged but for id prefixes and `href`. Follow-up:
  `canvas-1bty.20` (clip icon artwork to its box in the renderer).
- `canvas-1bty.15.6` (Python phase 11f): **the library admin's diagram-core work and document embeds are
  native.** `diagram_core/svg_import.py` ports svg-import.ts + svg-sanitizer.ts (`prepare_uploaded_svg`,
  `sanitize_icon_markup_strict`, `sanitize_svg_fragment`), `libraries.py` loadLibrary and the icon-refs op,
  `embeds.py` markdown-embeds.ts (`update_embeds`). `DiagramCore` gained `svg_prepare`, `svg_sanitize_strict`,
  `load_library`, `icon_refs`, `embeds`, all through the modes, so /admin/libraries/* and GitHub submissions' README
  embeds no longer need the bridge in `native` mode. JS details kept: the id prefix is made safe per UTF-16 unit
  (an emoji -> two dashes), `/i` is `re.IGNORECASE | re.ASCII` (Python alone folds the long s and Kelvin sign onto
  s/k: `<ſcript` must NOT match `<script`), viewBox numbers go through JS `Number()` (`js_number_value` now refuses
  `0x1_0`/`0x+1` and returns Infinity for a huge hex). A manifest that isn't the documented shape gets
  {ok: false} from Python where TypeScript throws a raw TypeError (admin-only legacy POST /libraries). Tests:
  `test_diagram_core_svg_import.py` (TS contract cases + hostile/random SVG fuzz against the bridge, checked to
  catch a dropped `re.ASCII` and a Python `lstrip()`), `test_diagram_core_embeds.py` (1,847-case fuzz, every
  status). An appsec review found no Python/TS divergence but shared sanitizer weaknesses (quadratic regexes, a
  url() filter bypass, wrapper breakout, xmlns aliasing, the weak denylist): `canvas-1bty.19`.
- `canvas-1bty.15.5` (Python phase 11e): **template import is native.** `diagram_core/templates/` ports every
  template compiler (architecture, C4 context, C4 container/component/deployment, ERD, sequence, UML class) plus
  the Markdown-table and helper code; `DiagramCore.compile_template` goes through the modes like render, so
  POST /projects/:id/diagrams/import-template compiles natively in `native` mode and is compared in `shadow`.
  Icon catalogues: the architecture compiler only needs library ids/versions and Azure's icon ids, so Python
  carries `diagram_core/icon_catalogue.json` (7 KB) instead of the 640 KB manifests; diagram-core's
  `python-icon-catalogue.test.ts` fails when it drifts (`UPDATE_CATALOGUE=1` to regenerate). Fixed in TypeScript
  (both sides now agree): lookups keyed by user text (`SIDES`, icon library prefixes, ERD/UML `DIRECTIONS`, UML
  `VISIBILITY`, the template registry) read own keys only (`ownValue`), so "constructor"/"__proto__" no longer
  find Object.prototype. Reproduced on purpose: sequence step numbers go through JS `Number()` (`0x10`, `1e0`,
  `-0` are steps). Tests: `test_diagram_core_templates.py` (each doc's worked example; the C4 Context doc's is
  prose, so the test carries a fillable one) and a seeded fuzz of mutated examples and random fillings for every
  template type against the bridge (1,600 cases; plus ~30,000 in development, no differences).
- `canvas-1bty.15.4` (Python phase 11d): **drawing is native.** `diagram_core/svg_render.py` ports
  svg-renderer.ts (every shape, table/described/icon nodes, container roles, ER crow's feet, UML markers and
  multiplicities, anchors and `{group}` ends, links, the legend, the background), `sequence_layout.py` and
  `legend.py`; `DiagramCore.render_svg` goes through the modes like validate, so export and GitHub submissions
  render natively in `native` mode and are compared in `shadow`. Byte-for-byte: numbers are written as a JS
  template literal does (`js_template`), Math.min/max keep NaN, division by zero gives Infinity, and
  `js_hypot` is V8's Math.hypot (scaled, Kahan-summed): Python's `math.hypot` differs in the last bit on ~1/3
  of inputs, which shows in printed edge geometry. The corpus native test now checks render.svg; a seeded
  native-vs-bridge render fuzz (`test_diagram_core_render_fuzz.py`) covers icons, legends, links, backgrounds
  and odd colours; `render_layout_vectors.json` (`make_render_layout_vectors.ts`) pins the sequence layout and
  legend.
- `canvas-1bty.15.3` (Python phase 11c): **standards are native.** `diagram_core/standards/` ports schema
  constants, authoring scope, element kinds (all of kinds.ts, incl. `kind_add_blocked_reason`/`kind_defaults` for
  11g), `validate` and `check_standard_definition`/`standard_definition_notices`; `family_capabilities.py`;
  `colors.py` (`resolve_node_fill_stroke` + C4 colour tables, for the 11d renderer too); `c4.C4_ROLE_SHAPES`.
  `DiagramCore.validate`/`check_standard` go through the modes like parse. Shadow mode now survives ANY native
  exception (logs only its type, since a message could quote the diagram); `KeyError`/`TypeError`/
  `AttributeError` become BridgeError, as TypeScript throws there too. JSON semantics: an absent key is undefined,
  a present None is null (`!== undefined` = key present; `??`/`<` treat null as nullish/0). Corpus: 5 new
  standards (`strict-flowchart`, `v1-classic`, `authoring-none`, `icons-listed`, `c4-tags`; every rule id fires),
  3 `standards-*` cases + `case.json` on 15 existing cases across families; the native corpus test now compares
  violations. `tests/data/standards_vectors.json` (`make_standards_vectors.ts`) for the definition check, kind
  helpers, authoring and validate on hand-made models (fonts, nulls); seeded bridge fuzz
  (`test_diagram_core_standards_fuzz.py`).
- `canvas-1bty.15.2` (Python phase 11b): **every family's parse/serialize is native.** `diagram_core/` gained
  `c4.py`, `erd.py`, `uml.py`, `sequence.py`, `architecture.py` (+ `architecture_layout.py`, computeArchitectureLayout,
  checked against TS vectors in `tests/data/architecture_layout_vectors.json`); `core.py` exposes `PARSERS`/
  `SERIALIZERS` for all six, so detect/parse/serialize/empty DSL/portable Mermaid (C4/ER/class style lines included)
  no longer need the bridge (validate, render, templates, AI tools, library ops still do: 11c-11g). Golden corpus
  +73 cases (every family now has >= 13); `test_diagram_core_corpus_native.py` runs all of them; per-family test
  files add a seeded native-vs-bridge fuzz. Fixed in the flowchart port: an empty `style`/`classDef` (`{}`) is
  truthy in JavaScript and is kept (was dropped), and case-insensitive regexes use `re.ASCII` (JS `/i` folds ASCII
  only; Python also folds the Kelvin sign, long s, dotless i). Pitfall: a parser's None = undefined, but YAML dumps
  None as `null`, so a test serializing a freshly parsed model strips None fields first (`_as_parsed`). Known gap,
  all families: ids like `constructor`/`toString` read Object.prototype in TS front-matter lookups (`canvas-1bty.15.9`).
- `canvas-1bty.15.1` (Python phase 11a, first slice of porting diagram-core to Python): `apps/api-py/src/
  canvas_api/diagram_core/` answers natively family detection, flowchart parse/serialize, a new diagram's empty
  DSL and portable Mermaid for flowchart/sequence/architecture; everything else still goes to the bridge.
  `DiagramCore` (core.py, same methods as DiagramBridge, wraps it in app.py) picks by `DIAGRAM_CORE_MODE`:
  `shadow` (default in Azure: bridge answers, native compared, `diagram-core shadow mismatch` logged via stdlib
  logging -> App Insights, op/family only, never diagram text), `native` (CI e2e), `bridge`. Bicep param
  `diagramCoreMode`, deploy.sh `CANVAS_DIAGRAM_CORE_MODE`. Front matter YAML: `jsyaml.py` ports the `yaml` npm
  stringifier byte for byte (quoting, 80-col folding, block scalars, JS key order: array-index keys first) and
  reads YAML 1.2 core schema on PyYAML (now a direct dependency) with tabs in plain scalars allowed and NEL/LS/PS
  not line breaks. Python-vs-JS pitfalls handled: Python `$` also matches before a final newline (use `\Z`),
  `\s`/`.`/`\d` differ (spelled out), `None` = undefined inside parsers but JSON null after `to_js_json`
  (NaN -> null kept), integral floats written as ints. Link check (`model.py`) follows the WHATWG URL parser,
  checked against Node on 439 hrefs. Tests: native golden corpus (27 new flowchart cases), YAML vectors (868),
  link vectors, layout vectors, seeded native-vs-bridge fuzz, DiagramCore modes.
- `canvas-1bty.14` (Python phase 10): **Python is the front door.** First the last TypeScript-only group
  moved: the icon-library admin (group `library-admin`, 16 routes incl. POST /libraries;
  `routes/library_admin.py`), with new bridge ops `svg-prepare`, `svg-sanitize-strict`, `load-library`,
  `icon-refs` (batched, chunked under the bridge's 10 MB limit; a refused file doesn't take its icon id,
  as in TypeScript). Then `canvas_api/front_door/`: serves `WEB_DIST_DIR` (files present at start-up
  only; /assets immutable, the rest no-cache; .br/.gz; ETag/304), the paused page (`CANVAS_PAUSED`,
  `PAUSED_PAGE_PATH`), CORS for `WEB_ORIGINS`, Fastify's 404 body for unknown routes, security headers
  outermost on every response, and sends a group named in `TYPESCRIPT_ROUTE_GROUPS` (default none, the
  one-release fallback) plus `/docs` to `TYPESCRIPT_API_URL`. Python holds the route table
  (`front_door/route_groups.py`, held equal to `constants.json` `routeGroups`); routes match like
  find-my-way (static segment beats a parameter). **Client IP**: Python no longer trusts
  `X-Canvas-Client-IP` unless `TRUST_CLIENT_IP_HEADER=true`; it reads the last X-Forwarded-For entry.
  TypeScript behind Python sets `TRUST_CLIENT_IP_HEADER=true` to read the header Python sends. **Azure**:
  `canvas-api` (same name, so same address/allow-list/Entra redirect URI) runs the Python image (now
  with the web app built in, `apps/api-py/Dockerfile` web stage) plus the bridge sidecar, container
  `api` first (pause.sh/resume.sh use `--container-name api`); the TypeScript API is internal
  `canvas-api-ts` (`modules/tsapiapp.bicep`); `pyapiapp.bicep` is gone and deploy.sh deletes the old
  `canvas-api-py` app. `CANVAS_TYPESCRIPT_ROUTE_GROUPS` replaces `CANVAS_PYTHON_ROUTE_GROUPS` (refused).
  CI e2e: Python on :3000, TypeScript on :3001. Also fixed: StandardsAdminPage ignores a stale
  standards list (a slower answer for the previous type overwrote the clicked one); Python's slower
  standards list filed as `canvas-y3qt`.
- `canvas-1bty.13` (Python phase 9): sign-in answers from `apps/api-py` (group `auth`, 15 routes:
  /auth/config, session-check, me, logout, local/login, password, mfa/verify, mfa/enroll(/confirm),
  Entra /auth/login + /auth/callback, and the admin's POST /admin/users, reset-password, reset-mfa,
  unlock). Python now WRITES sessions too, in @fastify/session's row format (`auth/session.py`:
  start/save/end, new id + old one revoked at sign-in, expired rows pruned), so a session made by
  either service works on the other. **Front door**: for a forwarded request it sets
  `request.session = null`, leaving the session to Python -- otherwise @fastify/session re-saved the
  old session and sent its cookie after Python's new one, signing the user straight back out
  (`python-front-door.test.ts` fails without it). Ported: scrypt passwords (same params/hex salt as
  Node), policy, one-time passwords, 3-strike lockout, per-IP rate limit, TOTP, AES-256-GCM secrets,
  recovery codes (`auth/accounts.py`, `passwords.py`, `totp.py`, `mfa_crypto.py`); Entra OIDC with
  PKCE in `auth/oidc.py` (httpx + PyJWT, new dependency): state, iss param, ID-token signature
  against the JWKS by kid, iss/aud/azp/exp/iat (30 s leeway)/nonce, Entra `?error=` -> 403,
  client_secret_post or the managed-identity client assertion; discovery lazy at first use. The 15
  canvas-haz cases are in `tests/test_auth_oidc.py` (fake IdP via `create_app(oidc_transport=)`),
  each shown to fail with its check removed. Cross-service vectors (hashes, ciphertexts, TOTP,
  recovery-code hashes) in `tests/test_auth_units.py`. Both services need the same sign-in env
  (AUTH_MODE, ALLOW_LOCAL_AUTH, OIDC_*, AZURE_CLIENT_ID, MFA_*, LOGIN_RATE_LIMIT, WEB_ORIGINS):
  the front door only forwards a sign-in route it registered itself; `pyapiapp.bicep` passes them.
  Bootstrap-admin stays TypeScript (phase 12). Live parity on the dev DB: 62/62 identical, including
  sessions and authenticators set up on one service used on the other, both ways.
- `canvas-1bty.12` (Python phase 8): AI chat and its administration answer from `apps/api-py` (group
  `ai`, 21 routes: chat send/history, AI settings and model list, personas, reference material,
  usage, prices, /me/ai-usage). **The diagram tools stay TypeScript** (decided with the user): the
  bridge bundles `apps/api/src/ai/{diagram-tools,diagram-type-primers,standard-prompt,describe-model}.ts`
  (`describeModel` moved out of diagram-chat.service.ts for this) and serves new ops `ai-tools` (each
  tool's JSON Schema via the AI SDK's `asSchema`), `ai-tool` (runs one call; bad input/unknown
  tool/thrown error = `{ok:false,error}` with the SDK's own messages) and `ai-prompt`; its build
  aliases `@canvas/diagram-core` to `src/ai-core.ts` (source modules, no icon manifests). Bundle
  ~1.4 MB (zod). Python runs the loop (`canvas_api/ai/chat.py`, generateText + stepCountIs: 1 step
  in plan mode, 8 under a standard, else 5) behind a small `LanguageModel` interface with Anthropic
  (`anthropic` SDK 1.x, manual tool loop, content replayed as returned), OpenAI (`openai`, Responses
  API, as the AI SDK's default) and the mock (`mock_model.py`, port of mock-nlu.ts, same token
  estimate). Usage rows keep the AI SDK's provider names (`anthropic.messages`, `openai.responses`,
  `mock-provider`/`mock-model-id`) so prices still match. Tests inject `app.state.language_model`.
  Azure: canvas-api-py gets `AI_PROVIDER` and the provider key secrets. Live parity on the dev DB
  (mock provider): 127/128 identical (the one: FastAPI vs Fastify validation wording), including
  ten chat turns on twin diagrams and the token estimates.
- `canvas-1bty.11` (Python phase 7): the GitHub approval routes answer from `apps/api-py` (group
  `github`, 14 routes: admin status/repositories/workflow example/links/test, project link set/remove/
  read, submit, submission status/refresh/withdraw/history, project badges). `canvas_api/github/`
  ports the client (httpx; App JWT signed with `cryptography`, now a direct dependency; same token,
  ETag and rate-limit caches), links, submissions (lock row, orphan adoption, document embeds via
  the bridge's `embeds` op), status sync and the submission files. Those files must match the
  TypeScript ones byte for byte (a diagram submitted from one service and resubmitted unchanged
  from the other is "up to date"), so `github/jstext.py` copies JavaScript string rules: UTF-16
  lengths and slices, `trim`/`\s`, `JSON.stringify` spacing and numbers. The scheduled
  `canvas-github-sync` job now runs `python -m canvas_api.github.sync_run` in the canvas-api-py
  image; that image builds the CI validator bundle (`CANVAS_VALIDATOR_DIR`), and the Python app gets
  the GitHub App settings and `CANVAS_PUBLIC_URL` (pyapiapp.bicep). Contract: new GitHub schemas,
  and `Error` gained `violations` (422 `must_fix`). Python tests use an in-process fake GitHub
  (`tests/fake_github.py`, an httpx transport passed to `create_app(github_transport=)`). Also fixed:
  deploy.sh's rotated-secret refresh (canvas-28j) never reached canvas-api-py, so a rotated
  `database-url`/`session-secret` (since phase 2) or GitHub key wasn't picked up there.
  Live parity on the dev DB, against the fake GitHub: 50/50 responses identical, and resubmitting
  unchanged across services is "up to date" both ways.
- `canvas-1bty.10` (Python phase 6): `GET /diagrams/:id/export` (Mermaid/SVG/PNG) answers from
  `apps/api-py` (`routes/export.py`, group `export`): Mermaid and SVG through the bridge (icon
  artwork looked up here, legend entries from the active standard), PNG with **resvg-py** (new
  dependency; same Rust renderer as `@resvg/resvg-js`, system fonts off as there). Same download and
  CSP headers. The contract snapshot describes the route's file responses per content type; the
  pytest contract checker accepts a non-JSON response whose type the contract lists. Live parity
  on the dev DB: every Mermaid and SVG export byte-identical; PNGs pixel-identical except anti-
  aliasing on rotated arrowheads (~160 pixels; resvg-py bundles a newer resvg). Found:
  `canvas-dyvn`, PNG exports draw no text at all in either service (no font available to resvg).
- `canvas-1bty.9` (Python phase 5): standards now answer from `apps/api-py` (`routes/standards.py`,
  group `standards`, 7 routes): active/all versions of a type, create/edit draft, clone, publish
  (retires the one in force), retire. Publish/retire re-check every diagram of the type in a FastAPI
  `BackgroundTasks` task (refreshes cached violations only). The zod body schema is ported to
  pydantic (`standards_schema.py`, same field order/defaults, unknown keys dropped); structural error
  messages differ from zod's by design, diagram-core's definition-check issues (via the bridge's
  `check-standard`) are identical. `Error` schema gained `issues`; `constants.json` gained `ruleIds`.
  Also fixed `canvas-1bty.18` on both sides: creating/importing a diagram into a missing or
  soft-deleted project is 404 (was a foreign-key 500, or a diagram inside a deleted project).
  Live parity: 106/106 standards reads identical across 53 types (418 versions).
- `canvas-1bty.8` (Python phase 4): diagrams now answer from `apps/api-py` (`routes/diagrams.py`,
  group `diagrams`, 17 routes): create, search, read, compare-and-set save (409 `version_conflict`
  with `details`), rename/description/move, versions (list/preview/restore), presence, delete
  (drafts purged outright) and admin restore, DSL import and intake-template import. Parsing,
  validation, a new diagram's starting DSL and template compiling go through the diagram-core bridge
  (new bridge ops `empty-dsl`, `compile-template`; bundle now ~830 KB with the icon manifests the
  architecture template compiler needs). `canvas_api/standards.py` reads a type's published rules
  (writing standards is phase 5). The bridge is now required for the Python service (503 without
  it); CI's e2e job starts it, Azure already runs it as a sidecar. Optional query filters use one
  fixed statement per database with CAST-typed parameters (no SQL concatenation, no Core on UUID
  columns). `Error` schema gained an open `details`. 150 pytest cases ported (448 total, both DBs).
- `canvas-1bty.7` (Python phase 3): comments (8 routes), sharing + project members/ownership (8),
  admin users list/edit/delete + deletion impact + audit log + overview, and user lookup/search (8)
  now answer from `apps/api-py` (`routes/comments.py`, `sharing.py`, `admin_users.py`); groups
  `comments`, `sharing`, `admin-users` in `route-groups.ts`. Local accounts (create with a one-time
  password, reset password/MFA, unlock) stay TypeScript until sign-in moves (phase 9). Python gained
  `require_diagram_access`/`resolve_diagram_access` (access.py) and `revoke_sessions`
  (auth/session.py). Pitfall found live: SQLAlchemy Core binds str as VARCHAR and Postgres rejects
  `uuid = varchar`, so UUID columns are queried with fixed `text()` statements (bd memory
  `python-core-uuid-varchar`). Live parity on the dev DB: 45/45 moved GETs identical.
- `canvas-1bty.6` (Python phase 2): projects (create/list/read/tree/rename/soft-delete/restore; NOT
  members/ownership, those are phase 3), diagram types (list + admin create/edit/hide/delete), icon
  library list/search, and app settings now answer from `apps/api-py` (`src/canvas_api/routes/`).
  **Front door by route**: `apps/api/src/python/route-groups.ts` lists the moved routes as Fastify
  patterns; an `onRequest` hook (after the session plugin, before routes) forwards a request whose
  matched route is listed, via `@fastify/reply-from` (`@fastify/http-proxy` removed). The TypeScript
  routes stay registered one release as the fallback: `PYTHON_ROUTE_GROUPS` (unset = all, `none`,
  or names; deploy.sh `CANVAS_PYTHON_ROUTE_GROUPS`, bicep `pythonRouteGroups`). The front door sends
  `X-Canvas-Client-IP` (Python's own ingress adds an X-Forwarded-For hop). **Contract (canvas-62y,
  per group)**: shared response schemas in `apps/api/src/contract/schemas.ts` (`$id`s, so /docs names
  them; Fastify serializes through them, so a schema must list every field); snapshot
  `apps/api/contract/openapi.json` + `constants.json` (families, personas, built-in type ids) from
  `tests/contract/openapi-snapshot.test.ts` (`UPDATE_CONTRACT=1` to regenerate); Python's
  `tests/api.py` client checks every response against it (extra fields, missing fields, JS ISO
  timestamps, undocumented statuses all fail). CI's e2e job starts the Python service and checks
  `/py/me` is forwarded before Playwright. Validated live on the dev DB: identical TS/Python answers
  for every moved GET (2,218 projects).
- Wave 5 (performance + hosting): **telemetry** (`canvas-6upe`, #269): OpenTelemetry ->
  Application Insights (`apps/api/src/telemetry/`; `register.ts` loads first; one span per Kysely
  query via its `log` hook; `tagRequestRoute` names spans by route template; `withSpan` for app
  work), workbook "Canvas performance" + `canvas-key-route-p95` alert (`modules/monitoring.bicep`);
  off when no connection string. **Same origin** (`canvas-r3y`, #270): the production image builds
  `apps/web` and canvas-api serves it (`src/web/web-app.ts`, `@fastify/static`, `wildcard:false`,
  precompressed `.br`/`.gz` from `apps/web/scripts/precompress.mjs`; `/assets/*` immutable for a
  year, `index.html` no-cache; unknown non-API GETs get `index.html`). One origin = no CORS
  preflights and first-party cookies (`COOKIE_SAME_SITE=lax`), so sign-in works with third-party
  cookies blocked. The old Storage website only redirects. Paused mode is now `CANVAS_PAUSED=true`
  on canvas-api (`registerPausedMode`: paused page for browsers, 503 for API calls), set by
  pause.sh, removed by resume.sh. Measured (`canvas-i3n`): first load 1.3 s -> 0.77 s, bundle
  1.52 MB -> 352 KB, preflights gone; cold starts (`canvas-aots`) deliberately left as is.
  **Federated credential** (`canvas-haz.9`, #271): `OIDC_CLIENT_AUTH=managed-identity` signs in to
  Entra with the managed identity's token as a jwt-bearer `client_assertion`
  (`auth/managed-identity.ts`) instead of a client secret; default stays `secret`; deploy.sh
  `CANVAS_OIDC_CLIENT_AUTH`; not yet verified live (Azure runs `AUTH_MODE=local`).
- Wave 4 (editor UX): **zoom** (`canvas-bx3`): one factor on the canvas svg's `viewBox`
  (25%-400%, controls bottom-left, Ctrl/Cmd + wheel/pinch toward the pointer, Ctrl/Cmd + = - 0);
  `toClientPoint` divides by it; popups use `ScreenSizedForeignObject` to keep their on-screen size
  (small on-shape buttons and inline editors scale with the drawing); a view setting, never in the
  DSL. **Help** (`canvas-fkp`): `?help=<user|admin>[/<page>][&section=]`, docs/user-guide and
  docs/admin-guide bundled with `import.meta.glob` (images too) and rendered by
  `help/HelpMarkdown.tsx` (React elements, no raw HTML; tables, anchors); search by section;
  admin guide admins-only; `HelpLink` "?"s open sections in a new tab (rail tabs, Share/Members,
  Standards editor, GitHub page); new `docs/user-guide/common-questions.md`. A doc heading rename
  can break a "?" link -- `tests/unit/help.test.tsx` checks them. **Auto Layout for every family**
  (`canvas-p2g8.1`): `autoLayout(model, direction, family)` is compound (dagre per group,
  bottom-up, groups sized to fit, a group's own direction inside it); architecture uses
  `computeArchitectureLayout`; sequence untouched; direction written back only for
  flowchart/erd/uml. C4 Rel_U/D/L/R hints and pinned elements are `canvas-rqm6`. **Recently
  opened** (`canvas-93n`): localStorage per user (`projects/recent-diagrams.ts`), re-checked with
  the server on the Projects page.
- `canvas-thia` + `canvas-j6v`: **kind groups** -- `StandardRules.kindGroups` (`{ id, label, kindIds,
  minCount?, maxCount? }`, stored in `kind_rules` JSON, no migration) count several element kinds
  together ("one Component, whether New, Reused or Retired"). `kindAddBlockedReason()` in
  diagram-core (kind Max count, then any full group) drives the canvas Elements buttons/kind picker
  and the AI's addElement/setElementKind; validator rules `kind-group-min-count`/`-max-count`;
  definition-check (>= 2 known kinds, a count, sane numbers); a "Kind groups" section in the
  standards editor (follows kind renames, drops removed kinds). **Create with AI no longer saves**:
  the dialog creates the diagram with `draft: true` (`diagrams.draft`, Postgres `0034`, SQLite
  `0022`) and hands the drawing to the editor via sessionStorage (`ai/ai-draft.ts`), which shows
  "Not saved" until the first Save clears the flag. A draft is in no list (tree, search, counts,
  shared-with-me) and 404s for anyone but its creator (`isOthersDraft` in the access middleware);
  deleting one (the leave prompt's Discard) is a hard purge, not the bin; `npm run purge` also
  removes drafts older than `DRAFT_RETENTION_HOURS` (24).
- `canvas-2h2w.1` (sharing v2, part 1, docs/sharing-design.md): **open read-only**. Access is the
  HIGHEST of View (everyone signed in), project access (owner of it or an ancestor = Manage, admin =
  Manage, project grants on it or any ancestor), a diagram share, and owning the diagram (Manage);
  then the `viewer` role caps it at Comment (`src/sharing/access-levels.ts`: `highestAccess`,
  `capForRole`). A diagram-level grant no longer hides a higher project grant (the old
  most-specific rule), and the project owner now has access to every diagram in the project. New
  level `manage` (Postgres `0033`, SQLite `0021` rebuilds `share_grants` for its CHECK): projects
  only (diagram shares stop at Edit); only Manage can give, change or remove a Manage grant.
  `GET /projects` lists every project with `accessLevel` and `membership` ('owner' | 'member' |
  null), computed by `projectAccessForUser`; `withAccessibleProjects` is gone. Viewers can't
  `POST /projects`. Web: Projects page = My projects / Shared with me / All projects; a project or
  diagram below Edit is read-only (no New Diagram/Move/Delete; editor hides tools, Save, Chat,
  in-canvas `.canvas-edit-affordance`s; Canvas `readOnly` drops edits, Delete and double-click
  editing). Landing considers only the user's own projects.
  Same PR, `canvas-2h2w.2` (Members) + `.5` (Copy link): a project's members are managed by its
  owner, Manage members and admins (`POST /projects/:id/shares` and revoking a project grant need
  Manage; a diagram share still needs Edit). `GET /projects/:id/members` (owner + members +
  `yourAccess`, readable by all), `POST /projects/:id/owner` (owner/admin; new owner's grant
  removed, old owner kept as Manage; viewers can't own). Audit `project_member_added|changed|
  removed`, `project_owner_transferred`. "Shared with me" drops diagrams the user's project
  membership already covers at that level. Web: `MembersDialog` on the project page; the share
  picker is now `projects/PersonPicker.tsx` (ShareDialog's testids unchanged); `ui/CopyLinkButton`
  in the editor doc bar and the project header.
- `canvas-obp0` (two people editing one diagram, options A + B): saves are compare-and-set.
  `PATCH /diagrams/:id` and `POST /diagrams/:id/versions/:versionId/restore` REQUIRE
  `baseVersionId` (the `currentVersionId` the editor loaded or last saved; now on every diagram
  response); `saveDiagram` updates `current_version_id` only `WHERE current_version_id = base`, so
  of two saves from one base exactly one wins, and the loser gets 409 `code: 'version_conflict'`
  with `details: { currentVersionId, savedBy, savedAt }` and no version written. The editor keeps
  the base in a ref and shows `SaveConflictDialog` (Save mine anyway = resave with the reported
  version as base / Load the newer version / Keep editing, plus copy/download of your DSL).
  Presence: `diagram_edit_sessions` (Postgres `0032`, SQLite `0020`); `PUT /diagrams/:id/presence`
  heartbeat every 30s (edit access only), entries expire after 90s, `POST .../presence/leave` on
  unmount/pagehide (fetch keepalive); `PresenceBanner` names other editors and "you, in another
  tab". Tests saving through the API use `tests/helpers/versions.ts` (`currentVersionId`) or the
  e2e `save-helpers.ts` (`saveDsl`).
- `canvas-3dq` (Admin -> Libraries, two PRs): icon/shape libraries are `builtin` (catalog seed;
  retire/restore only) or `custom` (admin-imported; fully editable); libraries and icons can be
  retired -- hidden from palettes and icon search, still resolved for rendering, never undone by
  the seed re-ingesting (Postgres `0029`, SQLite `0017`). Import from SVG files via diagram-core's
  `prepareUploadedSvg` (strict element/attribute allowlist; `<style>`, entities, >200 KB refused;
  ids prefixed per icon; the file's viewBox fitted into the 48x48 icon space, never stretched) or
  from a manifest (`sanitizeIconMarkupStrict`; built-in ids reserved). Delete only when unused
  (409 lists the diagrams). Palette assignment per library marks built-in diagram types
  `admin_edited`. API under `/admin/libraries`; audit `icon_library_changed`. The legacy
  `POST /libraries` still loads libraries as built-in (seed/tests). E2E uses its own custom diagram
  type for palette checks so it never marks a built-in type edited.
- `canvas-3s5.3` (Phase 3, GitHub approval): new private workspace `packages/validator-cli` -- the
  validator a repository's CI runs (`node .canvas/validator.mjs --format github --render-dir
  rendered`): finds `canvas.json` manifests, parses each `.canvas.mmd`, validates against the
  committed standard JSON, GitHub annotations with line numbers (`findElementLine`, moved from
  apps/web to diagram-core) + step summary, renders SVGs, exits 1 on syntax errors / Must fix.
  esbuild bundles it to one ~210 KB file from diagram-core's SOURCE modules (the package entry
  would drag in 650 KB of Azure icons via the template compilers). Canvas commits it with every
  submission (identical content = no Git change); Dockerfile builds it, CI typechecks/builds/tests
  it. Example workflow (validate + "Architecture gate", pinned SHAs, no `paths:`) downloadable
  from Admin -> GitHub.
- `canvas-3s5.2` (Phase 2, GitHub approval): status sync (`apps/api/src/github/status-sync.service.ts`)
  -- merged = approved (version, merged-by, `merged_head_matches` flags edits made on GitHub),
  closed = rejected, open = latest review per reviewer + check runs/commit statuses (no Checks
  permission -> `unavailable`). Polling, not webhooks: editor refresh (30s throttle per PR) + the
  `canvas-github-sync` Container Apps Job every 15 min (`npm run github-sync`; only deployed with a
  GitHub App; pause.sh/resume.sh move its cron since the CLI can't suspend a scheduled job).
  Withdraw closes the PR with a comment (Postgres `0027`, SQLite `0015`). Approval rail tab,
  richer chip, project-page badges. A 404 from a cached token counts as lost access ("Needs
  attention" on the link). E2E `github-approval.spec.ts` runs against the fake as a standalone
  process (`tests/helpers/fake-github-server.ts`, started by CI's e2e job; skips when the API isn't
  pointed at the fake).
- `canvas-3s5.1` (Phase 1 of the `canvas-3s5` GitHub approval epic, design in
  `docs/github-approval-design.md`): an admin links a project to a GitHub repository + folder
  (`?admin=github`); anyone with edit access submits a saved diagram as a pull request (Must fix
  issues block; warnings listed in the PR). Merged = approved, closed = rejected. A GitHub App on
  github.com, plain-`fetch` client (`apps/api/src/github/`, no octokit): App JWT via `node:crypto`,
  installation tokens narrowed to the one repository. Each PR commits README (SVG first), portable
  `.mmd` (`toPortableMermaid(..., { stripFrontMatter: true })`), lossless `.canvas.mmd`, SVG,
  `canvas.json`, and `.canvas/standards/<type>/v<n>.json`; resubmitting pushes a commit to the same
  open PR (never force-push; unchanged tree = "up to date"). One open PR per diagram (partial unique
  index, also the submit lock). Config `GITHUB_APP_ID`/`GITHUB_APP_PRIVATE_KEY` (missing/`unset` =
  off, UI hidden); deploy.sh `CANVAS_GITHUB_APP_ID`/`CANVAS_GITHUB_APP_PRIVATE_KEY_FILE`, KV secret
  `github-app-private-key`. Migrations Postgres `0026`, SQLite `0014`. Tests run against a real
  `node:http` fake GitHub (`tests/helpers/fake-github.ts`). Status sync (merged/closed detection
  without resubmitting), the CI validator and the live check are Phases 2-4.
- `canvas-t3b` epic (Option B Browse redesign, design in `docs/browse-screen-design.md`): retired
  "current project" as global app state. The address is the state — `/` = project list,
  `?projectId=` = a project, `?diagramId=` = an open diagram (reload keeps it; diagrams are
  linkable) — via `apps/web/src/app/navigation.ts` and one guarded `navigate()` in `App.tsx`
  (t3b.2). Screen changes push history, so Back/Forward work; leaving a dirty editor any way,
  browser Back included, shows the single `home-nav-confirm`; `beforeunload` covers tab close.
  Landing on a bare address: the only project (nothing shared), else the last project opened in
  this browser (localStorage), else the list. One Browse surface (t3b.3): `ProjectsPage` is the
  top level (filter + New Project, project names are links, "Shared with me" below); a project's
  page has a `nav > ol` breadcrumb and an `<h1>` with its name; focus moves to the new screen's
  `<h1>` after user navigations; `document.title` per screen. Header (t3b.4): Projects / Admin
  links + skip link — `ProjectPicker` and `project-context.ts` (`withProjectContext`) are gone
  (t3b.6). Follow-up `canvas-513`/`canvas-4pw`: the admin page is App state (leaving admin is
  an in-app navigation, so the header's Projects link works there and Back/Forward cross admin
  <-> Browse); the admin console's own Back link was removed; admin pages have an `<h1>` and a
  "<page> – Admin – Canvas" tab title. New specs: `browse-navigation`, `browse-screen`, `app-header`; first
  `apps/web` unit tests (`tests/unit/navigation.test.ts`). Deferred: "recently opened" (`canvas-93n`).
- `canvas-chq`: every standard is viewable and editable on `?admin=standards`. Published/retired
  versions previously showed metadata only; now any version opens read-only (one native
  `<fieldset disabled>`), and Edit on a published/retired version "revises" it — its rules seed a
  NEW version that Save & publish makes active (the old one is retired and kept, diagrams
  re-checked); drafts still edit in place. Every built-in type now gets a published **starter
  standard** (`BUILT_IN_STANDARDS` in `seed/reference-standards.seed.ts`) — descriptive, not
  restrictive: C4 levels get the standard C4 element kinds/colors (relationships need a label, a
  warning), other types get their family's full shape list plus guidance — seeded only into types
  with no standard yet. Built-in diagram types are editable too (name/description/personas; never
  the family); `diagram_types.admin_edited` (Postgres `0015`, SQLite `0003`) stops the catalog seed
  overwriting an edited row. Fixed along the way: the editor's `cleanRules` stripped
  `match.external: false` from C4 kinds, so after any save Software System also claimed External
  System nodes (diagram-core treats an absent flag as "either") — it now always stores an explicit
  boolean.
- `canvas-ltm`: Create with AI supports follow-up questions. Persona prompts (edited in the admin
  UI) now ask the AI to clarify underspecified requests, but `CreateViaChatDialog` was one-shot —
  it discarded the assistant's reply and opened an empty diagram. A reply with no applied tool
  call now keeps the user in the dialog as a short conversation (answer, or "Just draw it"); the
  editor opens only once a reply draws something, on the Chat tab when a conversation happened.
  No API change: the existing chat endpoint already persists each turn and replays history. Also
  fixed: the AI-drawn DSL was never saved (the editor took it as its saved baseline, so leaving
  silently lost it) — the dialog now saves before opening; the dialog gains a diagram-type picker
  filtered by the persona's category (was hardcoded to `flowchart`); cancelling before anything is
  drawn deletes the empty diagram. `mock-nlu.ts` asks a question for a vague "create a … diagram"
  request and draws a placeholder on "go ahead and draw", for deterministic tests.
- `canvas-tfr` epic (Standards v2): standards are now defined as **element kinds** — named,
  semantic elements (e.g. a value chain's Primary Activity, C4 Context's External System) with
  allowed shapes, approved fill/stroke swatches, min/max counts and connector rules — carried on
  `node.role` so one definition drives all three authoring channels. Flowchart carries the kind as
  the node's Mermaid class (`A[x]:::primary_activity`; no `classDef` emitted, since the parser's
  class pass would overwrite a user-chosen swatch); C4 `_Ext` macros now set `DiagramNode.external`
  and round-trip instead of collapsing. The finer-than-family grain comes from **admin-defined
  diagram types** (`diagram_types.origin` builtin|custom; the catalog seed never overwrites a
  custom row) rather than a new profile layer. Enforcement is "constrain + flag", never blocking:
  draw (kind toolbar, swatch-only style popup, connector rules in connect mode) and chat (standard
  in the system prompt, `addElement`/`setElementKind` tools with kind enums, swatch-limited colors,
  `newViolations` fed back for self-correction) only offer what the standard allows; hand-written
  DSL is flagged live with line numbers; the Issues tab validates live with Must fix / Warning /
  Info severities and click-to-select. Published reference standards for **Value Chain** (new
  built-in type) and **C4 Context** are seeded into any type with no standard yet. New admin page
  `?admin=standards` (`?admin=true` alias). Migrations: Postgres `0014_standards_v2.sql`, SQLite
  `sqlite/0002_standards_v2.sql` (a new file — existing SQLite DBs never re-run `0001`). Follow-up
  `canvas-jki`: flip classDef/front-matter style precedence so `classDef` lines can be emitted for
  portable Mermaid export.
- `canvas-haz` epic (8 phases, now complete — live cutover verified 2026-10-17): migrated SSO from a self-hosted Keycloak Container App to Microsoft Entra
  ID — a real org identity platform, not a self-maintained one (realm-import maintenance, a
  fragile admin-API reconciliation script, an extra always-on Azure resource with its own
  database). Full cutover, no dual-IdP period (no live users to migrate mid-flight — this
  project's own Azure reference deployment is routinely paused/destroyed for cost control).
  **Phase 1** (PR #142): removed live Keycloak from CI/E2E/local compose — deleted the
  Keycloak-themed `sso-login.spec.ts` outright (decided with the user: unit/contract tests against
  mocked JWKS instead of a live-tenant E2E, since standing up a disposable cloud tenant per CI run
  is a different order of complexity than `docker compose up`, and MFA now lives entirely in
  tenant Conditional Access policy anyway, outside any test's reach regardless). **Phase 2**
  (content merged via PR #144): deleted the `/idp` reverse-proxy + internal/public issuer split —
  machinery that existed only because Keycloak's Container App ingress was internal-only; Entra's
  issuer is always public, so it has no replacement, just removal. **Phase 3** (PR #144):
  `apps/api/src/auth/oidc.ts` switched from Keycloak's nested `realm_access.roles` to Entra's flat
  top-level `roles` claim (`extractEntraRoles`, `mapIdpRolesToUserRole` — kept the existing
  priority-pick logic, since the App Roles manifest uses the exact strings `admin`/`architect`/
  `viewer`, no mapping table needed); dropped the Keycloak userinfo-endpoint call entirely in favor
  of reading `email`/`preferred_username`/`name` straight off the already-signature-verified ID
  token (`extractIdentityFromIdToken`); added real hardening that was missing before — a nonce
  (previously only PKCE verifier + state were checked), `client.enableNonRepudiationChecks` for
  actual ID-token signature verification (confirmed directly against `openid-client` v6's own
  source that this is NOT on by default — it trusts TLS-to-token-endpoint per OIDC Core 3.1.3.7
  unless explicitly enabled), and a `config.ts` issuer-format guard rejecting the v1 endpoint shape
  and the `/common`/`/organizations`/`/consumers` multi-tenant aliases at startup with a clear
  error instead of an opaque failure deep inside `openid-client`. **Phase 4** (PR #145): a new
  `tests/contract/oidc-callback.test.ts` — the real NFR-2 gate — drives the full `/auth/login` →
  `/auth/callback` flow through genuinely-not-mocked `openid-client`/`oauth4webapi` against a
  locally-generated RS256 keypair (`jose`, see Active Technologies), with `fetch` stubbed for
  discovery/JWKS/token-endpoint. 15 cases, including the actual signature-verification proof:
  tampered payload, wrong-key-same-`kid`, unknown `kid`, wrong `aud`/`iss` (including the v1 form),
  expired token, wrong nonce, mismatched state — each confirmed to **fail** (wrongly pass) when
  `enableNonRepudiationChecks` is temporarily removed, proving the hardening is load-bearing, not
  just present. **Phase 5** (PR #146): relocated the shared managed identity's only `AcrPull` role
  assignment from `modules/keycloak.bicep` into `modules/keyvault.bicep` (the identity's own home)
  *before* deleting the former — skipping this ordering would silently break every container app's
  ability to pull its image on the next from-scratch deploy, since an incremental deploy leaves an
  already-granted role assignment in place and would have masked the gap until exactly the kind of
  full teardown+redeploy Phase 7 does. Deleted `modules/keycloak.bicep`, `modules/usersjob.bicep`,
  and `infra/keycloak/` wholesale; added `entraTenantId`/`entraClientId` params, deriving
  `OIDC_ISSUER_URL` via `environment().authentication.loginEndpoint` (sovereign-cloud-correct
  rather than a hardcoded hostname) plus the required `/v2.0` suffix; rewrote `deploy.sh` (447→304
  lines), replacing the ~150-line Keycloak admin-API client-reconciliation block with a
  `print-the-redirect-URIs-and-a-ready-to-paste-az-ad-app-update-command` approach — deliberately
  not Graph-API-automated, since that would need broader app-registration permissions than the
  deploying identity should likely hold. **Phase 6** (this entry): docs pass — `RUNBOOK.md`'s
  "Keycloak SSO" section replaced with "Entra ID SSO" (tenant/app-registration setup steps, the new
  contract-test-only testing posture, and the Phase 7 manual live-verification checklist);
  `canvas-252.1` (Keycloak RP-Initiated Logout live-verification) closed as superseded — its own
  `bd remember` note pointed at a Keycloak flow that no longer exists; a related bug,
  `canvas-oo6` (deploy.sh's printed `canvas-keycloak-users` invocation not working), closed as
  superseded for the same reason, since that job no longer exists. **Deliberately unchanged**
  (explicit decisions made with the user, not oversights): `ALLOW_LOCAL_AUTH` fallback untouched;
  identity matching stays email-only (no new `oid`/`tid` column — same risk profile this app
  already accepted under Keycloak); a federated-credential (managed identity, no client secret at
  all) is real future hardening, filed as a follow-up (`canvas-haz.9`, moved out of the epic), not
  part of this cutover. **Phase 0 + Phase 7** (2026-10-08 → 10-17): rebuilt the Azure environment
  from scratch in centralus and ran the full manual checklist against the real tenant — every item
  passed (sign-in and role mapping for admin/architect/viewer, a dual-role user getting the higher
  role, an unassigned user getting `AADSTS50105` then the app's friendly 403, an Entra role change
  re-syncing on next login, a deactivated user rejected, sign-out round-tripping through Entra).
  Found along the way: the `canvas-azure` service principal had Assignment required turned off
  (any tenant user could sign in as `viewer`), now on; and rotated Key Vault secrets weren't
  reaching the running app (`canvas-28j`, fixed in `deploy.sh`).
- `canvas-jtm` epic (10 phases, now complete): `apps/api`'s database layer was hard-wired to
  PostgreSQL with zero abstraction — a single `pg.Pool` singleton, hand-written raw SQL across
  ~125 call sites, several Postgres-only constructs (`ILIKE`, `to_char`, `ON CONFLICT`,
  `make_interval`, `COUNT(*) FILTER`, 3 recursive CTEs underpinning project-hierarchy
  authorization) — a real barrier to anyone who didn't want to run a standalone Postgres server
  just to try the app, and a hard blocker to self-hosting on anything else. Replaced with Kysely
  (a typed SQL **compiler**, chosen specifically because — unlike a full ORM — it has no entity/
  active-record layer, matching Constitution Principle VI's anti-unnecessary-abstraction spirit;
  the constitution was amended, v1.1.0, to say so explicitly rather than silently reinterpreting
  the principle), now supporting **both PostgreSQL (default) and SQLite** end to end — not just an
  easier local-install story, a real tested second engine (`DB_CLIENT`/`TEST_DB_CLIENT`,
  `apps/api/src/db/client.ts`'s dialect-branching `getDb()`). Along the way: all 7 `TEXT[]` array
  columns became real join tables with an explicit `position` column (array order proved to be
  real content, not incidental, via a round-trip test); every table's primary key became an
  app-generated `crypto.randomUUID()` instead of a DB-side `gen_random_uuid()` default, removing
  the `pgcrypto` extension dependency entirely; the 3 recursive CTEs were rewritten as Kysely
  `.withRecursive()` expressions with a dedicated parallel-run SQL-compile comparison given their
  authorization-critical nature. SQLite's own schema is one squashed migration
  (`apps/api/migrations/sqlite/0001_init.sql`), not a replay of the 13 incremental Postgres-only
  ones (which use syntax SQLite can't parse at all — `CREATE EXTENSION`, a `DO $$...END$$` block,
  `ALTER TABLE ADD CONSTRAINT`). Two new Kysely plugins close real driver gaps found by actually
  running the suite against SQLite, not anticipated in advance: `SqliteValueCoercionPlugin`
  (better-sqlite3 rejects a bound JS `Date`/`boolean` outright) and `SqliteJsonColumnsPlugin`
  (SQLite has no JSONB auto-parse-on-read the way `pg` does). Three real latent bugs found this way
  too: `standard.service.ts`'s `publishStandard` deadlocked under SQLite's single-connection model
  (called `getDb()` fresh inside an already-open transaction instead of reusing it — harmless under
  Postgres's connection pool); `restoreDiagram`/`restoreProject`'s raw `>` comparison against a
  SQLite-read timestamp (a string there, not a `Date`) always evaluated `false`; and a Postgres-only
  `::text` cast in `library.service.ts`. CI (`.github/workflows/ci.yml`) now runs `apps/api`'s
  suite as a `db-client: [postgres, sqlite]` matrix (Playwright E2E stays Postgres-only — a
  separate, lower-priority decision, not required since the Azure production target stays
  Postgres). Verified beyond the test suite too: a live cold-start smoke test (migrate → seed →
  boot server → login → list projects → create a diagram, all over real HTTP) with `DB_CLIENT=sqlite`
  and zero Postgres/Docker running at all — the original problem this epic set out to solve.
- `jmuir-yvh`: soft-deleted diagrams past `DIAGRAM_RETENTION_DAYS` (30) were excluded from queries
  and blocked from restore (`DiagramRetentionExpiredError`), but no code path ever physically
  deleted the rows — a deliberate deferral from 002's own `research.md` §1 (Constitution VI: a
  scheduler built purely to enforce a timestamp check was judged disproportionate when the
  visible "gone after 30 days" behavior was already fully achieved without one), not a bug, but
  one this closes. Adds `findExpiredDiagramIds()`/`purgeExpiredDiagrams()` to
  `diagram.service.ts` and a new `apps/api/src/purge/run.ts` ops-run script (`npm run purge
  --workspace=@canvas/api`, `--dry-run` supported) — deliberately still not wired to an in-app
  scheduler, matching `research.md`'s own "a manual admin action or an ops-run script" framing and
  this project's existing `migrate`/`seed` script precedent (run it via whatever external
  scheduling a deployment already has, e.g. a timer-triggered Azure Container Apps Job mirroring
  `modules/migrationjob.bicep`'s own manual-trigger pattern — not built in this pass). Physically
  deletes, per expired diagram id inside one transaction: `chat_messages`/`diagram_chats` (no
  `ON DELETE CASCADE` from `diagrams`, unlike `diagram_versions` which already cascades) and
  `share_grants` (a polymorphic `subject_id` with no FK at all), then the diagram row itself.
  `projects` gained the identical soft-delete/retention shape later (`canvas-228.2`,
  `PROJECT_RETENTION_DAYS`) but is deliberately out of scope here — this bead named diagrams only
  — filed as a follow-up (`canvas-d3m`) rather than silently folded in. 6 new contract tests
  (`diagram-purge.test.ts`), full `apps/api` suite green (315/315).
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
