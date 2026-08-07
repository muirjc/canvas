# Runbook

Operational reference for running, debugging, and maintaining Canvas locally. For feature-level
walkthroughs, see `specs/*/quickstart.md`. For the "what is this project" overview, see
[README.md](README.md).

## Environment variables (`apps/api/.env`)

| Variable | Required | Notes |
|---|---|---|
| `PORT` | no (default `3000`) | API listen port |
| `DATABASE_URL` | **yes**, unless `NODE_ENV=test` | `postgres://canvas:canvas_dev_password@localhost:5433/canvas`. Falls back to `.../canvas_test` automatically when `NODE_ENV=test` — see `apps/api/src/config.ts`. |
| `SESSION_SECRET` | **yes**, unless `NODE_ENV=test` | ≥32 characters. Falls back to a fixed test string when `NODE_ENV=test`. |
| `ALLOW_LOCAL_AUTH` | no (default `false`) | Set `true` for local dev/demo — enables email/password login without OIDC. |
| `OIDC_ISSUER_URL` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` / `OIDC_REDIRECT_URI` | no | Leave blank locally; SSO routes are disabled when unset (logged at startup). See "Keycloak SSO" below to actually try it locally. |
| `WEB_ORIGINS` | no (default `http://localhost:5173`) | Comma-separated list of origins allowed to make credentialed CORS requests. |
| `COOKIE_SECURE` | no (default `false`) | Set `true` for a split-origin deployment (frontend and API on different hosts, e.g. Azure — see `docs/azure-deployment.md` for a quick demo, or `infra/azure/README.md` for a proper IaC deployment). Forced `true` automatically whenever `COOKIE_SAME_SITE=none`. |
| `COOKIE_SAME_SITE` | no (default `lax`) | `lax`/`none`/`strict`. Leave at the default for local dev and any same-origin deployment. `none` is required for a split-origin deployment — `lax` cookies are never attached to cross-site fetch/XHR calls. |

The API refuses to start without `DATABASE_URL`/`SESSION_SECRET` in non-test mode — this is
intentional fail-fast behavior, not a bug.

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

## Keycloak SSO (canvas-mi9)

Local Keycloak with a reproducible, version-controlled realm import — no manual admin-console
clickthrough needed. Not started by the plain `docker compose up -d` above (see
`docker-compose.yml`'s own comment); opt in explicitly:

```bash
docker compose --profile sso up -d keycloak
```

Wait for `curl http://localhost:8180/realms/CanvasRealm/.well-known/openid-configuration` to
return `200` (a JVM boot takes a few seconds), then point the API at it:

```bash
# apps/api/.env — see .env.example's own comment on these four
OIDC_ISSUER_URL=http://localhost:8180/realms/CanvasRealm
OIDC_CLIENT_ID=canvas-api
OIDC_CLIENT_SECRET=canvas-dev-client-secret-do-not-use-in-production
OIDC_REDIRECT_URI=http://localhost:3000/auth/callback
```

Restart `npm run dev --workspace=@canvas/api` to pick up the new env vars (OIDC discovery runs
once at startup, not per-request) and reload the frontend — `LoginForm.tsx` now shows a
"Sign in with SSO" link. `infra/keycloak/CanvasRealm-realm.json` seeds two test users, each
forced through Keycloak's own TOTP (MFA) enrollment on first login — there is no way to complete
Keycloak SSO login without it, realm policy, not just app code:

| Email | Password | Keycloak realm role | canvas `UserRole` |
|---|---|---|---|
| `sso-admin@example.com` | `sso-admin-dev-password` | `admin` | `admin` |
| `sso-architect@example.com` | `sso-architect-dev-password` | `architect` | `architect` |

Role mapping (`apps/api/src/auth/oidc.ts`'s `mapRealmRolesToUserRole`) reads the realm roles
claim (`realm_access.roles` in the ID token, via the realm's own "realm roles" protocol mapper)
and re-syncs it on every login — Keycloak is the source of truth once a user signs in via SSO, so
a role change there takes effect on that user's very next login, not just at some later manual
re-provisioning step. A user with none of `admin`/`architect`/`viewer` as a realm role defaults to
`viewer` (least privilege), never silently escalated.

**Verified against a real Keycloak instance, not just realm config that's never exercised** —
`apps/web/tests/e2e/sso-login.spec.ts` drives the actual login + first-time MFA enrollment
through Keycloak's own login theme (reads the enrollment page's live TOTP secret, computes a real
code with `otplib`, submits it) and confirms the resulting canvas session has the correctly
mapped role. Two real bugs in the pre-existing OIDC callback code were found and fixed doing this
(see `oidc.ts`'s own comments): a `request.hostname`-derived redirect URI silently missing its
port, and a post-login redirect assuming same-origin frontend/API when canvas is deliberately
split-origin. Neither was previously reachable by any test, since nothing had exercised a real
OIDC round-trip before. This spec needs `E2E_SSO_READY=1` (on top of the usual `E2E_PROJECT_ID`)
and a **freshly (re)started** Keycloak container — `docker compose --profile sso down keycloak &&
docker compose --profile sso up -d keycloak` — its realm-imported users carry no persistent
volume, so a `restart` (not a full recreate) leaves a completed enrollment from a prior run in
place and the spec's "first-time enrollment" assumption no longer holds. Not run in CI today
(standing up Keycloak there is tracked separately).

`ALLOW_LOCAL_AUTH=true` still works alongside SSO — both entry points render whenever both are
configured; this is a genuine platform-wide, not-yet-revisited decision for a *deployed*
environment (see `infra/azure/modules/apiapp.bicep`'s own `allowLocalAuth` param comment for why
it currently defaults `true` there too, and what has to happen before that changes).

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
| `unit-tests` | `diagram-core` + `api` vitest suites | Postgres service container (`canvas_test` DB) |
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
