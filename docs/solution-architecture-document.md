# Solution Architecture Document: Canvas

|                        |                                                                                                                                                                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Document status**    | Draft                                                                                                                                                                                                                             |
| **Version**            | 1.1                                                                                                                                                                                                                               |
| **Date**               | 2026-11-03                                                                                                                                                                                                                        |
| **Owner**              | Engineering                                                                                                                                                                                                                       |
| **Companion document** | `docs/business-requirements.md` — the _why_; this document is the _how_. Where the two disagree on a technical detail, this document and the code it describes are authoritative.                                                 |
| **Source material**    | `specs/001-diagramming-platform/plan.md` and subsequent feature plans, `.specify/memory/constitution.md`, `infra/azure/`, `apps/web/package.json`, `apps/api-py/pyproject.toml`, `apps/api-py/migrations/`, live code inspection. |

## 1. Purpose & Scope

This document describes Canvas's technical architecture: how the system is structured, the
technology choices behind it and why, how data flows through it, and how it is deployed and
secured. It covers the platform as delivered through `specs/001` – `011` plus the substantial body
of post-spec-kit hardening and completeness work tracked in `CLAUDE.md`'s Recent Changes log and
the project's `bd` issue tracker (Azure deployment, Microsoft Entra ID SSO with enforced MFA, the
DSL full-compliance and canvas-UI-completeness epics, C4 template import, and self-hosted API
documentation).

## 2. Architecture Overview

Canvas is a three-tier web application in one repository: a React single-page app and the
TypeScript diagram engine (`packages/diagram-core`) as npm workspaces, and a Python backend
(`apps/api-py`). The diagram parsing/rendering/validation engine exists twice, on purpose: the
browser runs the TypeScript `packages/diagram-core`, and the backend runs a Python port of it
(`apps/api-py/src/canvas_api/diagram_core/`). Tests hold the two to identical output (§4.2).

> The backend was TypeScript (Fastify, Kysely, `apps/api`) until phase 12 of the canvas-1bty epic.
> The last version is tagged `typescript-api-final`.

```text
┌─────────────────────────┐        ┌───────────────────────────────┐
│   apps/web (React SPA)  │◄──────►│   apps/api-py (FastAPI)        │
│   - interactive canvas  │  REST  │   - serves the built web app   │
│   - DSL panel, chat,    │ (same  │   - auth (local + OIDC)        │
│     admin console       │ origin)│   - diagrams/projects/sharing/ │
└───────────┬─────────────┘        │     standards, GitHub approval │
            │ imports (built dist) │   - AI chat tool-calling       │
            ▼                      │   - export (Mermaid/SVG/PNG)   │
┌──────────────────────────────┐   │   - canvas_api/diagram_core    │
│ packages/diagram-core (TS)   │   │     (Python port of the        │
│ DSL parsers/serializers × 6  │   │      TypeScript engine)        │
│ families · standards ·       │   └───────────────┬───────────────┘
│ SVG renderer · model ops     │                   ▼
└──────────────────────────────┘   ┌───────────────────────────────┐
                                   │ PostgreSQL or SQLite           │
                                   │ (diagrams, users, projects,    │
                                   │ standards, icons, AI personas/ │
                                   │ chat history, sessions)        │
                                   └───────────────────────────────┘
                          ┌───────────────────────────┐
                          │ Entra ID (OIDC IdP, MFA)   │  (optional; Canvas-managed
                          └───────────────────────────┘   accounts as an alternative)
                          ┌────────────────────────────┐
                          │ Anthropic / OpenAI (AI chat)│  (optional; mock provider
                          └────────────────────────────┘   for offline/dev/CI use)
```

## 3. Technology Stack

