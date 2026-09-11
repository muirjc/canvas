# Solution Architecture Document: Canvas

| | |
|---|---|
| **Document status** | Draft |
| **Version** | 1.0 |
| **Date** | 2026-09-11 |
| **Owner** | Engineering |
| **Companion document** | `docs/business-requirements.md` — the *why*; this document is the *how*. Where the two disagree on a technical detail, this document and the code it describes are authoritative. |
| **Source material** | `specs/001-diagramming-platform/plan.md` and subsequent feature plans, `.specify/memory/constitution.md`, `infra/azure/`, `apps/*/package.json`, `apps/api/migrations/`, live code inspection. |

## 1. Purpose & Scope

This document describes Canvas's technical architecture: how the system is structured, the
technology choices behind it and why, how data flows through it, and how it is deployed and
secured. It covers the platform as delivered through `specs/001` – `011` plus the substantial body
of post-spec-kit hardening and completeness work tracked in `CLAUDE.md`'s Recent Changes log and
the project's `bd` issue tracker (Azure deployment, Keycloak SSO with enforced MFA, the DSL
full-compliance and canvas-UI-completeness epics, C4 template import, and self-hosted API
documentation).

## 2. Architecture Overview

Canvas is a three-tier web application built as a single TypeScript npm-workspaces monorepo, with
one architecturally significant twist: the diagram parsing/rendering/validation engine
(`packages/diagram-core`) is a **shared kernel** consumed identically by both the browser and the
server — not a client library and a separately-maintained server implementation that could drift
apart.

```text
┌─────────────────────────┐        ┌──────────────────────────┐
│   apps/web (React SPA)  │◄──────►│   apps/api (Fastify)      │
│   - interactive canvas  │  REST  │   - auth (local + OIDC)   │
│   - DSL panel, chat,    │  /docs │   - diagrams/projects/    │
│     admin console       │ OpenAPI│     sharing/standards     │
└───────────┬──────────────┘        │   - AI chat tool-calling  │
            │  imports (built dist) │   - export (SVG/PNG)      │
            ▼                       └─────────────┬─────────────┘
┌─────────────────────────────────────────────────┼─────────────┐
│        packages/diagram-core (shared kernel)     │             │
│  DSL parsers/serializers × 6 families · standards│validator ·  │
│  SVG renderer · pure model-mutation ops (diagram-ops.ts)       │
└───────────────────────────────────────────────────────────────┘
                                                    ▼
                                    ┌───────────────────────────┐
                                    │ PostgreSQL (diagrams, users,│
                                    │ projects, standards, icons, │
                                    │ AI personas/chat history)    │
                                    └───────────────────────────┘
                          ┌───────────────────────────┐
                          │ Keycloak (OIDC IdP, MFA)   │  (optional; local-auth
                          └───────────────────────────┘   fallback always available)
                          ┌───────────────────────────┐
                          │ Anthropic / OpenAI (AI chat)│  (optional; mock provider
                          └───────────────────────────┘   for offline/dev/CI use)
```

## 3. Technology Stack

| Layer | Technology | Version (as pinned) | Notes |
|---|---|---|---|
| Language | TypeScript | ^5.7 | End-to-end — frontend, backend, and shared package all TypeScript, one `tsconfig.base.json` |
| Frontend | React | ^18.3 | No framework (no Next.js/Remix) — a plain Vite SPA |
| Frontend build | Vite | ^6.0 | Dev server + production bundling |
| Backend | Fastify | ^5.1 | Chosen over Express for its plugin architecture and native TypeScript-friendly typing |
| Backend runtime | Node.js | 22 LTS | Per `README.md`'s stated requirement |
| Database | PostgreSQL | 16 (Alpine locally, Azure Flexible Server in the cloud) | Single relational store — no separate document/cache store |
| Database driver | `pg` | ^8.13 | Raw SQL via a connection pool (`apps/api/src/db/pool.ts`) — no ORM |
| Auth (OIDC) | `openid-client` | ^6.1 | PKCE authorization-code flow against Keycloak (or any OIDC-compliant IdP) |
| Identity Provider | Keycloak | 26.2 | Self-hosted, realm-imported from version-controlled JSON (`infra/keycloak/CanvasRealm-realm.json`); enforces TOTP MFA on every SSO login |
| AI SDK | Vercel AI SDK (`ai`, `@ai-sdk/anthropic`, `@ai-sdk/openai`) | ^7.0 | Provider-swappable tool-calling; a fourth "mock" provider gives deterministic offline/CI behavior |
| Auto-layout | `@dagrejs/dagre` | ^3.1 | DAG ranking/positioning for the flowchart-family "Auto Layout" toolbar action |
| PNG export | `@resvg/resvg-js` | ^2.6 | Server-side SVG→PNG rasterization, no headless browser needed |
| API docs | `@fastify/swagger` + `@fastify/swagger-ui` | ^9.8 / ^6.1 | OpenAPI 3 document generated from live route registration; served at `/docs`, opt-in via `ENABLE_API_DOCS` |
| Session validation | `zod` | ^4.4 | Request/response and AI-tool-argument schema validation |
| Testing | Vitest (unit/contract), Playwright + axe-core (E2E/accessibility) | — | See §11 |
| IaC | Bicep | — | Azure deployment (`infra/azure/`) |

