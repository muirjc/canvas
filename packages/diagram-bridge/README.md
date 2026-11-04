# diagram-core bridge

diagram-core (TypeScript) over HTTP, **for tests only**. The backend (`apps/api-py`) runs a Python
port of diagram-core; the browser still runs the TypeScript one, so the two must keep matching. The
Python tests start this bridge and compare Python with it on the golden corpus and on random input.
CI's Python tests require it (`REQUIRE_BRIDGE=1`); locally they skip those comparisons without Node or
the built bundle. Nothing deployed uses it.

One dependency-free file, `dist/bridge.mjs` (esbuild, from diagram-core's source modules; the only
icon libraries in it are the manifests the architecture template compiler needs). It listens on
`127.0.0.1:7070` (`BRIDGE_PORT`, `BRIDGE_HOST`).

| `POST /<op>`          | Body                                             | Answer                                                                                               |
| --------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `detect`              | `{ dsl }`                                        | `{ family }`                                                                                         |
| `parse`               | `{ family, dsl }`                                | `{ model }` or `{ errors }`                                                                          |
| `detect-and-parse`    | `{ dsl, family? }`                               | `{ family, model }` or `{ family, errors }`                                                          |
| `serialize`           | `{ family, model }`                              | `{ dsl }`                                                                                            |
| `empty-dsl`           | `{ family, diagramTypeId }`                      | `{ dsl }` (a new diagram's starting DSL)                                                             |
| `compile-template`    | `{ diagramTypeId, template }`                    | `{ dsl }`, `{ errors }` or `{ unsupported: true }`                                                   |
| `validate`            | `{ model, rules }`                               | `{ violations }`                                                                                     |
| `check-standard`      | `{ rules, family }`                              | `{ issues }`                                                                                         |
| `render-svg`          | `{ model, icons?, standardRules?, background? }` | `{ svg }`                                                                                            |
| `portable`            | `{ dsl, stripFrontMatter? }`                     | `{ dsl }`                                                                                            |
| `embeds`              | `{ markdown, docPath, sources, only? }`          | `{ markdown, changed, results }`                                                                     |
| `svg-prepare`         | `{ items: [{ svg, idPrefix }] }`                 | `{ results: [{ ok: true, assetRef } or { ok: false, error }] }` (uploaded SVG files as icon artwork) |
| `svg-sanitize-strict` | same                                             | same (a custom manifest's artwork, checked strictly)                                                 |
| `load-library`        | `{ manifest }`                                   | `{ ok: true, library }` (validated, artwork sanitized) or `{ ok: false, error }`                     |
| `icon-refs`           | `{ diagrams: [{ family, dsl }] }`                | `{ refs: [IconRef[] or null] }` (each diagram's icon references; null when it doesn't parse)         |
| `auto-layout`         | `{ model, direction?, family }`                  | `{ model }` (the editor's Auto Layout)                                                               |

`GET /health` answers `{ "status": "ok" }`. Bad input is a 400 with `{ error }`; nothing is logged
but the startup line.

```bash
npm run build --workspace=@canvas/diagram-bridge
npm start --workspace=@canvas/diagram-bridge          # BRIDGE_PORT / BRIDGE_HOST to change
npm test --workspace=@canvas/diagram-bridge
```

The Python client is `apps/api-py/tests/diagram_bridge.py`; the tests start the bridge once per run
(`bridge_url` in `apps/api-py/tests/conftest.py`).