| Layer             | Technology                                                                                                | Version (as pinned)                                                                                      | Notes                                                                                                                                                                                                                                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend language | TypeScript                                                                                                | ^5.7                                                                                                     | `apps/web` and the `packages/*` workspaces, one `tsconfig.base.json`                                                                                                                                                                                                                                        |
| Frontend          | React                                                                                                     | ^18.3                                                                                                    | No framework (no Next.js/Remix) — a plain Vite SPA                                                                                                                                                                                                                                                          |
| Frontend build    | Vite                                                                                                      | ^6.0                                                                                                     | Dev server + production bundling                                                                                                                                                                                                                                                                            |
| Backend language  | Python                                                                                                    | 3.13                                                                                                     | Managed with uv (`apps/api-py/pyproject.toml`, `uv.lock`)                                                                                                                                                                                                                                                   |
| Backend           | FastAPI + uvicorn                                                                                         | >=0.143 / >=0.54                                                                                         | Routes, request validation (pydantic), opt-in OpenAPI page                                                                                                                                                                                                                                                  |
| Database          | PostgreSQL or SQLite                                                                                      | Postgres 16 (Alpine locally, Azure Flexible Server in the cloud); SQLite via Python's built-in `sqlite3` | Single relational store — no separate document/cache store. Engine selected by `DB_CLIENT` (default `postgres`); SQLite is supported for local dev, evaluation, and small/single-team self-hosted use, not recommended for larger concurrent production deployments (single-writer serialization) — see §12 |
| Database access   | SQLAlchemy Core over psycopg 3 (Postgres) or `sqlite3`                                                    | >=2.1 / >=3.3                                                                                            | SQL Core only, never the ORM: no entity/active-record layer (`canvas_api/db.py`); see `.specify/memory/constitution.md` Principle VI                                                                                                                                                                        |
| Auth (OIDC)       | httpx + PyJWT                                                                                             | >=0.28 / >=2.15                                                                                          | PKCE authorization-code flow (+ nonce) against Microsoft Entra ID (`canvas_api/auth/oidc.py`); ID-token signature checked against the issuer's JWKS by `kid`, plus `iss`/`aud`/`azp`/`exp`/`iat`/nonce                                                                                                      |
| Identity Provider | Microsoft Entra ID                                                                                        | Tenant-hosted, v2.0 OIDC endpoint                                                                        | Org-managed, not self-hosted — a confidential (Web platform) app registration per environment; App Roles (`admin`/`architect`/`viewer`) drive authorization, MFA is enforced via tenant Conditional Access policy, not app code                                                                             |
| AI                | `anthropic` and `openai` SDKs                                                                             | >=1.15 / >=3.35                                                                                          | Canvas runs the tool-calling loop itself (`canvas_api/ai/chat.py`); a "mock" provider gives deterministic offline/CI behavior                                                                                                                                                                               |
| Auto-layout       | `@dagrejs/dagre`                                                                                          | ^3.1                                                                                                     | DAG ranking/positioning for the "Auto Layout" toolbar action (browser)                                                                                                                                                                                                                                      |
| PNG export        | `resvg-py`                                                                                                | >=0.5                                                                                                    | Server-side SVG→PNG rasterization (resvg, a Rust renderer), no headless browser needed                                                                                                                                                                                                                      |
| API docs          | FastAPI's own OpenAPI page                                                                                | —                                                                                                        | Swagger UI at `/docs`, JSON at `/openapi.json`, only with `ENABLE_API_DOCS=true`                                                                                                                                                                                                                            |
| API contract      | `apps/api-py/contract/openapi.json`                                                                       | —                                                                                                        | Every route's request/response shapes; frozen and edited by hand with the route it describes. The tests check every response against it                                                                                                                                                                     |
| Telemetry         | `azure-monitor-opentelemetry`                                                                             | >=1.8                                                                                                    | Request spans named by route template, sent to Application Insights when `APPLICATIONINSIGHTS_CONNECTION_STRING` is set                                                                                                                                                                                     |
| Testing           | pytest (backend), Vitest (TypeScript packages, web unit tests), Playwright + axe-core (E2E/accessibility) | —                                                                                                        | See §11                                                                                                                                                                                                                                                                                                     |
| IaC               | Bicep                                                                                                     | —                                                                                                        | Azure deployment (`infra/azure/`)                                                                                                                                                                                                                                                                           |

## 4. System Architecture

### 4.1 Repository layout

```text
apps/web/src/{canvas,palette,standards,admin,projects,ai,app,ui,styles}   # frontend
apps/api-py/src/canvas_api/{routes,auth,ai,github,front_door,             # backend
                            diagram_core,seed,jobs}
apps/api-py/{migrations,contract,tests}
packages/diagram-core/src/{model,dsl,standards,libraries,render,template} # diagram engine (browser)
packages/validator-cli                                                    # CI validator for GitHub
packages/diagram-bridge                                                   # test-only reference
```

