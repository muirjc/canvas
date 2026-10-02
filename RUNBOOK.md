# Runbook

Operational reference for running, debugging, and maintaining Canvas locally. For feature-level
walkthroughs, see `specs/*/quickstart.md`. For the "what is this project" overview, see
[README.md](README.md).

## Environment variables (`apps/api/.env`)

| Variable | Required | Notes |
|---|---|---|
| `PORT` | no (default `3000`) | API listen port |
| `DB_CLIENT` | no (default `postgres`) | `postgres` or `sqlite` — selects the Kysely dialect (`apps/api/src/db/client.ts`). See "Database engine" below. |
| `DATABASE_URL` | **yes**, unless `NODE_ENV=test` | For `DB_CLIENT=postgres` (default): `postgres://canvas:canvas_dev_password@localhost:5433/canvas`. For `DB_CLIENT=sqlite`: a file path (e.g. `./data/canvas.db`) or `:memory:`. Falls back automatically when `NODE_ENV=test` (to `.../canvas_test` for Postgres, or an in-memory SQLite database for `TEST_DB_CLIENT=sqlite`) — see `apps/api/src/config.ts`. |
| `SESSION_SECRET` | **yes**, unless `NODE_ENV=test` | ≥32 characters. Falls back to a fixed test string when `NODE_ENV=test`. |
| `ALLOW_LOCAL_AUTH` | no (default `false`) | Set `true` for local dev/demo — enables email/password login without OIDC. |
| `OIDC_ISSUER_URL` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` / `OIDC_REDIRECT_URI` | no | Leave blank locally; SSO routes are disabled when unset (logged at startup). See "Entra ID SSO" below to actually try it locally. |
| `WEB_ORIGINS` | no (default `http://localhost:5173`) | Comma-separated list of origins allowed to make credentialed CORS requests. |
| `COOKIE_SECURE` | no (default `false`) | Set `true` for a split-origin deployment (frontend and API on different hosts, e.g. Azure — see `docs/azure-deployment.md` for a quick demo, or `infra/azure/README.md` for a proper IaC deployment). Forced `true` automatically whenever `COOKIE_SAME_SITE=none`. |
| `COOKIE_SAME_SITE` | no (default `lax`) | `lax`/`none`/`strict`. Leave at the default for local dev and any same-origin deployment. `none` is required for a split-origin deployment — `lax` cookies are never attached to cross-site fetch/XHR calls. |
| `ENABLE_API_DOCS` | no (default `false`) | Set `true` to serve an OpenAPI/Swagger UI at `/docs`. Opt-in — left `false` by default so a real deployment doesn't expose its full route surface just because the capability exists. See "API documentation" below. |

The API refuses to start without `DATABASE_URL`/`SESSION_SECRET` in non-test mode — this is
intentional fail-fast behavior, not a bug.

## Database engine

Canvas supports two database engines, selected by `DB_CLIENT`:

| | PostgreSQL (`DB_CLIENT=postgres`, the default) | SQLite (`DB_CLIENT=sqlite`) |
|---|---|---|
| Setup | `docker compose up -d` (or any reachable Postgres 16 server) | None — `better-sqlite3` is bundled; `DATABASE_URL` just needs to be a file path (or `:memory:`) |
| Migrations | `apps/api/migrations/*.sql` (13 incremental files) | `apps/api/migrations/sqlite/0001_init.sql` (one file, the schema's final shape directly — SQLite can't parse several constructs the incremental Postgres migrations use) |
| Recommended for | Any deployment with concurrent writers, including the Azure reference deployment | Local dev, evaluation, and small/single-team self-hosted use **only** |

**Why SQLite isn't recommended for larger concurrent deployments**: SQLite serializes writers —
only one write transaction can be in flight at a time (`SQLITE_BUSY` under contention without WAL
tuning, which this project does not attempt to add). This is a real, disclosed limitation, not an
oversight — see `docs/solution-architecture-document.md` §12 for the full trade-off and
`.specify/memory/constitution.md` Principle VI for why Kysely (a typed SQL compiler, not an ORM)
was judged compatible with keeping both engines supported from one codebase.

