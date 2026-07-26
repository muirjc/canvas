# Canvas

A governed, web-based diagramming platform for enterprise architecture and technical
documentation. Business, Enterprise, Solution, and Technical Architects create and edit diagrams
visually, with **Mermaid DSL as the editable source of truth** and SVG/PNG as derived export
formats — edits to the DSL update the canvas, and canvas edits regenerate the DSL.

[![CI](https://github.com/muirjc/canvas/actions/workflows/ci.yml/badge.svg)](https://github.com/muirjc/canvas/actions/workflows/ci.yml)

## Features

- **Visual + DSL round-trip editing** — shapes, connectors, containers/subgraphs, labels; edit
  either the canvas or the Mermaid source and the other stays in sync.
- **Diagram types**: C4 model (Context/Container/Component/Code), business capability maps and
  value streams, application landscape/roadmap diagrams, solution/sequence diagrams, and
  network/deployment/cloud-infrastructure diagrams using official Azure and AWS icon sets
  alongside generic flowchart, ERD, and UML shapes.
- **Admin-governed standards** — admins define per-diagram-type standards (allowed/mandatory
  shapes, colors, fonts, icon sets); the platform validates diagrams against their assigned
  standard and flags deviations without blocking work.
- **Import** — paste or upload existing Mermaid DSL across all six supported diagram families and
  it becomes a fully editable diagram. `%%` comments are honored everywhere; each family also
  handles its own common real-world syntax — flowchart (`graph` header alias, `style` directives,
  inline shape-in-edge declarations), ER (attribute blocks with `PK`/`FK`/`UK`), sequence (notes
  and nestable `loop`/`alt`/`opt`/`par`/`critical`/`break` blocks), and architecture (directional
  `-->`/`<--` connectors).
- **Projects, sharing, and lifecycle** — organize diagrams into projects/folders, share with
  view/comment/edit permissions, version history, and soft-delete with admin restore.
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

See **[RUNBOOK.md](RUNBOOK.md)** for day-to-day operational commands, troubleshooting, and
environment variable reference, and `specs/*/quickstart.md` for a step-by-step manual walkthrough
of each feature.

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