## 4. System Architecture

### 4.1 Monorepo layout

```text
apps/web/src/{canvas,palette,standards,admin,projects,ai,app,ui,styles}   # frontend
apps/api/src/{diagrams,standards,libraries,projects,sharing,admin,        # backend
              export,auth,ai,docs,db,seed,purge}
packages/diagram-core/src/{model,dsl,standards,libraries,render,template} # shared kernel
```

- **`packages/diagram-core`** has no dependency on either `apps/web` or `apps/api` — a genuinely
  standalone package (`@dagrejs/dagre` and `yaml` are its only runtime dependencies) built to a
  `dist/` output that both consumer workspaces resolve via an npm workspace symlink. It owns:
  parsing and serializing all six DSL families, the standards validator, the SVG export renderer,
  pure `DiagramModel`-mutation operations (`diagram-ops.ts`) shared by the canvas UI *and* the AI
  tool layer, and (as of the C4 Context template-import feature) a generic Markdown-intake-form
  parser plus per-diagram-type template compilers.
- **`apps/web`** is a client-rendered SPA with no server-side rendering. It holds the
  `DiagramModel` for the currently-open diagram in React state; the canvas (`Canvas.tsx`), the DSL
  text panel, and the AI chat panel all read/write the same model object, kept in sync via
  `diagram-core`'s parse/serialize functions (`useDslSync.ts`).
- **`apps/api`** is a Fastify server exposing a REST API (47 routes as of this document, see §7)
  plus three narrow non-JSON concerns: an OIDC callback redirect, a reverse proxy to an
  internal-only Keycloak (`/idp/*`, Azure only), and binary SVG/PNG export downloads.

### 4.2 The shared-kernel decision

This is the single most consequential architectural choice in the codebase, stated as
Constitution Principle I ("Diagram-as-Data") and enforced by having only one parser/renderer
implementation, not two independently-hand-copied ones. Concretely:

- The canvas (interactive, DOM/SVG via React) and the export renderer (server-side, pure string
  generation) both call the exact same geometry-computation functions from
  `packages/diagram-core/src/render/svg-renderer.ts` (e.g. `nodeSize`, `clipEdgeEndpoint`,
  `splitLabelLines`, `iconNodeLayout`, `tableNodeLayout`, `computeSequenceLayout`) — this is
  referred to throughout the codebase's own comments as "SC-004" (canvas and export must never
  disagree). A handful of geometry helpers are necessarily re-implemented in
  `apps/web/src/canvas/shapes.tsx` (JSX vs. string-template output), but each one explicitly
  imports and reuses the diagram-core calculation itself, not a hand-copied duplicate of the
  arithmetic, wherever that's possible.
- The AI chat tool-calling layer (`apps/api/src/ai/diagram-tools.ts`) mutates diagrams through the
  identical `diagram-ops.ts` pure functions the canvas UI's own click/drag handlers call — an
  AI-driven edit and a manual edit produce indistinguishable model states, and both go through the
  same standards-validation path on save (no AI-specific bypass).

## 5. Data Architecture