- **`packages/diagram-core`** has no dependency on `apps/web` — a standalone package
  (`@dagrejs/dagre` and `yaml` are its only runtime dependencies) built to a `dist/` output that
  `apps/web` resolves via an npm workspace symlink. It owns: parsing and serializing all six DSL
  families, the standards validator, the SVG renderer, pure `DiagramModel`-mutation operations
  (`diagram-ops.ts`), and the Markdown intake-form template compilers.
- **`apps/web`** is a client-rendered SPA with no server-side rendering. It holds the
  `DiagramModel` for the currently-open diagram in React state; the canvas (`Canvas.tsx`), the DSL
  text panel, and the AI chat panel all read/write the same model object, kept in sync via
  `diagram-core`'s parse/serialize functions (`useDslSync.ts`).
- **`apps/api-py`** is a FastAPI service exposing a REST API (about 130 routes, see §7), plus an
  OIDC callback redirect and binary SVG/PNG export downloads. It is also the front door
  (`canvas_api/front_door/`): it serves the built web app (`WEB_DIST_DIR`) and the paused page
  from the same origin. Operational jobs (migrate, catalog seed, demo seed, bootstrap admin,
  purge, e2e reset) are modules run as `python -m canvas_api.jobs.<name>`.
- **`packages/diagram-bridge`** serves the TypeScript diagram-core over HTTP. Only the Python
  tests use it, to compare the Python port against the TypeScript original.

### 4.2 One diagram engine, two implementations

The diagram engine is the most consequential architectural choice in the codebase, stated as
Constitution Principle I ("Diagram-as-Data"). Concretely:

- In the browser, the canvas (interactive, DOM/SVG via React) calls the same geometry functions
  from `packages/diagram-core/src/render/svg-renderer.ts` (e.g. `nodeSize`, `clipEdgeEndpoint`,
  `splitLabelLines`, `iconNodeLayout`, `tableNodeLayout`, `computeSequenceLayout`) that the export
  renderer is built on — "SC-004" in the code's comments (canvas and export must never disagree).
- The backend's Python port (`canvas_api/diagram_core/`) parses, serializes, validates, renders
  and compiles templates for the server: import, save, export and GitHub submissions. It writes
  byte-for-byte the same output as the TypeScript engine, front-matter YAML included. pytest
  checks this against a golden corpus, generated vectors and seeded random input, comparing with
  the TypeScript engine through `packages/diagram-bridge` (`REQUIRE_BRIDGE=1` in CI).
- The AI chat's tools (`canvas_api/diagram_core/ai/tools.py`) mutate diagrams through the Python
  port of `diagram-ops.ts`, the same operations the canvas UI's click/drag handlers call — an
  AI-driven edit and a manual edit produce indistinguishable model states, and both go through the
  same standards-validation path on save (no AI-specific bypass).

## 5. Data Architecture

PostgreSQL (default) or SQLite is the sole persistent store (no cache/document store) — selected
by `DB_CLIENT`, see §12's SQLite decision entry for the engine trade-off. The schema is plain SQL
in `apps/api-py/migrations/`: incremental Postgres files (`*.sql`) and a separate SQLite series
(`sqlite/*.sql`) whose first file expresses the early schema at its final shape directly, since
SQLite cannot parse several Postgres-only constructs (procedural blocks, `ALTER TABLE ADD
CONSTRAINT`, `CREATE EXTENSION`). `canvas_api/migrations.py` applies pending files in name order,
each in its own transaction, recording them in `schema_migrations`. The main tables:

| Table                                                         | Purpose                                                                                                           |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `users`, `local_credentials`                                  | Accounts; local password auth is a separate table from the user record itself (an OIDC-only user has no row here) |
| `projects`                                                    | Folder/organization hierarchy for diagrams; soft-delete with restore                                              |
| `diagrams`, `diagram_versions`                                | The diagrams themselves (current `dslContent` + validation result) and their capped, searchable version history   |
| `diagram_types`                                               | The catalog of 15 seeded diagram types (§6), each tagged with persona(s), abstraction level, and `dslFamily`      |
| `standards`                                                   | Admin-defined, versioned, named/described/retirable governance rules per diagram type                             |
| `icon_libraries`, `icons`                                     | Versioned icon/shape library metadata (Azure, AWS, C4 notation, generic)                                          |
| `share_grants`                                                | Polymorphic (`subject_type` diagram\|project) view/comment/edit access grants                                     |
| `ai_personas`, `ai_persona_reference_material`, `ai_settings` | Admin-authored AI personas, their optional scoped reference material, and provider/enablement settings            |
| `diagram_chats`, `chat_messages`                              | Persistent per-diagram AI chat history                                                                            |
| `sessions`                                                    | Server-side sign-in sessions                                                                                      |
| `templates`                                                   | **Schema only, unimplemented** — see §14                                                                          |