A few other disclosed, by-design differences between the two engines:
- SQLite's `LIKE`-based search is ASCII-only case-insensitive (Postgres's `ILIKE` does full
  Unicode case-folding).
- The Playwright E2E suite runs against Postgres only; the SQLite dialect's CI coverage is the
  `unit-tests` job's matrix (see "CI" below).

Running against SQLite with no Postgres/Docker at all:

```bash
# apps/api/.env
DB_CLIENT=sqlite
DATABASE_URL=./data/canvas.db   # or :memory: for a throwaway database
SESSION_SECRET=...
ALLOW_LOCAL_AUTH=true

npm run migrate --workspace=@canvas/api
npm run seed --workspace=@canvas/api
npm run dev --workspace=@canvas/api
```

## Starting everything from a cold clone

```bash
docker compose up -d                                   # Postgres on host port 5433
npm install
npm run build --workspace=@canvas/diagram-core          # must happen before api/web build or run
cp apps/api/.env.example apps/api/.env                  # then set ALLOW_LOCAL_AUTH=true
npm run migrate --workspace=@canvas/api
npm run seed --workspace=@canvas/api                    # prints admin login + a demo project id
npm run dev --workspace=@canvas/api                     # foreground; Ctrl-C to stop
npm run dev --workspace=@canvas/web                     # separate terminal; foreground
```

Sign in at `http://localhost:5173/?projectId=<seed-printed-id>` with `admin@example.com` /
`admin-dev-password` (or `architect@example.com` / `architect-dev-password`).

## API documentation

Set `ENABLE_API_DOCS=true` in `apps/api/.env` and restart the API dev server to serve an
interactive OpenAPI/Swagger UI at `http://localhost:3000/docs` (raw spec at `/docs/json`). Lists
every registered route (47 as of this writing); request/response body schemas are not yet
annotated for most routes (tracked as `canvas-lfc`) — for the authoritative shape of any given
endpoint not yet schema-annotated, see its `apps/api/src/**/*.routes.ts` source or matching
`apps/api/tests/contract/*.test.ts`. Left `false` by default (same opt-in posture as
`ALLOW_LOCAL_AUTH`) so a real deployment doesn't expose its full route surface unintentionally —
deliberately turn it on for that environment if you want it there too.

## Entra ID SSO (canvas-haz)

Unlike the self-hosted Keycloak this replaced, there's no local-container IdP to `docker compose
up` — Entra ID is always a real, cloud-hosted tenant. Local SSO testing needs a real (free) Entra
dev tenant and its own app registration; `ALLOW_LOCAL_AUTH=true` remains the primary, fully
self-contained local dev login path (see `.env.example`), and nothing about it changed in this
migration.

**One-time tenant setup** (a Global Administrator / Application Administrator does this in the
Entra admin center — this is a tenant-side task, not app code, and only needs doing once per
tenant):

1. Create a single-tenant **app registration** (e.g. `canvas-dev` for local work, a separate
   `canvas-azure` registration for the actual Azure deployment — kept separate because
   `az ad app update --web-redirect-uris` *replaces* the whole redirect-URI list, so one shared
   registration would have its localhost entries overwritten by every Azure redeploy).
2. Authentication → add a **"Web"** platform (not SPA — canvas is a confidential BFF client; the
   browser never sees an access/ID token, only a session cookie). Redirect URI:
   `http://localhost:3000/auth/callback`. Post-logout redirect: `http://localhost:5173`.
3. Certificates & secrets → create a client secret. Record its value (shown once) and its
   expiry — Entra client secrets expire (6–24 months is typical); put the renewal date on a
   calendar, since an expired secret fails every login with no advance warning.