PostgreSQL is the sole persistent store (no cache/document store). Sixteen tables, delivered
incrementally across ten migrations:

| Table | Purpose |
|---|---|
| `users`, `local_credentials` | Accounts; local password auth is a separate table from the user record itself (an OIDC-only user has no row here) |
| `projects` | Folder/organization hierarchy for diagrams; soft-delete with restore |
| `diagrams`, `diagram_versions` | The diagrams themselves (current `dslContent` + validation result) and their capped, searchable version history |
| `diagram_types` | The catalog of 15 seeded diagram types (§6), each tagged with persona(s), abstraction level, and `dslFamily` |
| `standards` | Admin-defined, versioned, named/described/retirable governance rules per diagram type |
| `icon_libraries`, `icons` | Versioned icon/shape library metadata (Azure, AWS, C4 notation, generic) |
| `share_grants` | Polymorphic (`subject_type` diagram\|project) view/comment/edit access grants |
| `ai_personas`, `ai_persona_reference_material`, `ai_settings` | Admin-authored AI personas, their optional scoped reference material, and provider/enablement settings |
| `diagram_chats`, `chat_messages` | Persistent per-diagram AI chat history |
| `templates` | **Schema only, unimplemented** — see §14 |

Every table with a "soft delete" concept (`diagrams`, `projects`) follows the identical
`deleted_at`/`deleted_by_user_id`/`restored_at`/`restored_by_user_id` shape, with a
`DIAGRAM_RETENTION_DAYS`/`PROJECT_RETENTION_DAYS` (30-day) window and an ops-run physical-purge
script (`apps/api/src/purge/run.ts`) rather than an in-app scheduler — a deliberate
proportionality decision (Constitution Principle VI): the visible "gone after 30 days" behavior
was already fully achieved by the query-exclusion alone, so a scheduler was deferred until the
physical-deletion step was actually needed.

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

| Family | Real Mermaid header | Diagram types built on it |
|---|---|---|
| `flowchart` | `flowchart`/`graph` | Generic flowchart, business capability map, value stream, application/enterprise landscape, roadmap, solution architecture |
| `c4` | `C4Context`/`C4Container`/`C4Component`/`C4Dynamic`/`C4Deployment` | C4 Context, Container, Component, Code (repurposes `C4Dynamic`), Deployment |
| `sequence` | `sequenceDiagram` | Sequence Diagram |
| `erd` | `erDiagram` | Entity-Relationship Diagram |
| `uml` | `classDiagram` | UML Class Diagram |
| `architecture` | `architecture-beta` | Network, Deployment, Cloud Infrastructure Diagram |

Every parser is validated against a **round-trip contract**: `parse(serialize(model)) ≈ model`
and `serialize(parse(dsl)) ≈ dsl` (semantically, not necessarily byte-identical — e.g. chained
edges canonicalize to separate lines on output). These contract tests are Constitution Principle
IV's "non-negotiable, written and failing before implementation" requirement, and are the largest
single body of test code in the repository (packages/diagram-core has ~10,300 lines of test code
against ~10,200 lines of source, a roughly 1:1 ratio).

## 7. API Architecture

A conventional REST API (no GraphQL), one route-registration module per resource domain
(`apps/api/src/<domain>/*.routes.ts`), all mounted in `app.ts`. As of this document: **47 routes**
across 16 domains (auth, diagrams, diagram-types, import, import-template, sharing, admin,
user-lookup, export, standards, libraries, projects, ai-settings, personas,
persona-reference-material, diagram-chat).

- **Self-documenting**: `@fastify/swagger` + `@fastify/swagger-ui` generate and serve a live
  OpenAPI 3 document at `/docs` (JSON at `/docs/json`), gated behind `ENABLE_API_DOCS` (opt-in,
  same posture as local-auth — see §8). Route-level request/response schema annotation (for full
  parameter/body documentation, not just the path+method list Fastify's own introspection already
  provides for free) is tracked as follow-up work (`canvas-lfc`).
- **Auth**: cookie-based server sessions (`@fastify/session`), not JWT-bearer — see §8.
- **Errors**: a single `setErrorHandler` normalizes every thrown error to `{error: string}` (plus
  a `details` array for structured validation failures), with the real error only logged
  server-side for a 500.
