# Canvas

A governed, web-based diagramming platform for enterprise architecture and technical
documentation. Business, Enterprise, Solution, and Technical Architects create and edit diagrams
visually, with **Mermaid DSL as the editable source of truth** and SVG/PNG as derived export
formats — edits to the DSL update the canvas, and canvas edits regenerate the DSL.

[![CI](https://github.com/muirjc/canvas/actions/workflows/ci.yml/badge.svg)](https://github.com/muirjc/canvas/actions/workflows/ci.yml)

## Features

- **Visual + DSL round-trip editing, with no gap between the two** — every construct each diagram
  family's Mermaid grammar can express (shapes/icons, connectors, containers/subgraphs/boundaries/
  namespaces, drag-to-nest, labels, styling, per-family relationship/cardinality/role pickers,
  activation/notes/control-flow blocks, click interactions, ...) has a matching point-and-click
  canvas affordance — edit either the canvas or the Mermaid source and the other stays in sync.
- **Six diagram families**, each with deep, near-complete Mermaid grammar coverage: **flowchart**
  (including business capability maps/value streams/application landscape variants), **sequence**,
  **UML class**, **entity-relationship (ER)**, **C4 model** (Context/Container/Component/Code/
  Deployment), and **architecture** (`architecture-beta` cloud/network topology) using official
  Azure and AWS icon sets.
- **AI-assisted diagramming** — admin-authored personas (with category and system prompt) generate
  a new diagram from a natural-language description, then keep refining it through a persistent
  in-editor chat that applies the same typed, family-aware operations the canvas UI uses (never
  raw, hand-emitted DSL) — pick an OpenAI/Anthropic provider or run fully offline against a
  deterministic mock.
- **Admin-governed standards** — admins define per-diagram-type standards (allowed/mandatory
  shapes, colors, fonts, icon sets); the platform validates diagrams against their assigned
  standard and flags deviations without blocking work.
- **Import** — paste or upload existing Mermaid DSL across all six supported diagram families and
  it becomes a fully editable diagram, with each family's parser accepting most of that family's
  real-world grammar (not just this app's own subset) — `%%` comments, `accTitle`/`accDescr`,
  `%%{init}%%` config blocks, and `click <id> href` node interactions are honored everywhere;
  classDef/style directives, generics, stereotypes, cardinality tokens, activation/control-flow
  blocks, and boundary/namespace/group nesting are each honored in the families that define them.
  A second import path — a fillable "intake template" document, currently for C4 Context — compiles
  structured, non-DSL input directly into a diagram.
- **Projects, sharing, and lifecycle** — organize diagrams into projects/folders, share with
  view/comment/edit permissions, version history, and soft-delete with admin restore.
- **SSO with enforced MFA** — Microsoft Entra ID OIDC login with App Role-based access, alongside a
  local email/password fallback for dev/demo use.
- **Export** — Mermaid DSL, SVG, and PNG.

## Tech stack

An npm-workspaces monorepo for the frontend and shared packages, plus a Python backend:

```text
apps/web/src/{canvas,palette,standards,admin,projects,app}   # React + Vite frontend (TypeScript)
apps/api-py/src/canvas_api/                                  # FastAPI backend (Python 3.13, uv)
packages/diagram-core/src/{model,dsl,standards,libraries}    # Mermaid parser/serializer/validator (TypeScript)
```

The browser runs `packages/diagram-core` as you edit. The backend runs a Python port of it
(`canvas_api/diagram_core/`) for import, save, validation, export and the AI tools; tests keep the
two identical. Diagrams persist to PostgreSQL (default) or SQLite through SQLAlchemy Core (a query
builder, not the ORM). The backend also serves the built web app in production. The TypeScript
backend (`apps/api`) was removed in November 2026; its last version is at tag `typescript-api-final`.

## Getting started

Requirements: Node.js 22 LTS and npm (for the web app) and [uv](https://docs.astral.sh/uv/) (it installs
Python 3.13 for you). No Docker or database server: local runs use SQLite by default. Works the same on
Linux, macOS and Windows.

```bash
git clone https://github.com/muirjc/canvas.git
cd canvas
npm install
npm run dev:local        # API on http://localhost:3000 + web app on http://localhost:5173; Ctrl-C stops both
```

The first run creates `apps/api-py/.env` from `.env.example`, builds `packages/diagram-core`, creates the SQLite
database (`apps/api-py/data/canvas.db`) and seeds demo data, printing the logins and a demo project id. Open
`http://localhost:5173` and sign in as `admin@example.com` / `admin-dev-password`. Later runs apply any new
migrations and start both. `API_PORT` / `WEB_PORT` pick other ports; `npm run dev:local -- --seed` adds missing
demo data again.

**PostgreSQL instead?** `docker compose up -d` (host port 5433) or any Postgres 16, then in `apps/api-py/.env`
switch to the commented Postgres lines and run `npm run dev:local -- --seed` once. See `RUNBOOK.md`'s
"Database engine" section for the SQLite vs. PostgreSQL trade-off (SQLite: one writer at a time).

Running the pieces by hand instead (two terminals):

```bash
npm run build --workspace=@canvas/diagram-core
cd apps/api-py && uv sync && cp .env.example .env
uv run --env-file .env python -m canvas_api.jobs.seed_demo                # migrates, seeds; prints logins
uv run --env-file .env uvicorn canvas_api.main:app --port 3000 --reload   # terminal 1
npm run dev --workspace=@canvas/web                                       # terminal 2, repository root
```

See **[RUNBOOK.md](RUNBOOK.md)** for day-to-day operational commands, troubleshooting, Entra ID
SSO setup, and environment variable reference, and `specs/*/quickstart.md` for a step-by-step
manual walkthrough of each feature (older ones cite the removed `apps/api` npm scripts).

## Deployment

**[infra/azure/README.md](infra/azure/README.md)** has a reproducible Bicep IaC deployment to
Azure — resource group, private VNet-integrated Postgres, Key Vault-backed secrets, and one
Container App that serves both the API and the web app, plus pause/resume/destroy lifecycle
scripts for cost control. An IP allow-list restricts it to your networks.

Two sign-in models:

- **Microsoft Entra ID** (default) — `ENTRA_CLIENT_ID=<app id> ./deploy.sh`.
- **Canvas-managed accounts** (no Entra tenant needed) — email + password plus an authenticator app
  (TOTP) for everyone, account lockout and an audit log:
  `CANVAS_AUTH_MODE=local CANVAS_ADMIN_EMAIL=<you> ./deploy.sh`. See
  [RUNBOOK.md → Local accounts](RUNBOOK.md#local-accounts-canvas-ez1-option-b).

## Documentation

- **[User guide](docs/user-guide/README.md)**: for everyone using Canvas (signing in, projects,
  creating and editing diagrams, AI chat, sharing, export).
- **[Admin guide](docs/admin-guide/README.md)**: for admins (users, standards, diagram types, AI and
  its cost, the audit log, recovery). Screenshots are regenerated with
  `npm run docs:screenshots --workspace=@canvas/web` against a local app with demo data.
- **[docs/business-requirements.md](docs/business-requirements.md)** — the business rationale,
  objectives, and requirements (the _why_).
- **[docs/solution-architecture-document.md](docs/solution-architecture-document.md)** — the
  technical architecture: stack, data model, security, AI integration, deployment (the _how_).
- **[docs/technology-stack.md](docs/technology-stack.md)** — the complete dependency manifest:
  every npm and Python package and its version, plus runtime/infra requirements.
- **API reference** — FastAPI's Swagger UI at `/docs` (JSON at `/openapi.json`) on the API server
  (opt-in; see `ENABLE_API_DOCS` in `RUNBOOK.md`). The frozen API contract is
  `apps/api-py/contract/openapi.json`.

## Testing

```bash
npm run build --workspace=@canvas/diagram-core   # required before web tests — see above
npm run test --workspace=@canvas/diagram-core     # parser/serializer/validator contract tests
(cd apps/api-py && uv run pytest)                 # API tests (Postgres: the canvas_test database, see RUNBOOK)
(cd apps/api-py && TEST_DB_CLIENT=sqlite uv run pytest)   # same suite against SQLite — no Postgres needed
npm run test:e2e --workspace=@canvas/web          # Playwright E2E (needs the API and web dev servers running)
```

`diagram-core`'s round-trip and standards-validation contract tests are non-negotiable — they
exist (and must fail before implementation) for every new diagram type or export path, per
`.specify/memory/constitution.md` Principle IV.

## CI

GitHub Actions (`.github/workflows/ci.yml`) runs on every push to `main` and every PR: lint +
build, a third-party licence check (see [License](#license)), the Python API suite (with ruff and
mypy) as a `db-client: [postgres, sqlite]` matrix, so both supported database engines are tested,
plus the TypeScript packages' tests, and the full Playwright
E2E suite (Postgres only — see `docs/solution-architecture-document.md` §14). `main` is protected
— changes land via PR once CI is green.

## Project layout and specs

Feature work is tracked under `specs/<number>-<slug>/` using the GitHub spec-kit workflow
(constitution → specify → clarify → plan → tasks → implement). Each feature directory has a
`spec.md`, `plan.md`, `tasks.md`, and `quickstart.md`. See `CLAUDE.md` for the full list of active
technologies and conventions.

## License

Canvas is licensed under the [Apache License 2.0](LICENSE). Third-party icon artwork bundled or
generated for the icon libraries (e.g. Microsoft Azure Architecture Icons) remains under its
owners' own terms — see each library manifest's `license` field.

[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) lists every production npm and Python package
Canvas ships, with its licence text, plus the icon artwork terms. It ships in the web build
(`/third-party-notices.txt`, `/license.txt`). After changing dependencies (npm or `uv`), run
`npm run licenses` and commit the regenerated file. CI's `npm run licenses:check` fails if the file
is out of date or if a dependency's licence isn't on the allow-list in
`scripts/third-party-notices.mjs` (MIT, ISC, Apache-2.0, BSD, 0BSD, BlueOak, MPL-2.0, ...); add a
reviewed exception there rather than loosening the list.
