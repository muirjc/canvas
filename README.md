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
- **SSO with enforced MFA** — Keycloak-backed OIDC login with realm-role-based access, alongside a
  local email/password fallback for dev/demo use.
- **Export** — Mermaid DSL, SVG, and PNG.

## Tech stack

TypeScript end-to-end, as an npm-workspaces monorepo:

```text
apps/web/src/{canvas,palette,standards,admin,projects,app}   # React + Vite frontend
apps/api/src/{diagrams,standards,libraries,projects,sharing,admin,export,auth}  # Fastify backend
packages/diagram-core/src/{model,dsl,standards,libraries}    # shared Mermaid parser/serializer/validator
```

`diagram-core` is used identically by both the frontend (validating/rendering as you edit) and the
backend (parsing on import/save) — see `specs/001-diagramming-platform/plan.md`. Diagrams persist
to PostgreSQL; icon/shape library assets live in a blob store.

## Getting started

Requirements: Node.js 22 LTS, Docker (for PostgreSQL), npm.

```bash
git clone https://github.com/muirjc/canvas.git
cd canvas
npm install

# Start PostgreSQL (host port 5433, to avoid colliding with a local Postgres on 5432)
docker compose up -d

# Build the shared package first — apps/api and apps/web resolve it via its built dist/ output
npm run build --workspace=@canvas/diagram-core

cp apps/api/.env.example apps/api/.env
# then edit apps/api/.env: set ALLOW_LOCAL_AUTH=true for local dev/demo login

npm run migrate --workspace=@canvas/api
npm run seed --workspace=@canvas/api    # prints the seeded admin login + a demo project id

npm run dev --workspace=@canvas/api     # http://localhost:3000
npm run dev --workspace=@canvas/web     # http://localhost:5173
```

Then open `http://localhost:5173/?projectId=<the id printed by seed>` and sign in with the printed
admin credentials.

See **[RUNBOOK.md](RUNBOOK.md)** for day-to-day operational commands, troubleshooting, Keycloak
SSO setup, and environment variable reference, and `specs/*/quickstart.md` for a step-by-step
manual walkthrough of each feature.

## Deployment

**[infra/azure/README.md](infra/azure/README.md)** has a reproducible Bicep IaC deployment to
Azure — resource group, private VNet-integrated Postgres, Key Vault-backed secrets, Container Apps
(API + Keycloak), and a Storage static site for the frontend, plus pause/resume/destroy lifecycle
scripts for cost control.

## Documentation

- **[docs/business-requirements.md](docs/business-requirements.md)** — the business rationale,
  objectives, and requirements (the *why*).
- **[docs/solution-architecture-document.md](docs/solution-architecture-document.md)** — the
  technical architecture: stack, data model, security, AI integration, deployment (the *how*).
- **[docs/technology-stack.md](docs/technology-stack.md)** — the complete dependency manifest:
  every package and pinned version across all four workspaces, plus runtime/infra requirements.
- **API reference** — a live OpenAPI/Swagger UI at `/docs` on the API server (opt-in; see
  `RUNBOOK.md`'s environment variable table for `ENABLE_API_DOCS`).

## Testing

```bash
npm run build --workspace=@canvas/diagram-core   # required before api/web tests — see above
npm run test --workspace=@canvas/diagram-core     # parser/serializer/validator contract tests
npm run test --workspace=@canvas/api              # API contract tests (needs Postgres running)
npm run test:e2e --workspace=@canvas/web          # Playwright E2E (needs api + web dev servers running)
```

`diagram-core`'s round-trip and standards-validation contract tests are non-negotiable — they
exist (and must fail before implementation) for every new diagram type or export path, per
`.specify/memory/constitution.md` Principle IV.

## CI

GitHub Actions (`.github/workflows/ci.yml`) runs on every push to `main` and every PR: lint +
build, the `diagram-core`/`api` test suites against a Postgres service container, and the full
Playwright E2E suite. `main` is protected — changes land via PR once CI is green.

## Project layout and specs

Feature work is tracked under `specs/<number>-<slug>/` using the GitHub spec-kit workflow
(constitution → specify → clarify → plan → tasks → implement). Each feature directory has a
`spec.md`, `plan.md`, `tasks.md`, and `quickstart.md`. See `CLAUDE.md` for the full list of active
technologies and conventions.