- **Validation posture**: most routes hand-validate their body/params imperatively (a manual
  `if (!field) reply.code(400)...` check) rather than declarative Fastify JSON-schema validation —
  a real, disclosed inconsistency (some newer routes, and the AI tool layer, use `zod`) rather
  than a deliberate uniform choice.

## 8. Security Architecture

- **Authentication**: two coexisting mechanisms, both producing the same server-side session
  shape (`request.session.user`):
  - **Local email/password** (`ALLOW_LOCAL_AUTH`) — for local dev/demo; hashed credentials in a
    separate `local_credentials` table.
  - **OIDC via Keycloak** (PKCE authorization-code flow) — the primary mechanism for a real
    deployment. Keycloak realm policy **forces TOTP (MFA) enrollment** on every user's first
    login; there is no way to complete SSO login without it (realm policy, not app code). Realm
    roles (`admin`/`architect`/`viewer`) are re-read and re-synced into the local `users.role` on
    every login — Keycloak is the source of truth once a user has signed in via SSO once.
  - **Sign-out** performs a real RP-Initiated (OIDC) logout when the session came from SSO
    (`canvas-252`): the local session is destroyed *and* the browser is navigated to Keycloak's
    own `end_session_endpoint`, so Keycloak's SSO cookie is actually cleared — a local-auth
    session gets a plain, fast local-only sign-out with no Keycloak round-trip.
- **Authorization**: three roles (`admin`/`architect`/`viewer`), plus fine-grained per-resource
  `share_grants` (view/comment/edit) at both the project and individual-diagram level, resolved by
  `resolveDiagramAccess`/`requireProjectAccess` middleware. No multi-tenancy — single-organization
  deployment (Constitution's own stated scope boundary).
- **Session cookie posture**: configurable `SameSite`/`Secure` (`COOKIE_SAME_SITE`/
  `COOKIE_SECURE`) because the platform is deliberately **split-origin capable** (a
  separately-hosted static frontend calling a separately-hosted API, as on Azure) — same-origin
  local dev needs neither; a split-origin deployment needs `SameSite=None`+`Secure` together
  (browsers reject the former without the latter). `trustProxy: true` on the Fastify instance lets
  a TLS-terminating reverse proxy (Azure App Service/Container Apps) still result in a
  correctly-Secure-flagged cookie.
- **CORS**: explicit origin allowlist (`WEB_ORIGINS`) with credentials — reflecting `origin: true`
  combined with `credentials: true` would let any website ride a signed-in user's cookie.
- **XSS**: flowchart `click <id> href` interactions were the one place user-authored content
  becomes a real link/attribute in exported SVG — hardened via delegating scheme validation to the
  platform's own `URL` parser (not a hand-rolled regex, which had a real, found-and-fixed
  whitespace-obfuscation bypass) and rejecting any href/tooltip containing a quote or newline
  (the DSL's own click-href grammar has no escape syntax, so rejection — not escaping — is the
  only sound option). Reviewed by a dedicated appsec pass before merge, per that feature's own
  explicit requirement given the disclosed risk class.
- **Secrets**: Azure deployment sources every secret (Postgres password, session secret, Keycloak
  admin password, OIDC client secret, AI provider API keys) from Key Vault via managed-identity
  secret references — never baked into a container image or Bicep parameter file.

## 9. AI Integration Architecture

Admin-authored **personas** (name, category, system prompt, optional scoped reference material)
drive a persistent, per-diagram chat panel. Two structural guarantees, both enforced in code, not
just convention:

1. **The model never emits raw DSL.** Every AI-driven change goes through the same typed,
   family-conditional tool set (`createDiagramTools(context, family)`) the canvas UI's own pure
   `diagram-ops.ts` functions back — an out-of-family request (e.g. asking a sequence-diagram chat
   to set a UML relationship kind) has no tool call available to make at all, not a refusal
   string layered on top of a tool that exists anyway.
2. **No AI-specific validation bypass.** A tool-driven mutation goes through the identical
   `computeValidation` standards check a manual edit already goes through.