Every table with a "soft delete" concept (`diagrams`, `projects`) follows the identical
`deleted_at`/`deleted_by_user_id`/`restored_at`/`restored_by_user_id` shape, with a
`DIAGRAM_RETENTION_DAYS`/`PROJECT_RETENTION_DAYS` (30-day) window. Physical deletion is a job
(`python -m canvas_api.jobs.purge`, `--dry-run` supported), not an in-app scheduler; Azure runs it
nightly as the `canvas-purge` Container Apps job.

## 6. Domain Model / Diagram Representation

The canonical representation of a diagram is **Mermaid DSL text** (Constitution Principle I). The
in-memory working representation both renderers and the AI tool layer operate on is a parsed
`DiagramModel`:

```text
DiagramModel { diagramTypeId, title?, direction?, nodes[], edges[], containers[], ... }
DiagramNode  { id, label, shape, role?, position, size?, style?, icon?, attributes?, members?, ... }
DiagramEdge  { id, sourceId, targetId, label?, arrow?, umlRelationKind?, erCardinality?, ... }
DiagramContainer { id, label, position, size?, role?, parentContainerId?, ... }
```

Six DSL families, each with its own parser/serializer pair registered in
`packages/diagram-core/src/dsl/registry.ts`, sharing this one model shape (family-specific
concerns are optional fields, not separate types):

| Family         | Real Mermaid header                                                | Diagram types built on it                                                                                                  |
| -------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `flowchart`    | `flowchart`/`graph`                                                | Generic flowchart, business capability map, value stream, application/enterprise landscape, roadmap, solution architecture |
| `c4`           | `C4Context`/`C4Container`/`C4Component`/`C4Dynamic`/`C4Deployment` | C4 Context, Container, Component, Code (repurposes `C4Dynamic`), Deployment                                                |
| `sequence`     | `sequenceDiagram`                                                  | Sequence Diagram                                                                                                           |
| `erd`          | `erDiagram`                                                        | Entity-Relationship Diagram                                                                                                |
| `uml`          | `classDiagram`                                                     | UML Class Diagram                                                                                                          |
| `architecture` | `architecture-beta`                                                | Network, Deployment, Cloud Infrastructure Diagram                                                                          |

Every parser is validated against a **round-trip contract**: `parse(serialize(model)) ≈ model`
and `serialize(parse(dsl)) ≈ dsl` (semantically, not necessarily byte-identical — e.g. chained
edges canonicalize to separate lines on output). These contract tests are Constitution Principle
IV's "non-negotiable, written and failing before implementation" requirement, and are the largest
single body of test code in the repository (packages/diagram-core has ~10,300 lines of test code
against ~10,200 lines of source, a roughly 1:1 ratio).

## 7. API Architecture

A conventional REST API (no GraphQL), one route module per resource domain
(`apps/api-py/src/canvas_api/routes/*.py`: auth, projects, diagram types, libraries, app settings,
comments, sharing, admin users, diagrams, standards, export, GitHub, AI, library admin), all
mounted in `canvas_api/app.py`. About 130 routes in all.

- **Contract**: `apps/api-py/contract/openapi.json` describes every route's request and response
  shapes, and `constants.json` the shared constants. Both are frozen and edited by hand together
  with the route they describe; the tests' client (`tests/api.py`) checks every response against
  them (extra fields, missing fields and undocumented statuses fail).
- **Self-documenting**: with `ENABLE_API_DOCS=true`, FastAPI serves its Swagger UI at `/docs` and
  the generated OpenAPI document at `/openapi.json`. Off by default, so a real deployment doesn't
  publish its API map.
- **Auth**: cookie-based server sessions stored in the `sessions` table, not JWT-bearer — see §8.
- **Errors**: one handler (`canvas_api/errors.py`) writes every error as `{error: string}`, plus
  `code`, `details`, `issues`, `violations` or `diagrams` where an error carries them. The real
  error behind a 500 is only logged server-side.
- **Validation**: request bodies are pydantic models; a validation failure is a 400 with the
  failing field named.

## 8. Security Architecture

