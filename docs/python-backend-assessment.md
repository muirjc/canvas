# Moving the backend to Python: decision note

Status: decided 2026-10-29 (motivation, pace, end state); plan written 2026-10-31.
Tracking: canvas-lvlo (this note), and the epic created from it.

## Decision

The whole backend (`apps/api`, its jobs and the repository validator's server-side uses) moves from
TypeScript to Python, **incrementally**. The frontend stays React and TypeScript.

- **Why:** enterprise standards and the team's skills. This is a real move, not a preference, so
  "don't convert" is ruled out.
- **Pace:** gradual, route group by route group. The TypeScript and Python services run side by side
  against the **same database** during the move; no big-bang cut-over.
- **End state:** no TypeScript and no Node in the backend image.
- **Databases:** PostgreSQL stays the default and SQLite stays supported. The Python service runs
  its tests against both, like the TypeScript service does today.

## What moves

Measured 2026-10-31:

| | Size |
|---|---|
| `apps/api/src` | ~15,800 lines, 104 files, ~120 routes (Fastify) |
| `apps/api/tests` | ~19,500 lines, 91 test files (Vitest, against Postgres and SQLite in CI) |
| Migrations | 35 Postgres, 22 SQLite, plain SQL |
| Jobs | migrate, seed, seed-catalog, bootstrap-admin, purge, github-sync |
| `packages/diagram-core` | ~14,100 lines; used by the browser **and** 22 API files |

Library by library:

| Today (TypeScript) | Python |
|---|---|
| Fastify, @fastify/session, cookie, cors, static, swagger | FastAPI (OpenAPI built in), Starlette middleware |
| Kysely (query compiler, Postgres + SQLite) | SQLAlchemy Core 2 (not the ORM, keeping Principle VI's "query compiler, not ORM" line) |
| zod / Fastify JSON schemas | pydantic v2 |
| openid-client (Entra, nonce, signature checks) | Authlib |
| Vercel AI SDK (Anthropic, OpenAI, tool calling) | `anthropic` and `openai` SDKs directly, tool schemas from pydantic |
| @resvg/resvg-js (PNG export) | resvg-py |
| plain `fetch` GitHub client, App JWT on node:crypto | httpx, PyJWT |
| TOTP on node:crypto | standard library `hmac` |
| pino | structlog |
| @azure/monitor-opentelemetry | azure-monitor-opentelemetry (same Application Insights resource) |
| Vitest + `fastify.inject` | pytest + httpx `AsyncClient` against the ASGI app |

Tooling: Python 3.13, `uv` for dependencies and the lock file, `ruff` (lint and format), `mypy
--strict`, `pytest`.

## The hard part: diagram-core

The browser and the server today run the **same** TypeScript parser, serializer, validator and
renderer, so the canvas and an export can't disagree. The browser must keep TypeScript, so the server
side of diagram-core needs a Python implementation in the end.

What the API actually uses (import inventory, 2026-10-31): parsing and family detection on every save
(`getDslFamily`, `detectDslFamily`, `isParseSuccess`); standards validation (`validate`,
`checkStandardDefinition`, `RULE_IDS`); SVG rendering (`renderToSvg`, PNG on top); portable Mermaid
and document embeds for GitHub (`toPortableMermaid`, `updateEmbeds`); icon libraries and SVG
sanitising (`loadLibrary`, `searchIcons`, `prepareUploadedSvg`, `sanitizeIconMarkupStrict`);
templates (`getTemplateCompiler`); and the AI tools, whose every change is a diagram-core model
operation. The interactive-only parts (canvas layout helpers, hit-testing, zoom) never need porting.

The approach, in two steps:

1. **Transition: a bridge.** Python calls the TypeScript diagram-core through a small Node sidecar
   (HTTP/JSON: parse, serialize, validate, render, portable Mermaid, model operations), built from the
   same esbuild bundle the repository validator already uses. This lets routes move to Python before
   any porting.
2. **End state: a Python port, held to the TypeScript one by a shared test corpus.** A
   language-neutral **golden corpus** (DSL in; parsed model JSON, re-serialized DSL, standard
   violations, SVG, portable Mermaid out, as files) is generated from the TypeScript implementation
   and checked by both. The Python port replaces the bridge one diagram family at a time (flowchart
   first, since most diagram types use it), and only once that family passes the corpus. SVG is
   compared as normalised XML. Every later diagram-core change adds corpus cases, so the two
   implementations can't drift. "Same tested contract" replaces today's "same code".

The constitution gets an amendment for this: diagram-core has a TypeScript (browser) and a Python
(server) implementation, held equal by the corpus, and Principle IV (test-first for rendering and
export) applies to both. Principle VI's Kysely example becomes SQLAlchemy Core.

## How the two services share the work

- **One front door.** Browsers keep talking to one origin (since canvas-r3y the API also serves the
  web app). At first the TypeScript service stays the front door and forwards migrated route prefixes
  to the Python service, which runs as a second, internal-only container in the same Container Apps
  environment. Once more than half the routes have moved, swap: Python becomes the front door and
  forwards what's left to TypeScript. The web app's API address never changes.
- **Shared sign-in.** Sessions already live in the database (`DbSessionStore`, cookie `cid`). The
  Python service reads the same session rows and checks the cookie's signature with the same secret,
  so a user signed in through either service is signed in to both. Proving this is the first spike.
- **One set of migrations.** The existing plain-SQL migration files stay the single source, run by
  one runner (the TypeScript one, until the migrate job moves to Python). No Alembic until TypeScript
  is gone.
- **Same API shapes.** Each route group's request and response schemas are written on the TypeScript
  routes as the group moves (canvas-62y, done group by group rather than all ~128 routes up front) and
  snapshotted to `apps/api/contract/openapi.json`. CI fails when a moved route's shape changes without
  the snapshot, and the Python tests check every response against it.
- **Forwarding by route, not prefix** (phase 2). The front door matches the route Fastify resolved
  (`PATCH /projects/:id`) against the moved list in `apps/api/src/python/route-groups.ts`, since one
  prefix holds routes from several phases (`/projects/:id` moves in phase 2, `/projects/:id/members`
  in phase 3). The TypeScript routes stay registered; `PYTHON_ROUTE_GROUPS` sends a group back to
  them without a deploy of new code.
- **Same telemetry.** The Python service reports to the same Application Insights resource with the
  same route names, so the performance workbook and alert keep working across the move.

## Phases

Each phase is a child bead of the epic. Within a route group: port its contract tests to pytest first
(the cases transfer, the code doesn't), switch the front door to Python, keep the TypeScript route for
one release as a fallback, then delete it. The Playwright end-to-end suite is black-box over HTTP and
the UI, stays unchanged, and is the acceptance gate throughout.

| Phase | What | Gate |
|---|---|---|
| 0a | API contract: request/response schemas (canvas-62y) and an OpenAPI snapshot, written per route group as it moves | Snapshot diff in CI |
| 0b | Python service skeleton: FastAPI, SQLAlchemy Core (Postgres + SQLite), pydantic, uv, ruff, mypy, pytest, OpenTelemetry; CI jobs for both databases; Docker image | `/health` from Python in the container |
| 0c | Shared sign-in spike: read `cid` sessions and verify the signature in Python | A user signed in via TypeScript calls a Python route |
| 0d | Front door: TypeScript forwards a route prefix to the internal Python container (local compose and Azure) | One read-only route served by Python in Azure |
| 1a | diagram-core bridge: Node sidecar over the esbuild bundle; latency per save and export measured | Save and export through the bridge within the performance budget |
| 1b | Golden corpus generated from TypeScript, checked in CI | Corpus green on TypeScript |
| 2 | Simple reads and CRUD: projects, diagram types, libraries list, settings | Contract tests in pytest, e2e green |
| 3 | Comments, sharing and members, audit, admin users | as above |
| 4 | Diagrams: save, versions, presence, drafts, import, templates (via the bridge) | as above |
| 5 | Standards and kinds (via the bridge) | as above |
| 6 | Export SVG and PNG (bridge + resvg-py) | as above |
| 7 | GitHub App: link, submit, status sync, document embeds; github-sync job | as above, against the fake GitHub |
| 8 | AI chat and tools (Anthropic/OpenAI SDKs) | as above, mock provider |
| 9 | Auth last: local accounts, TOTP, Entra OIDC; re-prove canvas-haz's 15 security contract cases in pytest | All 15 cases fail when the hardening is removed, as today |
| 10 | Swap the front door to Python (can happen any time after about phase 5) | |
| 11 | Port diagram-core's server side to Python family by family against the corpus; retire the sidecar | Corpus green on Python for every family |
| 12 | Jobs (migrate, seed, purge, bootstrap-admin), Dockerfile, CI, infra, RUNBOOK/README/CLAUDE.md, licence notices (pip packages too); delete `apps/api` TypeScript | No TypeScript or Node in the backend image |

New backend features from now on are built in Python once phase 0 is done: notifications (canvas-q9v,
canvas-2h2w.4), Entra groups (canvas-2h2w.3), server-side search (canvas-g8i), AI layout tools
(canvas-p2g8.2) and real-time co-editing (canvas-vvi). Small fixes to existing TypeScript routes stay
in TypeScript until their group moves.

## Risks

| Risk | Mitigation |
|---|---|
| Two diagram-core implementations drift | The golden corpus, run by both CI jobs; a diagram-core change isn't done until its corpus cases are added |
| Auth regressions | Auth moves last; canvas-haz's 15 signature/nonce/issuer cases are ported and shown to fail without the hardening |
| Response shapes change and break the web app | OpenAPI snapshot diff in CI; the e2e suite unchanged |
| The bridge adds latency to save/export | Measured in phase 1a against the telemetry baseline (canvas-i3n); the port in phase 11 removes it |
| Two runtimes in production for a while | Accepted for the transition; the sidecar is internal-only and goes away in phase 11 |
| A long migration stalls half way | Every phase leaves a working, deployed system; nothing depends on finishing quickly |
| Cold start of a second container | Python is internal and scales with the front door; measure in phase 0d (scale-to-zero stays, canvas-aots) |

## Open questions

None block phase 0. Decided during the phases themselves:
- Sidecar shape (a second container vs a process in the Python container) in phase 1a, from latency
  numbers.
- The exact point to swap the front door (phase 10).