Providers are pluggable via the Vercel AI SDK (`AI_PROVIDER=anthropic|openai|mock`) — the `mock`
provider gives fully deterministic, offline-capable behavior for e2e tests and CI, at the cost of
those specs asserting mock-specific response text/colors (a disclosed, intentional trade-off, not
a gap — real-provider validation is a separate manual/spot-check activity).

## 10. Deployment Architecture

### 10.1 Local development

`docker compose up -d` (Postgres only by default; `--profile sso` opts into a local Keycloak with
a version-controlled realm import) + `npm run dev` per workspace. See `RUNBOOK.md`.

### 10.2 Azure (production-shaped reference deployment)

Reproducible Bicep IaC under `infra/azure/`, one resource group (`canvas-rg`):

- **Network**: a VNet with a delegated subnet each for Postgres and the Container Apps
  environment (private, not publicly addressable).
- **Data**: Postgres Flexible Server (private endpoint only) + a Key Vault (RBAC-authorized,
  purge-protection off by design so `destroy.sh` can fully clean up) + a Storage account (static
  website hosting for the built frontend).
- **Compute**: a Container Apps environment hosting two apps — `canvas-api` (public ingress,
  scale-to-zero eligible) and `canvas-keycloak` (**internal-ingress only**, reached exclusively
  through `canvas-api`'s own `/idp/*` reverse proxy, since a browser can never reach an
  internal-only Container App directly) — plus four manually-triggered jobs: `canvas-migrate`,
  `canvas-seed`, `canvas-keycloak-users` (real user provisioning via the Keycloak admin REST API),
  and the purge script's own future job slot.
- **Container Registry**: images tagged with the deploying git commit's short SHA (never a
  floating `:latest` — Container Apps' own revision-diffing treats a reused tag string as a no-op
  even when the underlying digest changed, a real gotcha this project hit and documented).