- **Authentication**: two coexisting mechanisms, both producing the same server-side session
  (`canvas_api/auth/session.py`):
  - **Canvas email/password** (`AUTH_MODE=local`, or `ALLOW_LOCAL_AUTH=true` beside Entra for dev)
    — scrypt-hashed credentials in a separate `local_credentials` table, lockout after three
    failures, a per-IP rate limit and two-step verification (TOTP with recovery codes).
  - **OIDC via Microsoft Entra ID** (PKCE authorization-code flow, plus nonce) — the primary
    mechanism for a real deployment. MFA enforcement is entirely **tenant-side** (a Conditional
    Access policy, or Security Defaults) — there is no app-level enrollment step; Entra simply
    won't complete the authorization unless the tenant's own policy is satisfied. A user must also
    be explicitly assigned to the app registration ("Assignment required = Yes") to get a token at
    all — authorization is fail-closed at the tenant level, before canvas's own role-mapping code
    ever runs. App Roles (`admin`/`architect`/`viewer`, a flat top-level `roles` claim on the ID
    token) are re-read and re-synced into the local `users.role` on every login — Entra is the
    source of truth once a user has signed in via SSO once. ID-token signatures are verified
    against the tenant's published JWKS (PyJWT, key chosen by `kid`); `iss`/`aud`/`azp`/`exp`/
    `iat`/nonce/state are all validated before any session is established. User identity matching stays email-only (no
    `oid`/`tid` column) — a deliberate, disclosed smallest-change decision, same risk profile this
    app already accepted under Keycloak.
  - **Sign-out** performs a real RP-Initiated (OIDC) logout when the session came from SSO
    (`canvas-252`): the local session is destroyed _and_ the browser is navigated to Entra's own
    `end_session_endpoint`, so Entra's own SSO cookie is actually cleared — a local-auth session
    gets a plain, fast local-only sign-out with no IdP round-trip.
- **Authorization**: three roles (`admin`/`architect`/`viewer`), plus fine-grained per-resource
  `share_grants` (view/comment/edit) at both the project and individual-diagram level, resolved by
  `canvas_api/access.py` (`resolve_diagram_access`, `require_diagram_access`). No multi-tenancy — single-organization
  deployment (Constitution's own stated scope boundary).
- **Session cookie posture**: the API serves the web app from the same origin, so the default
  `SameSite=Lax` cookie works. `COOKIE_SAME_SITE`/`COOKIE_SECURE` remain for a split-origin
  deployment (a separately hosted frontend), which needs `SameSite=None`+`Secure` together
  (browsers reject the former without the latter). Behind a TLS-terminating proxy (Azure Container
  Apps), uvicorn runs with `--proxy-headers`, and the client address for rate limiting is the last
  `X-Forwarded-For` entry.
- **CORS**: explicit origin allowlist (`WEB_ORIGINS`) with credentials — reflecting `origin: true`
  combined with `credentials: true` would let any website ride a signed-in user's cookie.
- **XSS**: flowchart `click <id> href` interactions were the one place user-authored content
  becomes a real link/attribute in exported SVG — hardened via delegating scheme validation to the
  WHATWG URL parsing (not a hand-rolled regex, which had a real, found-and-fixed
  whitespace-obfuscation bypass) and rejecting any href/tooltip containing a quote or newline
  (the DSL's own click-href grammar has no escape syntax, so rejection — not escaping — is the
  only sound option). Reviewed by a dedicated appsec pass before merge, per that feature's own
  explicit requirement given the disclosed risk class.
- **Secrets**: Azure deployment sources every secret (Postgres password, session secret, OIDC
  client secret, AI provider API keys) from Key Vault via managed-identity secret references —
  never baked into a container image or Bicep parameter file. Instead of an Entra client secret,
  `OIDC_CLIENT_AUTH=managed-identity` signs in to Entra with the managed identity's token
  (a federated credential on the app registration).

## 9. AI Integration Architecture

Admin-authored **personas** (name, category, system prompt, optional scoped reference material)
drive a persistent, per-diagram chat panel. Two structural guarantees, both enforced in code, not
just convention:

1. **The model never emits raw DSL.** Every AI-driven change goes through a typed,
   family-conditional tool set (`canvas_api/diagram_core/ai/tools.py`) backed by the same model
   operations as the canvas UI's `diagram-ops.ts` — an out-of-family request (e.g. asking a sequence-diagram chat
   to set a UML relationship kind) has no tool call available to make at all, not a refusal
   string layered on top of a tool that exists anyway.
