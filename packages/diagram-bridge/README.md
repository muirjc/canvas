# diagram-core bridge

diagram-core (TypeScript) over HTTP, for the Python service while the backend moves to Python
(canvas-1bty, [docs/python-backend-assessment.md](../../docs/python-backend-assessment.md), phase 1).
Transition only: it goes once diagram-core's server side is ported to Python and passes the golden
corpus ([packages/diagram-core/corpus](../diagram-core/corpus)).

One dependency-free file, `dist/bridge.mjs` (esbuild, from diagram-core's source modules, no icon
libraries). It runs as a sidecar container next to `canvas-api-py` and listens on `127.0.0.1:7070`.

| `POST /<op>` | Body | Answer |
|---|---|---|
| `detect` | `{ dsl }` | `{ family }` |
| `parse` | `{ family, dsl }` | `{ model }` or `{ errors }` |
| `detect-and-parse` | `{ dsl, family? }` | `{ family, model }` or `{ family, errors }` |
| `serialize` | `{ family, model }` | `{ dsl }` |
| `validate` | `{ model, rules }` | `{ violations }` |
| `check-standard` | `{ rules, family }` | `{ issues }` |
| `render-svg` | `{ model, icons?, standardRules?, background? }` | `{ svg }` |
| `portable` | `{ dsl, stripFrontMatter? }` | `{ dsl }` |
| `embeds` | `{ markdown, docPath, sources, only? }` | `{ markdown, changed, results }` |

`GET /health` answers `{ "status": "ok" }`. Bad input is a 400 with `{ error }`; nothing is logged
but the startup line.

Measured 2026-11-01 (localhost, keep-alive, from Python): about 0.5 ms added per call; a save
(parse + validate) about 1.1 ms median, 2 ms p95, against 0.04-0.09 ms in-process. Small next to a
request's network time, so the sidecar shape (a second container in the same app) stays.

```bash
npm run build --workspace=@canvas/diagram-bridge
npm start --workspace=@canvas/diagram-bridge          # BRIDGE_PORT / BRIDGE_HOST to change
npm test --workspace=@canvas/diagram-bridge
```

The Python client is `apps/api-py/src/canvas_api/diagram_core/bridge.py`; its tests run the whole
golden corpus through the bridge.