- **Bootstrap ordering quirk (disclosed, not a bug)**: `deploy.sh` needs **two passes** on a
  genuine from-scratch deployment — pass one creates Key Vault itself (so the API/Keycloak
  container apps' own secret references necessarily fail, since nothing exists in the vault yet);
  pass two seeds the secrets and everything comes up clean. Re-running the same script is always
  safe (cached local secrets, idempotent Keycloak client reconciliation via its admin REST API).
- **Cost-control lifecycle**: `pause.sh` stops Postgres compute and drops both Container Apps to
  scale-to-zero-eligible (keeping all data); `resume.sh` reverses it; `destroy.sh` is the full,
  irreversible teardown (resource group deletion + Key Vault purge), with local cached secrets
  deliberately preserved so a later rebuild reuses the same credentials.

## 11. Testing Strategy

Four layers, enforced by Constitution Principle IV for the first two:

1. **Contract tests** (`packages/diagram-core/tests/contract/`) — parse/serialize round-trip
   fidelity per DSL family, standards validation, SVG-render output shape. Written and failing
   *before* the implementation they cover, not after.
2. **Unit tests** — pure function coverage (`diagram-ops.ts`, config loading, auth helpers) across
   all three workspaces.
3. **API contract tests** (`apps/api/tests/contract/`) — real HTTP request/response assertions
   against a real (test-isolated `canvas_test`) Postgres database, `NODE_ENV=test` hard-overriding
   `DATABASE_URL` so an ambient dev-database env var can never leak into a test run and get
   truncated.
4. **End-to-end** (`apps/web/tests/e2e/`, Playwright + axe-core) — drives the real running app in
   a real browser, including a dedicated SSO spec that completes a real Keycloak TOTP enrollment
   (reads the live enrollment page's TOTP secret, computes a real code with `otplib`) rather than
   mocking the IdP.

CI (`.github/workflows/ci.yml`) runs `lint-and-build` → `unit-tests` → `e2e-tests` on every PR;
`main` is branch-protected requiring all three green and the PR branch up to date.

## 12. Key Architectural Decisions

| Decision | Rationale / trade-off |
|---|---|
| Mermaid DSL as sole source of truth, SVG/PNG purely derived | The only way three export formats stay mutually consistent — the alternative (rendered output as truth) makes diffing/templating/programmatic validation impossible (Constitution Principle I) |
| One shared `diagram-core` package, not a client lib + server lib | Eliminates an entire class of "canvas and export silently disagree" bugs by construction, at the cost of a stricter dependency boundary (diagram-core cannot depend on browser or Node-only APIs) |
| Standards enforcement is soft-flag, never blocking | Preserves architect autonomy while still making violations visible and auditable — a deliberate governance-vs-friction trade-off, not an oversight |
| Sequence-diagram geometry is fully computed, never stored | `canvas.positions` front-matter round-trip is intentionally dropped for this one family — declaration/message *order* is the real DSL content; storing now-ignored positions would be a worse trap than omitting them |
| Single-organization deployment, no multi-tenancy | Explicitly out of scope (BRD §5.2) — every admin-defined standard/library is global, simplifying the data model considerably |
| No ORM; raw SQL via `pg` | Sixteen tables, mostly straightforward CRUD plus a few polymorphic/recursive queries (project trees, access resolution) — judged not to need an ORM's abstraction cost |
| AI tool-calling constrained to typed operations, never raw DSL | The same trust boundary a manual edit already has (standards validation, family-appropriate vocabulary) applies uniformly, with no AI-specific bypass path to audit separately |

## 13. Non-Functional Requirements / Quality Attributes

- **Performance**: SC-007 (BRD) — save/load/search stay perceptibly instant at ≥1,000 diagrams per
  project; validated via `apps/api/tests/performance/search.perf.test.ts` (opt-in, excluded from
  CI due to shared-runner timing variance).
- **Accessibility**: WCAG 2.1 AA for keyboard navigation and color contrast (Constitution
  Technology & Compliance Constraints), verified via `@axe-core/playwright` in the E2E suite.
- **Cost control**: the pause/resume/destroy lifecycle (§10.2) exists specifically so a
  reference/demo Azure deployment doesn't accrue 24/7 compute cost between uses.
- **Availability**: no formal SLA — this is a single-organization internal tool, not a
  multi-tenant SaaS product; `canvas-api` runs scale-to-zero by default in the Azure reference
  deployment (a cold start after idle takes on the order of a minute).

## 14. Known Limitations & Technical Debt

Disclosed deliberately, not silently carried:

- **`templates` DB table is schema-only** — defined in migration `0001`, referenced by zero
  application code, never populated by any seed script, no UI reads or writes it (confirmed live
  this session). The originally-specified FR-015 "start a new diagram from a template" feature was
  never built against it; the actual template-import capability that shipped
  (docs/c4-context-template.md-driven C4 Context import) is unrelated and does not use this table.
- **OpenAPI route schemas are not yet enriched** (`canvas-lfc`) — `/docs` lists every route
  correctly but request/response bodies stay undocumented until individual routes adopt Fastify's
  `schema` option.
- **A pre-existing `fastify` vulnerability** (`canvas-ljx`) is un-remediated — two advisories
  against the pinned 5.10.0, one directly relevant given this app's `trustProxy: true` config.
- **RP-Initiated Logout (`canvas-252`) is implemented and test-covered but not yet live-verified**
  against a real deployed Keycloak (`canvas-252.1`) — the Azure environment was mid-teardown when
  the fix landed.
- **The Keycloak SSO E2E spec does not run in CI** — standing up Keycloak as a CI service
  container is tracked separately; today it's a manual/local-only verification path.
- **Route-level request validation is inconsistent** — most routes hand-validate imperatively
  rather than via declarative Fastify/zod schema (see §7).

## 15. Glossary

See `docs/business-requirements.md` §11 for product-level terms (DSL, Round-trip, Standard,
Persona, etc.). Additional technical terms used only in this document:

| Term | Meaning |
|---|---|
| **Shared kernel** | `packages/diagram-core` — the one parser/renderer/validator implementation both the frontend and backend depend on, rather than each maintaining its own |
| **DSL family** | One of the six Mermaid grammar families (`flowchart`/`c4`/`sequence`/`erd`/`uml`/`architecture`) a `diagramTypeId` maps to; several diagram types can share one family |
| **`DiagramModel`** | The in-memory, family-agnostic parsed representation of a diagram — the shared data shape every renderer, validator, and AI tool operates on |
| **RP-Initiated Logout** | The OIDC-standard mechanism (`end_session_endpoint`) for terminating an IdP's own SSO session on sign-out, not just the relying party's local session |