2. **No AI-specific validation bypass.** A tool-driven mutation goes through the identical
   standards check a manual edit already goes through.

Providers are pluggable (`AI_PROVIDER=anthropic|openai|mock`): Canvas runs the tool-calling loop
itself (`canvas_api/ai/chat.py`) over the `anthropic` SDK, the `openai` SDK (Responses API) or the
rule-based mock (`canvas_api/ai/mock_model.py`). The mock gives fully deterministic, offline-capable behavior for e2e tests and CI, at the cost of
those specs asserting mock-specific response text/colors (a disclosed, intentional trade-off, not
a gap — real-provider validation is a separate manual/spot-check activity).

## 10. Deployment Architecture

### 10.1 Local development

`docker compose up -d` (Postgres on host port 5433; or `DB_CLIENT=sqlite` and no Docker), then the
Python API (`uv run --env-file .env uvicorn canvas_api.main:app --port 3000` in `apps/api-py`) and
the Vite dev server (`npm run dev --workspace=@canvas/web`), which calls the API at
`http://localhost:3000`. See `README.md` and `RUNBOOK.md`. There is no local-container IdP: local
SSO testing needs a real Entra dev tenant + app registration (`RUNBOOK.md`'s "Entra ID SSO").

### 10.2 Azure (production-shaped reference deployment)

Reproducible Bicep IaC under `infra/azure/`, one resource group (`canvas-rg`):

- **Network**: a VNet with a delegated subnet each for Postgres and the Container Apps
  environment (private, not publicly addressable).
- **Data**: Postgres Flexible Server (private endpoint only) + a Key Vault (RBAC-authorized,
  purge-protection off by design so `destroy.sh` can fully clean up). A Storage account only holds
  a page redirecting the old web address.
- **Compute**: one image, built from `apps/api-py/Dockerfile` (ACR repository `canvas-api-py`),
  with the built web app, the CI validator bundle and the paused page inside. A Container Apps
  environment runs it as `canvas-api` (the public front door, ingress limited to an IP allow-list,
  scale-to-zero eligible) and as every job: `canvas-migrate`, `canvas-seed-catalog`, the demo seed
  (`canvas-seed`, not in local auth mode), `canvas-bootstrap-admin` (local auth mode),
  `canvas-purge` (nightly) and `canvas-github-sync` (every 15 minutes, when a GitHub App is set).
- **Monitoring**: Application Insights (`canvas-insights`) with a workbook and a key-route p95
  alert (`modules/monitoring.bicep`).
- **Container Registry**: images tagged with the deploying git commit's short SHA (never a
  floating `:latest` — Container Apps' own revision-diffing treats a reused tag string as a no-op
  even when the underlying digest changed).
- **Bootstrap ordering quirk (disclosed, not a bug)**: `deploy.sh` needs **two passes** on a
  genuine from-scratch deployment — pass one creates Key Vault itself (so `canvas-api`'s own secret
  references necessarily fail, since nothing exists in the vault yet); pass two seeds the secrets
  and everything comes up clean. Re-running the same script is always safe. Entra's app
  registration (redirect URIs, client secret) is reconciled manually, not by `deploy.sh` — it
  prints the exact values to register plus a ready-to-paste `az ad app update` command rather than
  calling Microsoft Graph (which would need broader app-registration permissions than the
  deploying identity should hold).
- **Cost-control lifecycle**: `pause.sh` stops Postgres compute, serves the paused page
  (`CANVAS_PAUSED`) and parks the scheduled jobs (keeping all data); `resume.sh` reverses it;
  `destroy.sh` is the full, irreversible teardown (resource group deletion + Key Vault purge), with
  local cached secrets deliberately preserved so a later rebuild reuses the same credentials.

## 11. Testing Strategy

Four layers, enforced by Constitution Principle IV for the first:

1. **diagram-core contract tests** (`packages/diagram-core/tests/contract/`, Vitest) —
   parse/serialize round-trip fidelity per DSL family, standards validation, SVG-render output
   shape. Written and failing _before_ the implementation they cover, not after.
2. **Python diagram-core parity** (`apps/api-py/tests/test_diagram_core_*.py`) — the Python port
   against the golden corpus, generated vectors and seeded random input, compared with the
   TypeScript engine through `packages/diagram-bridge`.
