# Technology Stack: Canvas

|                        |                                                                                                                                         |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Document status**    | Draft                                                                                                                                   |
| **Version**            | 1.1                                                                                                                                     |
| **Date**               | 2026-11-03                                                                                                                              |
| **Companion document** | `docs/solution-architecture-document.md` §3 covers the _why_ behind the key choices; this is the complete, current dependency manifest. |

## Runtime requirements

| Requirement                    | Version                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Python                         | 3.15 (`requires-python = ">=3.15,<3.16"` in `apps/api-py/pyproject.toml`; `python:3.15-slim` in the image)                                                                                                                                                                                                                                                                                                                    |
| uv                             | Manages the backend's virtual environment and lockfile (`apps/api-py/uv.lock`); 0.13.1 in CI and the image                                                                                                                                                                                                                                                                                                                    |
| Node.js                        | 22 LTS (pinned in CI as `NODE_VERSION: '22'`): builds the web app, `diagram-core`, the validator and the test-only bridge                                                                                                                                                                                                                                                                                                     |
| npm                            | Whatever ships with Node 22 (npm workspaces for the TypeScript packages)                                                                                                                                                                                                                                                                                                                                                      |
| PostgreSQL (default) OR SQLite | Postgres 16 (`postgres:16-alpine` locally; Azure Database for PostgreSQL Flexible Server, version 16, in the cloud) through psycopg 3 — **or** SQLite through Python's built-in `sqlite3`, no separate server process. Selected by `DB_CLIENT` (see `RUNBOOK.md`). SQLite is for local dev/evaluation/small self-hosted use, not larger concurrent production deployments — see `docs/solution-architecture-document.md` §12. |
| Docker                         | Local dev only, and only needed for the Postgres engine — not required at all when running against SQLite                                                                                                                                                                                                                                                                                                                     |

## External services (optional/pluggable)

| Service            | Version                                               | Required for                                                                                                                                                                                                                                                   |
| ------------------ | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Microsoft Entra ID | Tenant-hosted, no version to pin (OIDC v2.0 endpoint) | SSO login with App Role-based access and tenant-enforced MFA — optional locally (`ALLOW_LOCAL_AUTH` fallback), primary auth path on Azure. Requires a real Entra tenant + app registration even for local testing — see `RUNBOOK.md`'s "Entra ID SSO" section. |
| Anthropic API      | Claude models via the `anthropic` SDK                 | AI chat, when `AI_PROVIDER=anthropic`                                                                                                                                                                                                                          |
| OpenAI API         | via the `openai` SDK (Responses API)                  | AI chat, when `AI_PROVIDER=openai`                                                                                                                                                                                                                             |

Neither AI provider is required — `AI_PROVIDER=mock` gives fully deterministic offline behavior
(used by default in E2E/CI).

## `apps/api-py` (FastAPI backend)

Versions are the lower bounds in `pyproject.toml`; `uv.lock` pins the exact ones (shown where they
differ). `[tool.uv] exclude-newer = "14 days"` only accepts releases at least two weeks old.

| Package                      | Version                | Used for                                            |
| ---------------------------- | ---------------------- | --------------------------------------------------- |
| fastapi                      | >=0.143.3              | HTTP routes, `/docs` (opt-in)                       |
| uvicorn[standard]            | >=0.54.0               | ASGI server                                         |
| pydantic / pydantic-settings | >=2.14.1 / >=2.16.0    | Request bodies, settings from the environment       |
| sqlalchemy                   | >=2.1.5                | SQL Core only (a query compiler, never the ORM)     |
| psycopg[binary]              | >=3.3.6                | PostgreSQL driver                                   |
| httpx                        | >=0.28.1               | Outbound HTTP: Entra OIDC, GitHub, managed identity |
| pyjwt[crypto]                | >=2.15.1               | ID-token signature and claim checks                 |
| cryptography                 | >=46 (locked 50.0.2)   | GitHub App JWT, MFA secret encryption               |
| anthropic                    | >=1.15.0               | AI chat, Anthropic provider                         |
| openai                       | >=3.35.1               | AI chat, OpenAI provider                            |
| resvg-py                     | >=0.5.0                | PNG export (resvg, the Rust SVG renderer)           |
| pyyaml                       | >=6.0.2 (locked 6.0.3) | Diagram front-matter YAML                           |
| structlog                    | >=26.1.0               | Structured logs                                     |
| azure-monitor-opentelemetry  | >=1.8.11               | Telemetry to Application Insights                   |

