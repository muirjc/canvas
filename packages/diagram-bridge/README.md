# diagram-core bridge

diagram-core (TypeScript) over HTTP. It served the Python service while the backend moved to Python
(canvas-1bty, [docs/python-backend-assessment.md](../../docs/python-backend-assessment.md)); since
diagram-core's server side runs natively in Python (canvas-1bty.15) it is **test-only**: no longer deployed
(canvas-1bty.15.8), it is the reference the Python tests compare against (the golden corpus and random input),
because the browser still runs the TypeScript diagram-core and the two must keep matching. CI's Python tests start
it with `REQUIRE_BRIDGE=1`.

One dependency-free file, `dist/bridge.mjs` (esbuild, from diagram-core's source modules; the only
icon libraries in it are the manifests the architecture template compiler needs). Since
canvas-1bty.12 it also bundles the AI chat's diagram tools from `apps/api/src/ai` (`diagram-tools.ts`,
`diagram-type-primers.ts`, `standard-prompt.ts`, `describe-model.ts`, with zod and the AI SDK's schema
helpers), so the Python chat offers the model exactly the tools the TypeScript one does. It listens on `127.0.0.1:7070` (`BRIDGE_PORT`, `BRIDGE_HOST`).

| `POST /<op>` | Body | Answer |
|---|---|---|
| `detect` | `{ dsl }` | `{ family }` |
| `parse` | `{ family, dsl }` | `{ model }` or `{ errors }` |
| `detect-and-parse` | `{ dsl, family? }` | `{ family, model }` or `{ family, errors }` |
| `serialize` | `{ family, model }` | `{ dsl }` |
| `empty-dsl` | `{ family, diagramTypeId }` | `{ dsl }` (a new diagram's starting DSL) |
| `compile-template` | `{ diagramTypeId, template }` | `{ dsl }`, `{ errors }` or `{ unsupported: true }` |
| `validate` | `{ model, rules }` | `{ violations }` |
| `check-standard` | `{ rules, family }` | `{ issues }` |
| `render-svg` | `{ model, icons?, standardRules?, background? }` | `{ svg }` |
| `portable` | `{ dsl, stripFrontMatter? }` | `{ dsl }` |
| `embeds` | `{ markdown, docPath, sources, only? }` | `{ markdown, changed, results }` |
| `ai-tools` | `{ family, rules? }` | `{ tools: [{ name, description, inputSchema }] }` (JSON Schema, as the AI SDK sends providers) |
| `ai-tool` | `{ family, rules?, model, name, input }` | `{ ok: true, model, output, outcomes }` or `{ ok: false, error }` (bad input, unknown tool or an error in the tool: the text the model gets back) |
| `ai-prompt` | `{ family, rules?, model }` | `{ primer, standard, currentDiagram }` (the diagram-specific system prompt sections) |
| `svg-prepare` | `{ items: [{ svg, idPrefix }] }` | `{ results: [{ ok: true, assetRef } or { ok: false, error }] }` (uploaded SVG files as icon artwork) |
| `svg-sanitize-strict` | same | same (a custom manifest's artwork, checked strictly) |
| `load-library` | `{ manifest }` | `{ ok: true, library }` (validated, artwork sanitized) or `{ ok: false, error }` |
| `icon-refs` | `{ diagrams: [{ family, dsl }] }` | `{ refs: [IconRef[] or null] }` (each diagram's icon references; null when it doesn't parse) |

`GET /health` answers `{ "status": "ok" }`. Bad input is a 400 with `{ error }`; nothing is logged
but the startup line.

```bash
npm run build --workspace=@canvas/diagram-bridge
npm start --workspace=@canvas/diagram-bridge          # BRIDGE_PORT / BRIDGE_HOST to change
npm test --workspace=@canvas/diagram-bridge
```

The Python client is `apps/api-py/src/canvas_api/diagram_core/bridge.py`; its tests run the whole
golden corpus through the bridge.