3. **API tests** (`apps/api-py/tests/`, pytest) — real HTTP request/response assertions through
   FastAPI's test client, every response checked against `contract/openapi.json`. They run against
   both engines: Postgres (schema `canvas_py` in the `canvas_test` database on `localhost:5433`,
   recreated each run) by default, or in-memory SQLite with `TEST_DB_CLIENT=sqlite`. Tests build
   their settings directly, so an exported `DATABASE_URL` can never point a test run at a real
   database. GitHub and the identity provider are answered in-process (`tests/fake_github.py`, a
   locally generated RS256 key for signed test ID tokens). CI's `unit-tests` job runs the suite as
   a `db-client: [postgres, sqlite]` matrix.
4. **End-to-end** (`apps/web/tests/e2e/`, Playwright + axe-core) — drives the real running app in
   a real browser against the Python API on port 3000 and the mock AI provider. SSO itself is
   deliberately **not** covered by a live-browser E2E spec: standing up a disposable Entra tenant
   per CI run is out of proportion, and MFA lives in tenant Conditional Access policy anyway.
   Instead, `tests/test_auth_oidc.py` drives the real `/auth/login` → `/auth/callback` flow against
   a fake IdP with a locally generated keypair, proving ID-token signature verification, claim
   validation and role mapping. Whether the _real_ tenant's app registration, role assignments and
   redirect-URI list are configured correctly is covered by a manual post-deploy checklist
   (`RUNBOOK.md`'s "Entra ID SSO" section).

CI (`.github/workflows/ci.yml`) runs `lint-and-build` → `unit-tests` → `e2e-tests` on every PR;
`main` is branch-protected requiring them green and the PR branch up to date.

## 12. Key Architectural Decisions

| Decision                                                                                                     | Rationale / trade-off                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Mermaid DSL as sole source of truth, SVG/PNG purely derived                                                  | The only way three export formats stay mutually consistent — the alternative (rendered output as truth) makes diffing/templating/programmatic validation impossible (Constitution Principle I)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| One diagram engine design, in TypeScript for the browser and ported to Python for the server                 | The browser needs TypeScript; the backend moved to Python (canvas-1bty). Two implementations could drift, so the Python port must produce byte-identical output, enforced by parity tests against the TypeScript engine on every CI run. Any change to diagram behaviour lands in both                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Standards enforcement is soft-flag, never blocking                                                           | Preserves architect autonomy while still making violations visible and auditable — a deliberate governance-vs-friction trade-off, not an oversight                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Sequence-diagram geometry is fully computed, never stored                                                    | `canvas.positions` front-matter round-trip is intentionally dropped for this one family — declaration/message _order_ is the real DSL content; storing now-ignored positions would be a worse trap than omitting them                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Single-organization deployment, no multi-tenancy                                                             | Explicitly out of scope (BRD §5.2) — every admin-defined standard/library is global, simplifying the data model considerably                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| No ORM; SQL through SQLAlchemy Core                                                                          | Mostly straightforward CRUD plus a few polymorphic/recursive queries (project trees, access resolution) — judged not to need a full ORM's entity/active-record abstraction cost (Constitution Principle VI). Queries are fixed SQL statements or Core expressions that work on both engines; UUID columns are queried with fixed `text()` statements, since Core binds a string as VARCHAR, which Postgres won't compare with a UUID                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| SQLite as a second supported database engine, Postgres remains the default                                   | Removes the hard requirement to run a standalone Postgres server (via Docker or otherwise) just to try the app locally — a real adoption barrier. Scoped deliberately to Postgres + SQLite only (no MySQL); SQLite is documented as suitable for local dev, evaluation, and small/single-team self-hosted use, not larger concurrent production deployments, because SQLite serializes writers (one writer at a time; `SQLITE_BUSY` under contention without WAL tuning this project does not attempt to add). The Azure reference deployment's own default stays Postgres — this makes SQLite a real, tested _option_, not a migration off Postgres. Where the engines differ (no native boolean, timestamp or JSONB type in SQLite), the code chooses a statement per engine rather than building SQL by string concatenation                                                                                                |
| AI tool-calling constrained to typed operations, never raw DSL                                               | The same trust boundary a manual edit already has (standards validation, family-appropriate vocabulary) applies uniformly, with no AI-specific bypass path to audit separately                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Python backend replaces the TypeScript one (canvas-1bty, complete at phase 12)                               | Moved route group by route group behind a front door, each group held to the same API contract and checked live for identical answers, then diagram-core's server side was ported and compared in production in shadow mode before cutover. Background and plan: `docs/python-backend-assessment.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Microsoft Entra ID replaces self-hosted Keycloak as the IdP (`canvas-haz`, full cutover, no dual-IdP period) | Keycloak required self-maintaining an always-on Container App, its own Postgres database, a version-controlled realm import, and a fragile admin-API reconciliation script — operational burden for an identity platform the organization already runs externally. Full cutover (not a phased/dual-IdP migration) was viable specifically because this is a single-organization deployment with no live users to migrate mid-flight, routinely paused/destroyed for cost control anyway. Kept unchanged: the `ALLOW_LOCAL_AUTH` fallback, email-only identity matching (no new `oid`/`tid` column), and the BFF/session-cookie architecture itself — this was an IdP swap, not an auth-architecture rewrite. SSO live-browser E2E coverage was dropped in favor of tests against a fake IdP (see §11) — the IdP being a real cloud tenant rather than a disposable local container makes that trade-off clearly worth it here. |

## 13. Non-Functional Requirements / Quality Attributes

- **Performance**: SC-007 (BRD) — save/load/search stay perceptibly instant at ≥1,000 diagrams per
  project. The TypeScript service's opt-in performance test for this was not ported; the
  Playwright suite has an opt-in canvas performance spec (`RUN_PERF_TESTS=1`).
- **Accessibility**: WCAG 2.1 AA for keyboard navigation and color contrast (Constitution
  Technology & Compliance Constraints), verified via `@axe-core/playwright` in the E2E suite.
- **Cost control**: the pause/resume/destroy lifecycle (§10.2) exists specifically so a
  reference/demo Azure deployment doesn't accrue 24/7 compute cost between uses.
- **Availability**: no formal SLA — this is a single-organization internal tool, not a
  multi-tenant SaaS product; `canvas-api` runs scale-to-zero by default in the Azure reference
  deployment (a cold start after idle takes on the order of a minute).

## 14. Known Limitations & Technical Debt

Disclosed deliberately, not silently carried:

- **`templates` DB table is schema-only** — defined in migration `0001`, never populated
  by any seed script, no UI reads or writes it (the only code that touches it counts rows before
  a diagram type is deleted). The originally-specified FR-015 "start a new diagram from a template" feature was
  never built against it; the actual template-import capability that shipped
  (docs/c4-context-template.md-driven C4 Context import) is unrelated and does not use this table.
- **`/docs` and the contract can differ** — `/docs` shows FastAPI's generated document, while
  the authoritative shapes are the hand-kept `apps/api-py/contract/openapi.json`.
- **Federated credential sign-in (`OIDC_CLIENT_AUTH=managed-identity`) is not yet verified
  live** — the Azure reference deployment runs `AUTH_MODE=local`. The Entra sign-in flow itself
  was verified live against a real tenant (canvas-haz, 2026-10-17).
- **SQLite's `LIKE` is ASCII-only case-insensitive**, unlike Postgres's `ILIKE` (full Unicode
  case-folding) — a disclosed, accepted gap for non-ASCII search on the SQLite engine (see §12),
  not a silently divergent behavior.
- **The Playwright E2E suite only runs against Postgres** — a SQLite E2E leg was judged
  lower-priority (the Azure production target stays Postgres); the `unit-tests` matrix (§11) is
  the SQLite dialect's actual CI coverage.
- **Two diagram-core implementations** — the browser's TypeScript engine and the server's Python
  port must change together; the parity tests catch drift but not a change made to one side only
  when no test covers it.

## 15. Glossary

See `docs/business-requirements.md` §11 for product-level terms (DSL, Round-trip, Standard,
Persona, etc.). Additional technical terms used only in this document:

| Term                    | Meaning                                                                                                                                                                |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **diagram-core**        | The parser/renderer/validator engine: `packages/diagram-core` (TypeScript, browser) and its Python port `canvas_api/diagram_core` (server), held to identical output   |
| **DSL family**          | One of the six Mermaid grammar families (`flowchart`/`c4`/`sequence`/`erd`/`uml`/`architecture`) a `diagramTypeId` maps to; several diagram types can share one family |
| **`DiagramModel`**      | The in-memory, family-agnostic parsed representation of a diagram — the shared data shape every renderer, validator, and AI tool operates on                           |
| **RP-Initiated Logout** | The OIDC-standard mechanism (`end_session_endpoint`) for terminating an IdP's own SSO session on sign-out, not just the relying party's local session                  |