**Dev/test** (`[dependency-groups] dev`): pytest >=9.1.1 · ruff >=0.17.1 · mypy >=2.4.0 (strict) ·
jsonschema >=4.26.0 (checks responses against `apps/api-py/contract/openapi.json`) · types-pyyaml.

## `apps/web` (React frontend)

| Package              | Version                                                 |
| -------------------- | ------------------------------------------------------- |
| react / react-dom    | ^18.3.1                                                 |
| @canvas/diagram-core | workspace (`packages/diagram-core`)                     |
| qrcode               | 1.5.4 (exact; the two-step verification set-up QR code) |

**Dev/test**: typescript ^5.7.2 · vite ^6.0.3 · vitest ^5.0.4 · @vitejs/plugin-react ^4.3.4 ·
@playwright/test ^1.49.1 · @axe-core/playwright ^4.12.1 · @testing-library/react ^16.1.0 · jsdom
^25.0.1 · @types/react ^18.3.17 · @types/react-dom ^18.3.5 · @types/qrcode 1.5.6

No UI framework/component library — plain React + hand-written CSS (`apps/web/src/styles/`).

## `packages/diagram-core` (shared kernel)

| Package        | Version |
| -------------- | ------- |
| @dagrejs/dagre | ^3.1.0  |
| yaml           | ^2.9.0  |

**Dev/test**: typescript ^5.7.2 · vitest ^5.0.4

Deliberately minimal (see `docs/solution-architecture-document.md` §4.1). The browser runs this
package; the backend runs its Python port (`apps/api-py/src/canvas_api/diagram_core/`).

## `packages/validator-cli` and `packages/diagram-bridge`

Both bundle `diagram-core` with esbuild ^0.28.1 (dev/test: typescript ^5.7.2 · vitest ^5.0.4).
`validator-cli` is the validator a repository's CI runs on submitted diagrams; it ships in the API
image. `diagram-bridge` is test-only: the Python tests compare the Python diagram-core against it.

## Repo root (tooling, applies to every workspace)

eslint ^9.17.0 · @eslint/js ^9.17.0 · typescript-eslint ^8.18.0 · prettier ^3.4.2 · typescript
^5.7.2

## Infrastructure-as-Code (Azure deployment only)

Bicep (via `az bicep`, bundled with Azure CLI) — no separate version pin; `infra/azure/main.bicep`
and its modules use whatever provider API versions are declared per-resource (e.g.
`Microsoft.App/containerApps@2025-01-01`, `Microsoft.DBforPostgreSQL/flexibleServers@2025-08-01`
— see each module file for its exact resource API versions).

## Notes

- npm packages use `^` (caret) ranges, locked by the root `package-lock.json`. Python packages use
  `>=` lower bounds, locked by `apps/api-py/uv.lock` (`uv sync --frozen` in CI and the image).
- `@canvas/diagram-core` is resolved by `apps/web` via an npm workspace symlink to its **built**
  `dist/` output, not its TypeScript source — see `RUNBOOK.md`'s "Resetting state" section for the
  rebuild step this implies after any change to that package.
- `npm run licenses` writes `THIRD-PARTY-NOTICES.md`, which covers the npm packages and the Python
  packages Canvas ships.
- The backend was TypeScript (Fastify, Kysely) until phase 12 of the canvas-1bty epic; the last
  version is tagged `typescript-api-final`.