4. App roles → create exactly three, **Value** set to the literal strings `admin`, `architect`,
   `viewer` (must match `UserRole` in `apps/api/src/auth/types.ts` exactly — this is what lets
   `apps/api/src/auth/oidc.ts`'s `mapIdpRolesToUserRole` work with no mapping table at all).
   Allowed member type: Users/Groups.
5. Token configuration → add the optional claim **`email`** to the ID token (without it, work/
   school accounts without a `mail` attribute set often have no usable email claim at all —
   `extractIdentityFromIdToken` falls back to `preferred_username` only when it looks like an
   email, and ultimately to a non-matching `${sub}@unknown.local` placeholder if neither is
   present).
6. Enterprise application → Properties → **"Assignment required" = Yes**. This is what makes
   authorization fail-closed at the tenant level — a user with no app-role assignment can't even
   obtain a token for this app, let alone reach canvas's own role-mapping code.
7. Assign test users to the app roles you want to exercise locally.
8. MFA is enforced entirely tenant-side now (a Conditional Access policy, or tenant Security
   Defaults) — there is no app-level TOTP enrollment step the way Keycloak's realm policy forced
   one. Confirm your tenant's policy actually requires MFA for this app if that parity matters to
   you locally.

**Local `.env`** once the app registration exists:

```bash
# apps/api/.env — see .env.example's own comment on these four
OIDC_ISSUER_URL=https://login.microsoftonline.com/<tenant-id>/v2.0
OIDC_CLIENT_ID=<canvas-dev app registration's Application (client) ID>
OIDC_CLIENT_SECRET=<the client secret value from step 3>
OIDC_REDIRECT_URI=http://localhost:3000/auth/callback
```

The `/v2.0` suffix is **required** — `apps/api/src/config.ts`'s `validateOidcIssuerUrl()` rejects
a bare tenant path or the v1 endpoint (`https://sts.windows.net/<tenant-id>/`) at startup with a
clear error, since the v1 token shape has no flat top-level `roles` claim. The multi-tenant
aliases (`/common`, `/organizations`, `/consumers`) are rejected the same way — this app always
authenticates against one specific tenant. Restart `npm run dev --workspace=@canvas/api` to pick
up the new env vars (OIDC discovery runs once at startup, not per-request) — `LoginForm.tsx` now
shows a "Sign in with SSO" link.

Role mapping (`apps/api/src/auth/oidc.ts`'s `extractEntraRoles`/`mapIdpRolesToUserRole`) reads the
flat top-level `roles` claim on the ID token and re-syncs it on every login — Entra is the source
of truth once a user signs in via SSO, so a role change there (or in the app's role assignments)
takes effect on that user's very next login, not just at some later manual re-provisioning step.
Identity matching stays **email-only** (no `oid`/`tid` column) — a deliberate, smallest-change
decision made for this migration, same risk profile this app already accepted under Keycloak.
Emails are lowercased before lookup (Entra can return mixed case; Postgres/SQLite string equality
is case-sensitive). A user with none of `admin`/`architect`/`viewer` in `roles` defaults to
`viewer` (least privilege) — in practice this rarely fires, since "Assignment required = Yes"
above already prevents an unassigned user from getting a token at all.

**Testing posture — unit/contract only, no live-tenant E2E**: the previous Keycloak-era
`apps/web/tests/e2e/sso-login.spec.ts` (a live-browser spec driving a real self-hosted IdP's login
theme) is gone; it had no Entra equivalent worth building (standing up a disposable cloud tenant
per CI run is a different order of complexity than `docker compose up`, and MFA now lives entirely
in tenant Conditional Access policy, outside any test's reach regardless). In its place,
`apps/api/tests/contract/oidc-callback.test.ts` drives the real `/auth/login` → `/auth/callback`
flow through the genuinely-not-mocked `openid-client`/`oauth4webapi` libraries, with `fetch`
stubbed to serve a locally-generated RS256 keypair's discovery document, JWKS, and signed test ID
tokens (via `jose`, a test-only devDependency) — this is what actually proves ID-token signature
verification (`client.enableNonRepudiationChecks`), `iss`/`aud`/`exp`/nonce/state validation, and
role mapping all work, without needing a live tenant. There is no local-equivalent live SSO test
to run by hand; the **only** real-tenant verification is the manual post-deploy checklist below,
run once against the actual deployed Azure environment.

`ALLOW_LOCAL_AUTH=true` still works alongside SSO — both entry points render whenever both are
configured; this is a genuine platform-wide, not-yet-revisited decision for a *deployed*
environment (see `infra/azure/modules/apiapp.bicep`'s own `allowLocalAuth` param comment — it
defaults `false` there specifically because Entra SSO is the intended only way in for that
deployment, kept as a param purely as an emergency break-glass switch).

### Manual post-deploy live verification (Entra, Phase 7 of canvas-haz)

Nothing above is a substitute for actually trying this against the real deployed Azure
environment once — the contract test proves the *code's* validation logic; it can't prove the
*tenant's* app registration, role assignments, or redirect-URI list are configured correctly. Work
through this checklist once per environment stand-up (and again any time the `canvas-azure` app
registration's redirect URIs or client secret change):

- `GET /auth/config` reports `oidcEnabled: true`; no discovery/issuer errors in the API's logs.
- An admin-role test user: SSO → Entra's MFA prompt (per the tenant's Conditional Access policy) →
  lands back on the real web origin (not Entra's own generic post-login page); `/auth/me` reports
  `role: 'admin'`; the DB row's stored email is lowercased.
- Architect/viewer test users map correctly; a user assigned two roles gets the higher of the two.
- An unassigned user → Entra's own `AADSTS50105` → canvas's own friendly 403 (not a raw 500).
- Change a test user's App Role assignment in Entra, sign out, sign in again → the role re-syncs
  to the new value on that very next login.
- Deactivate a user via canvas's own admin console → their next SSO attempt is rejected (403).
- **Sign-out round-trips through Entra's logout and lands back on the real web origin** — this is
  the one most likely to silently misconfigure: a redirect URI Entra doesn't recognize means it
  stops at its own generic "you have signed out" page instead of bouncing back, with no error
  surfaced anywhere in canvas's own logs.
- `canvas-api`'s container app revision is healthy and successfully pulled its image; the
  migration and seed job executions both succeed too (all three prove the relocated `AcrPull` role
  assignment — see `infra/azure/modules/keyvault.bicep` — actually works); exactly one `AcrPull`
  role assignment exists on the shared managed identity.
- No `canvas-keycloak` container app, no `keycloak` Postgres database, and nothing under
  `infra/keycloak/` remain anywhere in the environment.
- `pause.sh`/`resume.sh` still work cleanly; a routine re-run of `deploy.sh` does not re-trigger a
  `RoleAssignmentExists` error (confirms the AcrPull skip-logic still works after its relocation).

### Running servers detached, for scripted/agent workflows

```bash
nohup npm run dev --workspace=@canvas/api > /tmp/api-dev.log 2>&1 &
disown
nohup npm run dev --workspace=@canvas/web > /tmp/web-dev.log 2>&1 &
disown
curl -s http://localhost:3000/health   # {"status":"ok"} once ready
```

Env vars don't survive across separate shell invocations unless exported in the same command or
placed in `apps/api/.env` — if the API fails immediately with `Missing required environment
variable`, that's why.

## Resetting state

- **Wipe and reseed the dev database**: `docker compose down -v && docker compose up -d`, then
  re-run `migrate` and `seed`.
- **Re-run seed only** (idempotent — matches existing users/project by email/name instead of
  duplicating): `npm run seed --workspace=@canvas/api`.
- **Rebuild `diagram-core` after any change to `packages/diagram-core/src`**: both `apps/api` and
  `apps/web` resolve it via its **built** `dist/` output (npm workspace symlink to
  `packages/diagram-core`, whose `package.json` `main` points at `dist/`), not the TS source. A
  stale or missing `dist/` is the most common cause of `Cannot find module '@canvas/diagram-core'`
  or of edits appearing to "not take effect."

## Running tests locally

```bash
npm run build --workspace=@canvas/diagram-core    # once, before any api/web test run
npm run test --workspace=@canvas/diagram-core      # no external services needed
npm run test --workspace=@canvas/api               # needs Postgres reachable; NODE_ENV=test picks canvas_test DB automatically
TEST_DB_CLIENT=sqlite npm run test --workspace=@canvas/api   # same suite against an in-memory SQLite DB — no Postgres needed
```

E2E (Playwright) needs both dev servers running (see above) and a seeded project id:

```bash
export E2E_PROJECT_ID='<seed-printed-id>'
cd apps/web
npx playwright test                 # full suite; starts its own Vite dev server if not already running
npx playwright test tests/e2e/import.spec.ts   # single file
RUN_PERF_TESTS=1 npx playwright test tests/e2e/canvas-performance.spec.ts   # opt-in perf test, excluded from CI
```

Tests missing `E2E_PROJECT_ID` are skipped, not failed — a suite showing all-skipped almost always
means that variable isn't set.

## Known flakiness

- **E2E specs run with `workers: 1`** (`apps/web/playwright.config.ts`) because every spec shares
  one seeded project (`E2E_PROJECT_ID`) and several assert on its diagram count — parallel workers
  let one worker's diagram creation land between another worker's before/after count assertions.
  This was observed as a real CI failure (2-worker default on GitHub-hosted runners) even though
  it didn't reproduce locally with 4 workers. If you deliberately override `workers` to speed up a
  local run, expect the same class of flake to resurface.
- **A Postgres "deadlock detected" in `resetDatabase()`** has been observed once under heavy
  concurrent test-suite load. Re-running resolves it; if it recurs consistently, check for a test
  file missing `fileParallelism: false` semantics (contract tests share one database and reset it
  in `beforeEach`, so they must not run concurrently against each other — see
  `apps/api/vitest.config.ts`).
- **`@esbuild/linux-x64` optional dependency going missing** after `npm install` (breaks `tsx`):
  fix with `npm install esbuild --no-save`.

## CI (`.github/workflows/ci.yml`)

Three jobs, all required to pass before a PR can merge (branch protection on `main`):

| Job | What it does | Needs |
|---|---|---|
| `lint-and-build` | `eslint .` + `tsc` build for `diagram-core` → `api` → `web`, in that order | — |
| `unit-tests` | `diagram-core` + `api` vitest suites, as a `db-client: [postgres, sqlite]` matrix (`fail-fast: false`) — `diagram-core`'s own tests run once, on the postgres leg only, since that package has no database coupling | Postgres service container (`canvas_test` DB) — present for both matrix legs, but only the postgres leg actually uses it |
| `e2e-tests` | Seeds a dev-mode Postgres DB, starts the API, runs the full Playwright suite (which starts its own Vite dev server) | Postgres service container (`canvas` DB) |

The opt-in performance spec (`RUN_PERF_TESTS`) is intentionally **not** run in CI — shared-runner
timing variance makes it unreliable there; run it locally instead when performance work is in
scope.

On failure, the `e2e-tests` job uploads the Playwright HTML report as a build artifact
(`playwright-report`, 7-day retention) — download it from the failed run's Summary page for
screenshots/traces of the failing test.

### Pushing to `.github/workflows/*`

The `gh` CLI's OAuth token on this machine lacks the `workflow` scope, so `git push` is rejected
for any change under `.github/workflows/`. Use the GitHub MCP `push_files`/`create_or_update_file`
tools for those specific files instead; `git push` works normally for everything else.

## Branch protection

`main` requires: the 3 CI checks above to pass, the PR branch to be up to date with `main`
("strict" status checks), and blocks force-pushes/deletion. No approving-review requirement is
configured (solo-maintainer setup) — see the repo's Rulesets settings to change this later if
collaborators join.

Branch protection/rulesets require the repo to be public on GitHub's free tier (Pro is required
to enable them on a private repo) — this repo is public for that reason.
