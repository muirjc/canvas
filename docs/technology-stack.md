# Technology Stack: Canvas

| | |
|---|---|
| **Document status** | Draft |
| **Version** | 1.0 |
| **Date** | 2026-09-11 |
| **Companion document** | `docs/solution-architecture-document.md` §3 covers the *why* behind the key choices; this is the complete, current dependency manifest. |

## Runtime requirements

| Requirement | Version |
|---|---|
| Node.js | 22 LTS (pinned in CI as `NODE_VERSION: '22'`) |
| npm | Whatever ships with Node 22 (npm workspaces monorepo — no separate package manager) |
| PostgreSQL (default) OR SQLite | Postgres 16 (`postgres:16-alpine` locally; Azure Database for PostgreSQL Flexible Server, version 16, in the cloud) — **or** SQLite via the bundled `better-sqlite3` driver, no separate server process. Selected by `DB_CLIENT` (see `RUNBOOK.md`). SQLite is for local dev/evaluation/small self-hosted use, not larger concurrent production deployments — see `docs/solution-architecture-document.md` §12. |
| Docker | Local dev only, and only needed for the Postgres engine — not required at all when running against SQLite |

## External services (optional/pluggable)

| Service | Version | Required for |
|---|---|---|
| Microsoft Entra ID | Tenant-hosted, no version to pin (OIDC v2.0 endpoint) | SSO login with App Role-based access and tenant-enforced MFA — optional locally (`ALLOW_LOCAL_AUTH` fallback), primary auth path on Azure. Requires a real Entra tenant + app registration even for local testing — see `RUNBOOK.md`'s "Entra ID SSO" section; there is no self-contained local-container equivalent (canvas-haz epic, replacing a self-hosted Keycloak Container App). |
| Anthropic API | Claude models via `@ai-sdk/anthropic` | AI chat, when `AI_PROVIDER=anthropic` |
| OpenAI API | via `@ai-sdk/openai` | AI chat, when `AI_PROVIDER=openai` |

Neither AI provider is required — `AI_PROVIDER=mock` gives fully deterministic offline behavior
(used by default in E2E/CI).

## `apps/api` (Fastify backend)

| Package | Version |
|---|---|
| fastify | ^5.1.0 |
| @fastify/cookie | ^11.0.1 |
| @fastify/cors | ^10.0.1 |
| @fastify/session | ^11.0.1 |
| @fastify/swagger | ^9.8.1 |
| @fastify/swagger-ui | ^6.1.1 |
| openid-client | ^6.1.7 |
| kysely | ^0.29.6 |
| pg | ^8.13.1 |
| better-sqlite3 | ^13.0.3 |
| pino / pino-pretty | ^9.5.0 / ^13.0.0 |
| zod | ^4.4.3 |
| ai | ^7.0.37 |
| @ai-sdk/anthropic | ^4.0.21 |
| @ai-sdk/openai | ^4.0.20 |
| @resvg/resvg-js | ^2.6.2 |
| @canvas/diagram-core | workspace (`packages/diagram-core`) |

**Dev/test**: typescript ^5.7.2 · vitest ^2.1.8 · tsx ^4.19.2 · supertest ^7.0.0 · jose ^6.2.2
(signs synthetic ID tokens in the Entra OIDC callback contract test — resolves to the copy already
transitively installed by `openid-client`, nothing new downloaded) · @types/node ^22.10.2 ·
@types/pg ^8.11.10 · @types/better-sqlite3 ^9.6.0

## `apps/web` (React frontend)

| Package | Version |
|---|---|
| react / react-dom | ^18.3.1 |
| @canvas/diagram-core | workspace (`packages/diagram-core`) |

**Dev/test**: typescript ^5.7.2 · vite ^6.0.3 · vitest ^2.1.8 · @vitejs/plugin-react ^4.3.4 ·
@playwright/test ^1.49.1 · @axe-core/playwright ^4.12.1 · @testing-library/react ^16.1.0 · jsdom
^25.0.1 · @types/react ^18.3.17 · @types/react-dom ^18.3.5

No UI framework/component library — plain React + hand-written CSS (`apps/web/src/styles/`).

## `packages/diagram-core` (shared kernel)

| Package | Version |
|---|---|
| @dagrejs/dagre | ^3.1.0 |
| yaml | ^2.9.0 |

**Dev/test**: typescript ^5.7.2 · vitest ^2.1.8

Deliberately minimal — the one package every other workspace depends on has almost no
dependencies of its own (see `docs/solution-architecture-document.md` §4.1).

## Repo root (tooling, applies to every workspace)

eslint ^9.17.0 · @eslint/js ^9.17.0 · typescript-eslint ^8.18.0 · prettier ^3.4.2 · typescript
^5.7.2

## Infrastructure-as-Code (Azure deployment only)

Bicep (via `az bicep`, bundled with Azure CLI) — no separate version pin; `infra/azure/main.bicep`
and its modules use whatever provider API versions are declared per-resource (e.g.
`Microsoft.App/containerApps@2025-01-01`, `Microsoft.DBforPostgreSQL/flexibleServers@2025-08-01`
— see each module file for its exact resource API versions).

## Notes

- All internal package versions use `^` (caret) ranges — exact resolved versions are locked via
  `package-lock.json` (npm workspaces, single root lockfile for all four `package.json`s).
- `better-sqlite3` is a native (prebuilt-binary) dependency, unlike `pg`'s pure-JS wire protocol —
  confirmed it ships a prebuilt `linux-x64` (glibc) binary, so `npm ci` against the production
  `node:20-slim` Dockerfile base needs no C++ toolchain (same reasoning already applied to
  `@resvg/resvg-js`, the other native dependency in this image).
- `@canvas/diagram-core` is resolved by `apps/api`/`apps/web` via an npm workspace symlink to its
  **built** `dist/` output, not its TypeScript source — see `RUNBOOK.md`'s "Resetting state"
  section for the rebuild step this implies after any change to that package.
