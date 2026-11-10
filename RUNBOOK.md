# Runbook

Operational reference for running, debugging, and maintaining Canvas locally. For feature-level
walkthroughs, see `specs/*/quickstart.md`. For the "what is this project" overview, see
[README.md](README.md).

## Environment variables (`apps/api-py/.env`)

The API reads only the process environment. Locally, keep settings in `apps/api-py/.env`
(gitignored; start from `apps/api-py/.env.example`) and pass it with `uv run --env-file .env ...`.
Every setting and its default is in `apps/api-py/src/canvas_api/config.py`.

| Variable                                                                                | Required                             | Notes                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DB_CLIENT`                                                                             | no (default `postgres`)              | `postgres` or `sqlite`. See "Database engine" below.                                                                                                                                                      |
| `DATABASE_URL`                                                                          | **yes**                              | Postgres: `postgres://canvas:canvas_dev_password@localhost:5433/canvas`. SQLite: a file path (e.g. `./data/canvas.db`, relative to where you run the command) or `:memory:`.                              |
| `SESSION_SECRET`                                                                        | **yes**                              | ≥32 characters.                                                                                                                                                                                           |
| `SESSION_IDLE_MINUTES`                                                                  | no (default `480`)                   | A session unused for this long expires (up to a minute sooner: the stored expiry moves forward at most once a minute). Sessions are stored in the database (`sessions` table), so they survive restarts.                              |
| `SESSION_MAX_HOURS`                                                                     | no (default `12`)                    | A signed-in session ends this long after sign-in, however active.                                                                                                                                         |
| `AUTH_MODE`                                                                             | no (default `entra`)                 | `entra` or `local`. `local` serves only Canvas-managed email/password sign-in: local sign-in is forced on and the Entra routes are never registered, even if `OIDC_*` is set. See "Local accounts" below. |
| `ALLOW_LOCAL_AUTH`                                                                      | no (default `false`)                 | Set `true` for local dev/demo — enables email/password login without OIDC.                                                                                                                                |
| `MFA_REQUIRED` / `MFA_ENCRYPTION_KEY`                                                   | no                                   | Two-step verification for Canvas-password accounts — see "Local accounts" below.                                                                                                                          |
| `LOGIN_RATE_LIMIT`                                                                      | no                                   | Password sign-in attempts per client IP per minute (default 20 in local mode, off otherwise).                                                                                                             |
| `OIDC_ISSUER_URL` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` / `OIDC_REDIRECT_URI`       | no                                   | Leave blank locally; SSO is off unless the issuer, client id and redirect URI are all set. See "Entra ID SSO" below.                                                                                      |
| `OIDC_CLIENT_AUTH` / `AZURE_CLIENT_ID`                                                  | no                                   | `managed-identity` signs in to Entra with the managed identity (`AZURE_CLIENT_ID`) instead of a client secret. See "No client secret" below.                                                              |
| `WEB_ORIGINS`                                                                           | no (default `http://localhost:5173`) | Comma-separated list of origins allowed to make credentialed CORS requests.                                                                                                                               |
| `COOKIE_SECURE`                                                                         | no (default `false`)                 | Forced `true` whenever `COOKIE_SAME_SITE=none`.                                                                                                                                                           |
| `COOKIE_SAME_SITE`                                                                      | no (default `lax`)                   | `lax`/`none`/`strict`. Leave at the default for local dev and any same-origin deployment (Azure serves the web app and the API from one address). `none` is only for a split-origin deployment.           |
| `AI_PROVIDER` / `AI_MODEL` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`                     | no                                   | `anthropic`, `openai` or `mock` (rule-based, no key; what the e2e suite uses). Unset = AI off.                                                                                                            |
| `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` / `GITHUB_APP_API_URL` / `CANVAS_PUBLIC_URL` | no                                   | GitHub approval; off unless both the id and key are set. See "GitHub approval" below.                                                                                                                     |
| `CANVAS_VALIDATOR_DIR`                                                                  | no                                   | Where the CI validator bundle is (default: `packages/validator-cli/dist` in the repository).                                                                                                              |
| `APPLICATIONINSIGHTS_CONNECTION_STRING`                                                 | no                                   | Telemetry; off unless set. See "Performance telemetry" below.                                                                                                                                             |
| `WEB_DIST_DIR` / `PAUSED_PAGE_PATH` / `CANVAS_PAUSED`                                   | no                                   | Serve the built web app, and the paused page while `CANVAS_PAUSED=true`. Set in the image; unused locally (Vite serves the web app).                                                                      |
| `NODE_ENV`                                                                              | no                                   | `production` makes `MFA_ENCRYPTION_KEY` required in local auth mode, and makes the `e2e_reset` job refuse to run.                                                                                         |
| `ENABLE_API_DOCS`                                                                       | no (default `false`)                 | `true` serves FastAPI's Swagger UI at `/docs` and the OpenAPI JSON at `/openapi.json`. See "API documentation" below.                                                                                     |

The port is uvicorn's `--port`, not a setting. The API refuses to start without
`DATABASE_URL`/`SESSION_SECRET`, or with an invalid sign-in, GitHub or MFA setting; this is
intentional fail-fast behaviour.

## Database engine

Canvas supports two database engines, selected by `DB_CLIENT`:

|                 | PostgreSQL (`DB_CLIENT=postgres`, the default)                                   | SQLite (`DB_CLIENT=sqlite`)                                                                |
| --------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Setup           | `docker compose up -d` (or any reachable Postgres 16 server)                     | None: Python's built-in `sqlite3`; `DATABASE_URL` is a file path (or `:memory:`); the local default in `.env.example` |
| Migrations      | `apps/api-py/migrations/*.sql` (incremental files)                               | `apps/api-py/migrations/sqlite/*.sql` (a squashed `0001_init.sql`, then incremental files) |
| Recommended for | Any deployment with concurrent writers, including the Azure reference deployment | Local dev, evaluation, and small/single-team self-hosted use **only**                      |

**Why SQLite isn't recommended for larger concurrent deployments**: SQLite serializes writers —
only one write transaction can be in flight at a time. This is a real, disclosed limitation, not an
oversight — see `docs/solution-architecture-document.md` §12 for the full trade-off and
`.specify/memory/constitution.md` Principle VI for why a query builder (SQLAlchemy Core, not an
ORM) keeps both engines supported from one codebase.

A few other disclosed, by-design differences between the two engines:

- SQLite's `LIKE`-based search is ASCII-only case-insensitive (Postgres's `ILIKE` does full
  Unicode case-folding).
- The Playwright E2E suite runs against Postgres only; the SQLite dialect's CI coverage is the
  `unit-tests` job's matrix (see "CI" below).

**Migrations** apply in file-name order, each in its own transaction, recorded in
`schema_migrations`. `python -m canvas_api.jobs.migrate` applies the pending ones; the seed,
purge, bootstrap-admin and e2e-reset jobs apply them first too. A new migration is a new `.sql`
file in both folders.

Local runs use SQLite by default (`apps/api-py/.env.example`: `DB_CLIENT=sqlite`,
`DATABASE_URL=./data/canvas.db`, relative to `apps/api-py`). The API and every job create the file's folder if
it's missing (canvas-mywp). For a throwaway database, `DATABASE_URL=:memory:` (lost when the process exits).

### Running locally without containers (Linux, macOS, Windows)

`npm run dev:local` (`scripts/dev-local.mjs`, canvas-mywp) is the whole local setup: Node 22 and
[uv](https://docs.astral.sh/uv/) are the only requirements (uv fetches Python 3.15), with no Docker, WSL2 or
database server. It reads `apps/api-py/.env` (copied from `.env.example` on first run; the process environment
wins over it), builds `packages/diagram-core` if needed, seeds demo data when the SQLite database is new (else
applies pending migrations), then runs the API and the web app together with `[api]` / `[web]` output; Ctrl-C
stops both. Options: `API_PORT` / `WEB_PORT` (default 3000 / 5173; the web origin is added to `WEB_ORIGINS` and
the web app pointed at the API port), `--seed` to run `seed_demo` again (only adds what's missing).

```bash
npm install
npm run dev:local
```

Sign in at `http://localhost:5173` with `admin@example.com` / `admin-dev-password`.

To serve everything from one process instead (as in Azure): `npm run build --workspace=@canvas/web` and set
`WEB_DIST_DIR=../web/dist` in `apps/api-py/.env`; the API then serves the web app on its own port.

### The Windows installer (canvas-xl3a)

`packaging/windows/build.ps1` builds `CanvasSetup-<version>.exe` (one person on their own PC; using it:
`docs/admin-guide/installing-on-windows.md`). Run it on Windows (PowerShell 5.1 or 7) after `npm ci`, with uv
and Inno Setup 6 installed: `./packaging/windows/build.ps1 -Version 0.2.0`. `-SkipInstaller` stops after the
`out\stage` folder (no Inno Setup needed; `stage\python\python.exe -m canvas_api.desktop start` runs it);
`-WebDist` takes an already-built `apps/web/dist` (built with `VITE_API_BASE_URL` empty). CI's
`windows-installer` job builds it on every PR and runs `packaging/windows/smoke-test.ps1` (install, first
start, sign-in, upgrade, uninstall); its artifact holds the installer for a week.

- **Bumping its Python** (`$PythonUrl` / `$PythonSha256` in build.ps1): pick a python-build-standalone
  release at least two weeks old, take the `install_only_stripped` asset's sha256 from the release, then
  review `licenses/windows-python/`: each bundled library's version (the release's
  `pythonbuild/downloads.json`, or the library's own version at run time) and licence text (the release's
  `pgo-full` archive, `python/licenses`). The build refuses a release the manifest wasn't reviewed for, and
  any DLL the manifest doesn't list.
- **Python packages** come from `apps/api-py/uv.lock` (`uv export --frozen --no-dev`) without psycopg and
  tzdata (only psycopg needs it). The build fails when an installed package isn't in THIRD-PARTY-NOTICES.md
  (made from the Linux install), so a new Windows-only dependency can't ship without its licence.
- **SBOM** (canvas-xl3a.5): `packaging/windows/sbom.py` writes a CycloneDX 1.6 SBOM of the stage
  (`licenses\canvas-sbom.cdx.json` in the install, `out\CanvasSetup-<version>.cdx.json` beside the installer and
  in CI's artifact): the private Python and its bundled libraries (SHA-256 of each installed file), each
  installed Python package (SHA-256 of the exact wheel, from uv.lock), and the web app's npm packages (lockfile
  integrity). Licences come from `licenses/packages.json`, which `npm run licenses` writes with
  THIRD-PARTY-NOTICES.md (`licenses:check` keeps it current). `tests/test_windows_sbom.py` checks it against
  the CycloneDX 1.6 schema (`tests/data/cyclonedx-1.6`).
- The installer is unsigned (SmartScreen warns).

## Starting everything from a cold clone

`npm run dev:local` (above) does all of this with SQLite. With PostgreSQL by hand:

```bash
docker compose up -d                                   # Postgres on host port 5433
npm install
npm run build --workspace=@canvas/diagram-core          # before running or building the web app
cd apps/api-py
uv sync
cp .env.example .env                                    # local defaults, ALLOW_LOCAL_AUTH=true
uv run --env-file .env python -m canvas_api.jobs.seed_demo   # migrates; prints logins + a demo project id
uv run --env-file .env uvicorn canvas_api.main:app --port 3000 --reload   # foreground; Ctrl-C to stop
npm run dev --workspace=@canvas/web                     # separate terminal, repository root
```

Sign in at `http://localhost:5173/?projectId=<seed-printed-id>` with `admin@example.com` /
`admin-dev-password` (or `architect@example.com` / `architect-dev-password`). The web app calls
the API at `http://localhost:3000` (`VITE_API_BASE_URL` overrides it; `apps/web/src/config.ts`).

### Jobs

Each job is a Python module, run from `apps/api-py` with the same settings as the API
(`uv run --env-file .env python -m canvas_api.jobs.<name>`). In Azure each runs as a Container Apps
job from the same image.

| Job               | What it does                                                                                                                                         |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `migrate`         | Applies pending migrations.                                                                                                                          |
| `seed_catalog`    | Migrates, then seeds diagram types, starter standards, icon libraries and AI personas. Idempotent. Optional `AWS_ICONS_MANIFEST`.                    |
| `seed_demo`       | `seed_catalog`, then three demo accounts with published passwords and the "Smoke Test" project; prints `Project id: ...`. Refuses `AUTH_MODE=local`. |
| `bootstrap_admin` | The first admin of a local-mode environment (`BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD`, `BOOTSTRAP_MODE=create                             | reset`). Never prints the password. |
| `purge`           | Deletes diagrams and projects past their retention window and abandoned AI drafts. `--dry-run` lists them only.                                      |
| `e2e_reset`       | Empties the e2e "Smoke Test" project and removes `e2e-user-*` accounts. Refuses `NODE_ENV=production`.                                               |
| `syntax_report`   | Read-only Mermaid syntax dry run (canvas-7p3y): lists saved diagrams this build can't open (exit 1) or would rewrite on the next save. `--json`. Run the NEW code before releasing a syntax change; local databases only for now (the Azure DB is private to its VNet, so Azure would need its own job). See docs/admin-guide/operations.md. |

The GitHub status sync is `python -m canvas_api.github.sync_run` (see "GitHub approval").

## Real AWS icons (optional)

The AWS icon library ships as placeholder artwork. AWS's real icons aren't committed (public repo;
AWS's terms only explicitly cover using them to create diagrams), so each environment can generate
them from its own copy of AWS's icon package. The steps are in [`vendor-icons/README.md`](vendor-icons/README.md):
download the package, run `packages/diagram-core/scripts/generate-aws-icons.mjs`, then re-run the
catalog seed. For Azure, generate the file before running `infra/azure/deploy.sh`; the image copies
`vendor-icons/` and the catalog-seed job loads it. Diagrams keep working either way: both libraries
use the same `aws-icons@2024.1` version and icon ids.

## API documentation

Set `ENABLE_API_DOCS=true` in `apps/api-py/.env` and restart the API to serve FastAPI's Swagger UI at
`http://localhost:3000/docs` and the OpenAPI JSON at `/openapi.json` (no longer `/docs/json`). The
reviewed request/response shapes are the frozen contract, `apps/api-py/contract/openapi.json` (with
`constants.json`); edit it by hand together with the route it describes. The Python tests check
every response they get against it, and every request the API accepted (`apps/api-py/tests/api.py`). Off by default so a real
deployment doesn't publish its API map.

## Azure IP allow-list (canvas-cng)

The Azure environment only accepts the networks in `infra/azure/.secrets/allowed-ips` — on the
API's ingress (Container Apps access restrictions) and on the web app's Storage account (firewall)
— with Entra sign-in still required on top. See `infra/azure/README.md` for the file format.

- **Add or change an address:** edit the file and run `deploy.sh` (preview with `--what-if-only`).
- **Your IP changed and you're locked out** (both the site and `deploy.sh`'s upload check refuse):
  the quick fix without a full deploy, from any machine signed in to Azure:
  ```bash
  NEW=203.0.113.7   # your new public IP (curl https://api.ipify.org)
  az containerapp ingress access-restriction set -g canvas-rg -n canvas-api \
    --rule-name home-new --ip-address "$NEW/32" --action Allow --description "home (new)"
  az storage account network-rule add -g canvas-rg --account-name <canvasweb...> --ip-address "$NEW"
  ```
  Then put the new address in `allowed-ips` so the next deploy keeps it (a deploy replaces the
  live rules with the file's list).
- **Checking it:** from an allowed network Canvas answers normally. From anywhere else it returns
  **403** "RBAC: access denied" (Container Apps ingress) -- the web app and the API are one address
  since canvas-r3y. The old Storage web address (now only a redirect) returns **404 "The requested
  content does not exist" (`WebContentNotFound`)**: how a Storage static website answers a request
  its firewall refuses.

## Local accounts (canvas-ez1, option B)

Canvas can run with accounts it manages itself (`AUTH_MODE=local`) instead of Microsoft Entra ID.
Background and the threat model: `docs/ip-allowlist-security-plan.md` (option B).

### Choosing a mode

|                        | `entra` (default)                                    | `local`                                              |
| ---------------------- | ---------------------------------------------------- | ---------------------------------------------------- |
| Who keeps the accounts | Your Entra tenant (app roles admin/architect/viewer) | Canvas (Admin → Users)                               |
| Sign-in                | Entra, with its own MFA/Conditional Access           | Email + password, then an authenticator code         |
| Needs                  | An app registration (`ENTRA_CLIENT_ID`/`SECRET`)     | Nothing external; the IP allow-list is **mandatory** |
| First admin            | Whoever has the admin app role                       | Created by `deploy.sh` from `CANVAS_ADMIN_EMAIL`     |
| Use it when            | You have an Entra tenant                             | You don't, or want Canvas self-contained             |

Local mode is defence in depth: only allow-listed networks reach the site, and every person needs a
password **and** their phone. The mode is cached in `infra/azure/.secrets/auth-mode`, so a routine
`deploy.sh` never flips it.

### Setting up a local-mode environment

1. Put your networks in `infra/azure/.secrets/allowed-ips` ("Azure IP allow-list" above) — `deploy.sh`
   refuses local mode without them, even with `CANVAS_ALLOW_PUBLIC=1`.
2. `CANVAS_AUTH_MODE=local CANVAS_ADMIN_EMAIL=<you> ./deploy.sh --what-if-only`, review, then the same
   with `--yes`. `ENTRA_CLIENT_ID`/`ENTRA_CLIENT_SECRET` aren't needed. `deploy.sh` generates, into
   `infra/azure/.secrets/` (gitignored) and Key Vault:
   - `bootstrap-admin-password` — your one-time password;
   - `mfa-encryption-key` — encrypts stored authenticator secrets (see "Rotating the MFA key").
3. It runs the `canvas-bootstrap-admin` job, which creates you as an admin. No other accounts exist:
   the demo seed (`admin@example.com`, published passwords) isn't deployed in local mode and refuses
   to run there.
4. Open the site, sign in with `cat infra/azure/.secrets/bootstrap-admin-password`, choose your own
   password, then set up two-step verification (scan the QR code, confirm a code, **save the 10
   recovery codes** somewhere safe). After that the file no longer signs anyone in.
5. Add everyone else on Admin → Users.

Later deploys keep everything: the job only creates the admin if it's missing, and never touches
an account that already has a Canvas password. Switching an **existing** environment to local mode
keeps its database's accounts. If `CANVAS_ADMIN_EMAIL` is one of them (you signed in with Entra
before), the job gives it the one-time password and the admin role. Other Entra-created users have
no Canvas password, so they can't sign in until an admin resets one; deactivate any you don't want.
`deploy.sh` also removes a leftover `canvas-seed` demo job, if one exists, in local mode.

### Managing people

- **Add someone:** Admin → Users → **Add user** (email, name, role). The one-time password is shown
  **once** — copy it and hand it over (Canvas stores only its hash). At first sign-in they choose a
  password, then set up two-step verification. Passwords: at least 12 characters, not a common
  password, not containing their email name.
- **Forgotten password:** **Reset password** — a new one-time password, shown once; they're signed
  out everywhere. A reset also unlocks the account.
- **Locked account** (3 wrong passwords or codes in a row; a wrong current password on Change
  password counts too): **Unlock**, or **Reset password**. There is no automatic unlock. Anyone who
  knows an email can lock that account with three wrong guesses — accepted inside the allow-list.
- **Lost phone / used all recovery codes:** **Reset MFA** — they're signed out and set it up again
  at their next sign-in. (Recovery codes can't be regenerated yet; Reset MFA is the way.)
- **Someone leaves:** untick **Active** — they're signed out immediately.
- **What happened?** Admin → Audit log, or **View activity** on a user: sign-ins, failed sign-ins
  with the reason, lockouts, unlocks, password changes/resets, MFA set-ups/resets and every admin
  change — who, about whom, when, from which IP. Never a password or code. Kept indefinitely.
- **Your own password:** the header's **Change password** link.

### A lone admin who can't sign in

Forgotten password, lost phone, locked, deactivated or demoted — and no other admin to help: from a
machine on the allow-list, with the environment resumed, run `infra/azure/reset-admin.sh` (or
`reset-admin.sh <email>` for another account). It writes a new one-time password to
`infra/azure/.secrets/bootstrap-admin-password` (never printed) and makes the account an active,
unlocked admin with two-step verification reset, signed out everywhere. Then sign in and set up
again (step 4 above). Locally (dev): `BOOTSTRAP_MODE=reset BOOTSTRAP_ADMIN_EMAIL=...
BOOTSTRAP_ADMIN_PASSWORD=... uv run --env-file .env python -m canvas_api.jobs.bootstrap_admin`
in `apps/api-py`.

### Rotating the MFA key

`MFA_ENCRYPTION_KEY` (Key Vault `mfa-encryption-key`, `infra/azure/.secrets/mfa-encryption-key`)
encrypts every stored authenticator secret, and there's no re-encryption tool: **replacing it makes
every enrolled authenticator unreadable** (sign-in fails at the code step for everyone). Don't
rotate it routinely. If it has leaked — the attacker would also need the database to use it:

1. Generate a new one: `openssl rand -base64 32 | tr -d '\n' > infra/azure/.secrets/mfa-encryption-key`.
2. `./deploy.sh --yes` (it writes Key Vault and restarts the API with the new value).
3. Run `./reset-admin.sh` for yourself, sign in and set up MFA again.
4. **Reset MFA** for every other user on Admin → Users; each sets it up again at next sign-in.

### Switching back to Entra

`CANVAS_AUTH_MODE=entra ENTRA_CLIENT_ID=<id> ./deploy.sh` (the Entra client secret is still cached).
Local-mode accounts, MFA enrolments and the audit log stay in the database, unused; the
bootstrap-admin job is no longer deployed in Entra mode (an incremental deploy leaves the existing
job resource in place — harmless; `az containerapp job delete --name canvas-bootstrap-admin
--resource-group canvas-rg` removes it). Entra users sign in again as before.

### Reference

| Setting              | Default                             |                                                                                                                                                         |
| -------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTH_MODE`          | `entra`                             | `local` = Canvas accounts only; forces local sign-in on and ignores `OIDC_*`.                                                                           |
| `MFA_REQUIRED`       | on in local mode                    | Off elsewhere; dev accounts can opt in from the account screen.                                                                                         |
| `MFA_ENCRYPTION_KEY` | derived from `SESSION_SECRET` (dev) | Base64, 32 bytes; required in production local mode.                                                                                                    |
| `LOGIN_RATE_LIMIT`   | 20 in local mode, else off          | Password sign-ins per client IP per minute; keyed on the last `X-Forwarded-For` entry (unspoofable behind Azure's ingress); in memory (single replica). |

## Entra ID SSO (canvas-haz)

Unlike the self-hosted Keycloak this replaced, there's no local-container IdP to `docker compose
up` — Entra ID is always a real, cloud-hosted tenant. Local SSO testing needs a real (free) Entra
dev tenant and its own app registration; `ALLOW_LOCAL_AUTH=true` remains the primary, fully
self-contained local dev login path (see `apps/api-py/.env.example`).

**One-time tenant setup** (a Global Administrator / Application Administrator does this in the
Entra admin center — this is a tenant-side task, not app code, and only needs doing once per
tenant):

1. Create a single-tenant **app registration** (e.g. `canvas-dev` for local work, a separate
   `canvas-azure` registration for the actual Azure deployment — kept separate because
   `az ad app update --web-redirect-uris` _replaces_ the whole redirect-URI list, so one shared
   registration would have its localhost entries overwritten by every Azure redeploy).
2. Authentication → add a **"Web"** platform (not SPA — canvas is a confidential BFF client; the
   browser never sees an access/ID token, only a session cookie). Redirect URI:
   `http://localhost:3000/auth/callback`. Post-logout redirect: `http://localhost:5173`.
3. Certificates & secrets → create a client secret. Record its value (shown once) and its
   expiry — Entra client secrets expire (6–24 months is typical); put the renewal date on a
   calendar, since an expired secret fails every login with no advance warning.
4. App roles → create exactly three, **Value** set to the literal strings `admin`, `architect`,
   `viewer` (must match `Role` in `apps/api-py/src/canvas_api/auth/roles.py` exactly — this is
   what lets `canvas_api/auth/oidc.py`'s `map_idp_roles_to_user_role` work with no mapping table).
   Allowed member type: Users/Groups.
5. Token configuration → add the optional claim **`email`** to the ID token (without it, work/
   school accounts without a `mail` attribute set often have no usable email claim at all —
   `extract_identity` falls back to `preferred_username` only when it looks like an
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
# apps/api-py/.env — see .env.example's own comment on these four
OIDC_ISSUER_URL=https://login.microsoftonline.com/<tenant-id>/v2.0
OIDC_CLIENT_ID=<canvas-dev app registration's Application (client) ID>
OIDC_CLIENT_SECRET=<the client secret value from step 3>
OIDC_REDIRECT_URI=http://localhost:3000/auth/callback
```

The `/v2.0` suffix is **required** — `canvas_api/config.py`'s `validate_oidc_issuer_url()` rejects
a bare tenant path or the v1 endpoint (`https://sts.windows.net/<tenant-id>/`) at startup with a
clear error, since the v1 token shape has no flat top-level `roles` claim. The multi-tenant
aliases (`/common`, `/organizations`, `/consumers`) are rejected the same way — this app always
authenticates against one specific tenant. Restart the API to pick up the new settings (OIDC
discovery runs once, at the first sign-in) — `LoginForm.tsx` then shows a "Sign in with SSO" link.

Role mapping (`canvas_api/auth/oidc.py`'s `extract_entra_roles`/`map_idp_roles_to_user_role`) reads the
flat top-level `roles` claim on the ID token and re-syncs it on every login — Entra is the source
of truth once a user signs in via SSO, so a role change there (or in the app's role assignments)
takes effect on that user's very next login, not just at some later manual re-provisioning step.
Identity matching stays **email-only** (no `oid`/`tid` column) — a deliberate, smallest-change
decision made for this migration, same risk profile this app already accepted under Keycloak.
Emails are lowercased before lookup (Entra can return mixed case; Postgres/SQLite string equality
is case-sensitive). A user with none of `admin`/`architect`/`viewer` in `roles` defaults to
`viewer` (least privilege) — in practice this rarely fires, since "Assignment required = Yes"
above already prevents an unassigned user from getting a token at all.

**Testing posture — unit/contract only, no live-tenant E2E**: there is no browser test against a
real tenant (standing up a disposable cloud tenant per CI run is out of proportion, and MFA lives in
tenant Conditional Access policy, outside any test's reach). Instead,
`apps/api-py/tests/test_auth_oidc.py` drives the real `/auth/login` → `/auth/callback` flow against
a fake identity provider answered in-process (a locally generated RS256 keypair's discovery
document, JWKS and signed ID tokens). It proves ID-token signature verification, `iss`/`aud`/`exp`/
nonce/state validation and role mapping without a live tenant. The **only** real-tenant
verification is the manual post-deploy checklist below.

`ALLOW_LOCAL_AUTH=true` still works alongside SSO — both entry points render whenever both are
configured; this is a genuine platform-wide, not-yet-revisited decision for a _deployed_
environment (see `infra/azure/modules/apiapp.bicep`'s own `allowLocalAuth` param comment — it
defaults `false` there specifically because Entra SSO is the intended only way in for that
deployment, kept as a param purely as an emergency break-glass switch).

**Rotating a secret on the Azure deployment** (the Entra client secret when it expires, an AI key,
the Postgres password): put the new value in place (`ENTRA_CLIENT_SECRET=…` / `CANVAS_*_API_KEY=…`,
or edit the file under `infra/azure/.secrets/`) and re-run `infra/azure/deploy.sh`. Don't only
`az keyvault secret set` it by hand: Container Apps caches a Key Vault reference's value for about
30 minutes, and a new revision does not refetch it. `deploy.sh` writes only the values that
changed, then points the affected `canvas-api`/job secrets at Key Vault again and restarts
`canvas-api`'s active revision (canvas-28j). A run that fails partway leaves the list of pending
secrets in `.secrets/pending-secret-refresh`, and the next run picks it up.

### No client secret: a federated credential (canvas-haz.9)

Instead of the app registration's client secret (which expires and has to be rotated), the API can
prove who it is with a token from its own managed identity (`canvas-identity`), which Entra trusts
through a **federated credential** on the app registration.

1. Deploy with `CANVAS_OIDC_CLIENT_AUTH=managed-identity ./deploy.sh` (cached in
   `.secrets/oidc-client-auth`, so later deploys keep it). `ENTRA_CLIENT_SECRET` is then not needed.
2. Run the `az ad app federated-credential create ...` command `deploy.sh` prints (issuer
   `https://login.microsoftonline.com/<tenant>/v2.0`, subject = the identity's object id, audience
   `api://AzureADTokenExchange`). Once per app registration; again only if `canvas-identity` is
   recreated.
3. Sign in to check, then delete the app registration's old client secret(s).

How it works: on each sign-in callback the API fetches the identity's token from the Container Apps
identity endpoint (cached until shortly before it expires) and sends it as the
`client_assertion` (`jwt-bearer`) in the token request -- no `client_secret`. Covered by
`apps/api-py/tests/test_auth_oidc.py`, and verified live on 2026-11-04 (Azure switched to Entra with
`managed-identity`, an Entra user signed in, then switched back to `AUTH_MODE=local`). The federated
credential `canvas-api-managed-identity` is on the app registration; the old client secret is still there.
Back to a secret: `CANVAS_OIDC_CLIENT_AUTH=secret ENTRA_CLIENT_SECRET=... ./deploy.sh`.

### Entra groups (canvas-2h2w.3)

With `ENTRA_GROUPS=true` (deploy.sh `CANVAS_ENTRA_GROUPS=true`, cached in `.secrets/entra-groups`) people
can share a project or diagram with an Entra **group**. Only groups assigned to the Canvas enterprise
application are offered, and only with Entra sign-in (it does nothing with `AUTH_MODE=local`). One-time
setup, by someone who can change the app registration and a tenant admin for the consent:

1. **Groups in the sign-in token**: `az ad app update --id <client-id> --set groupMembershipClaims=ApplicationGroup`.
   The ID token then carries a `groups` claim with the person's groups *that are assigned to the app*. At
   each sign-in Canvas stores them (`user_group_memberships`), so a change in Entra applies at the person's
   next sign-in (and a removal keeps working until their session ends, up to 8 hours).
2. **The group picker reads Microsoft Graph** with an app-only token (client credentials, the same
   secret or managed-identity credential as sign-in): add Graph's **Application.Read.All** application
   permission (`az ad app permission add --id <client-id> --api 00000003-0000-0000-c000-000000000000
   --api-permissions 9a5d68dd-52b0-4cc2-bd40-abcf44ac3a30=Role`) and grant admin consent
   (`az ad app permission admin-consent --id <client-id>`). It lists the app's assignments
   (`servicePrincipals/{id}/appRoleAssignedTo`), groups only, cached 5 minutes.
3. **Assign the groups** people may share with to the Canvas enterprise application (Entra portal →
   Enterprise applications → Canvas → Users and groups). With "Assignment required" on (it is), members of
   an assigned group can also sign in; give the group an app role (usually `viewer` or `architect`).

deploy.sh prints these commands when the setting is on. Without the consent, `GET /groups` answers 503
("Couldn't list the groups from Microsoft") and the API log says which Graph call was refused. A group
share sends no notification (Canvas only knows members who have signed in). If someone is in more than
200 assigned groups Entra leaves the claim out; Canvas then keeps their previous memberships and logs a
warning. Tested against a fake Graph (`tests/test_entra_groups.py`); verify live with Azure on
`AUTH_MODE=entra`, as for canvas-haz.9.

### Manual post-deploy live verification (Entra, Phase 7 of canvas-haz)

Nothing above is a substitute for actually trying this against the real deployed Azure
environment once — the contract test proves the _code's_ validation logic; it can't prove the
_tenant's_ app registration, role assignments, or redirect-URI list are configured correctly. Work
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
cd apps/api-py
nohup uv run --env-file .env uvicorn canvas_api.main:app --port 3000 > /tmp/api-dev.log 2>&1 &
disown
cd ../..
nohup npm run dev --workspace=@canvas/web > /tmp/web-dev.log 2>&1 &
disown
curl -s http://localhost:3000/health   # {"status":"ok"} once ready
```

The API reads only its environment: if it fails at start-up with a validation error naming
`DATABASE_URL` or `SESSION_SECRET`, the `--env-file` was missing or not found from the current
directory.

## Live editing (canvas-vvi)

People with the same diagram open see each other's changes as they're made, over a WebSocket,
`WS /diagrams/{id}/live` (design and messages: `docs/live-editing-design.md`).

- **One API process.** Each open diagram's live session is kept in the API's memory. Run one uvicorn
  process with no `--workers`, and one replica: Azure's canvas-api has `maxReplicas: 1`. More than one
  would need the sessions shared (not built: Postgres LISTEN/NOTIFY would do).
- **Origins.** The browser's `Origin` must be one of `WEB_ORIGINS`, or the API's own host (the
  same-origin build in Azure). Anything else is refused, since a WebSocket isn't covered by CORS.
- **Restarts.** A deploy, a restart or scale-to-zero drops every connection. Editors reconnect on
  their own and keep their changes. A session whose last person has gone loses its unsaved changes,
  as a closed tab does.
- **Proxies.** Anything in front of the API must pass WebSocket upgrades. Container Apps ingress does
  (`transport: auto`). Editors ping every 25 s, well inside its idle timeout of about 4 minutes.
- **Not connected.** If the connection can't be made, the editor works as before: one person at a
  time, with the "someone saved a newer version" check on Save.

## GitHub approval (canvas-3s5)

Setup for admins is in `docs/admin-guide/github.md`; the design is in `docs/github-approval-design.md`.

- **Local:** set `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` (the PEM, or base64 of it) in
  `apps/api-py/.env`. Use a test App installed on a sandbox repository only. Without them the feature is
  off and hidden.
- **Azure:** `CANVAS_GITHUB_APP_ID=<id> CANVAS_GITHUB_APP_PRIVATE_KEY_FILE=<pem> ./deploy.sh` once;
  both are cached in `infra/azure/.secrets/`. The key goes to Key Vault as `github-app-private-key`.
- **Rotating the key:** generate a new private key in the App's settings, re-run deploy.sh with
  `CANVAS_GITHUB_APP_PRIVATE_KEY_FILE` pointing at it (the secret-refresh step restarts canvas-api
  and updates the sync job), then delete the old key in GitHub.
- **Status sync:** the `canvas-github-sync` job runs `python -m canvas_api.github.sync_run` in the
  canvas-api-py image every 15 minutes (only deployed when an App id is set). Run it now with
  `az containerapp job start --name canvas-github-sync --resource-group canvas-rg`; locally,
  `uv run --env-file .env python -m canvas_api.github.sync_run` in `apps/api-py`. pause.sh
  moves its schedule to once a year and resume.sh restores it. The image carries the CI validator
  bundle (`CANVAS_VALIDATOR_DIR`).
- **Troubleshooting:** a submission's `last_sync_error` and a link's `last_check_error`
  (`diagram_submissions`, `github_links`) hold GitHub's last error; "Needs attention" on the admin
  page means the App lost access (uninstalled, or the repository removed from the installation).
  Use the admin page's **Test** to see which permission or resource is missing.
- **Tests** run against an in-process fake GitHub (`apps/api-py/tests/fake_github.py`); the e2e
  suite runs it as its own process (`tests/fake_github_server.py`). No real GitHub is contacted.
- **Rate limits** (canvas-3s5.4): reads send If-None-Match with the last ETag (a 304 doesn't count
  against GitHub's limit). After a rate-limit answer (429, or 403 with no requests remaining or the
  secondary-limit message) the client sends nothing until GitHub's `retry-after` /
  `x-ratelimit-reset` time (60 s if neither), and the sync job stops its batch; the rest are picked
  up on the next run. The submission's `last_sync_error` says when Canvas will try again.
- **Live checklist** (first run 2026-10-25 against `muirjc/arch_as_code`, App `canvasdiagramapp`,
  all passed). Repeat after changing the App, its permissions or the GitHub code:
  1. Admin → GitHub shows the App connected and the installation; **Test** on a link passes all
     five checks.
  2. Submit a diagram: a PR opens, authored by `<app>[bot]`, commit trailer
     `Co-authored-by: <name> <email>`, with README / SVG / `.mmd` / `.canvas.mmd` / `canvas.json` /
     `.canvas/standards/...` / `.canvas/validator.mjs`.
  3. `node .canvas/validator.mjs` on a clone of the PR branch passes; the repository's
     _Canvas diagrams_ workflow passes (Validate + Architecture gate) with findings annotated.
  4. Edit + **Push update to PR #n**: same PR, new commit on top.
  5. With the PR open, **Refresh** in the Approval tab shows the checks; a "Request changes"
     review shows as changes requested.
  6. Merge it: the chip shows **Approved (version N)** after a refresh; the audit log has
     `diagram_submission_merged`. A submit after that opens a new PR.
  7. **Withdraw** an open PR: it closes unmerged on GitHub with "Withdrawn in Canvas by <name>".
  8. Run the sync job once (`az containerapp job start --name canvas-github-sync ...`): it ends with
     "Synced pull requests: ..." and exit 0.
- **CI validator** (canvas-3s5.3): `packages/validator-cli`, bundled by esbuild into one file,
  `dist/validator.mjs` (`npm run build --workspace=@canvas/validator-cli`; the Dockerfile builds it
  into the image). Each submission commits it to `.canvas/validator.mjs`; unchanged content is a
  no-op in Git, so repositories only see a diff when the validator changes. It imports
  diagram-core's _source_ modules (not the package entry) to keep the icon libraries out. The API
  finds it at `CANVAS_VALIDATOR_DIR` or `packages/validator-cli/dist/`; when it's missing,
  submissions skip the file and the admin page says so. The example workflow
  (`packages/validator-cli/examples/canvas-diagrams.yml`) is served at
  `GET /admin/github/workflow-example`. Bump `packages/validator-cli/package.json`'s version when the
  validator's behaviour changes.

## Resetting state

- **Wipe and reseed the dev database**: SQLite: delete `apps/api-py/data/canvas.db` and run
  `npm run dev:local` (a new database is seeded). Postgres: `docker compose down -v && docker compose up -d`,
  then re-run the `seed_demo` job (it migrates first).
- **The e2e "Smoke Test" project** is cleared automatically before every local Playwright run
  (canvas-fbv): the global setup (`apps/web/tests/e2e/global-setup.ts`) runs the `e2e_reset` job,
  which permanently deletes every diagram in that seeded project (live or soft-deleted, with their
  chats and share grants), then `seed_demo`. Don't keep diagrams you care about in "Smoke Test". Skip
  it with `E2E_KEEP_DATA=1` (e.g. to inspect what the previous run left); CI never runs it (fresh
  database). Projects created by specs elsewhere are not touched. The global setup runs the jobs in
  `apps/api-py` with the settings of `apps/api-py/.env` (the database the local API uses, SQLite or Postgres);
  your shell's variables win over it (canvas-mywp).
- **Re-run seed only** (idempotent — matches existing users/project by email/name instead of
  duplicating): `uv run --env-file .env python -m canvas_api.jobs.seed_demo` in `apps/api-py`.
- **Purge now**: `uv run --env-file .env python -m canvas_api.jobs.purge --dry-run` lists what would
  go; drop `--dry-run` to delete.
- **Rebuild `diagram-core` after any change to `packages/diagram-core/src`**: `apps/web` resolves it
  via its **built** `dist/` output (npm workspace symlink to `packages/diagram-core`, whose
  `package.json` `main` points at `dist/`), not the TS source. A stale or missing `dist/` is the most
  common cause of `Cannot find module '@canvas/diagram-core'` or of edits appearing to "not take
  effect." The Python API has its own port and doesn't use `dist/`.

## Running tests locally

```bash
npm run build --workspace=@canvas/diagram-core    # once, before any web test run
npm run test --workspace=@canvas/diagram-core      # no external services needed
cd apps/api-py
uv run pytest                                      # Postgres: schema canvas_py in canvas_test on localhost:5433
TEST_DB_CLIENT=sqlite uv run pytest                # in-memory SQLite, no Postgres needed
uv run ruff check . && uv run ruff format --check . && uv run mypy
```

The Postgres tests need a `canvas_test` database. `docker compose` creates it the first time it starts
(`infra/postgres-init`, run only on a new data volume); a volume made before that needs it once:
`docker compose exec postgres createdb -U canvas canvas_test`. Each run recreates the `canvas_py`
schema inside it, so two Postgres pytest runs at once break each other. The diagram-core comparison
tests skip without Node and the bridge bundle (`npm run build --workspace=@canvas/diagram-bridge`);
see `apps/api-py/README.md`.

E2E (Playwright) needs the API running on port 3000 (see above). Playwright starts the Vite dev
server itself, and its global setup resets and seeds the "Smoke Test" project and sets
`E2E_PROJECT_ID`:

```bash
cd apps/web
npx playwright test                 # full suite
npx playwright test tests/e2e/import.spec.ts   # single file
RUN_PERF_TESTS=1 npx playwright test tests/e2e/canvas-performance.spec.ts   # opt-in perf test, excluded from CI
```

The AI specs need the API started with `AI_PROVIDER=mock`. Tests missing `E2E_PROJECT_ID` are
skipped, not failed.

## Performance telemetry (canvas-6upe)

The API sends OpenTelemetry traces to Azure **Application Insights** (`canvas-insights`, on the
`canvas-logs` workspace) whenever `APPLICATIONINSIGHTS_CONNECTION_STRING` is set; `deploy.sh` sets
it from the Bicep output. It uses the Azure Monitor OpenTelemetry distro
(`apps/api-py/src/canvas_api/telemetry.py`); each request is a span named after its route template
(`GET /diagrams/:id`). Under it: each SQL query (`SELECT postgresql`, the parameterised text, never
the values), each outbound HTTP call (GitHub, Entra, the AI providers) and app work (`render svg`,
`rasterize png`, `validate standard`, `ai chat` per model step). Diagram content, prompts, emails and
tokens are never recorded. Requests are sampled (about 5 traces a second, the distro's default); a
sampled request keeps all its child spans. `/health` (Azure's health probes, every few seconds) is
not recorded (`EXCLUDED_URLS`).

- **Where to look:** Azure portal -> Monitor -> Workbooks -> **Canvas performance** (per-route
  p50/p95/p99 and failures, key routes over 7 days, slowest SQL queries, outbound calls and app
  work, requests over 3 s, i.e. cold starts), or
  Application Insights -> Performance / Transaction search for one request's timeline.
- **Alert:** `canvas-key-route-p95` runs hourly and emails the admin (`adminEmail`; local auth mode)
  when open diagram / save / export / project list p95 > 2 s, or AI chat > 30 s (at least 5 requests).
- **Locally:** off unless you set `APPLICATIONINSIGHTS_CONNECTION_STRING` in `apps/api-py/.env`
  (for example to a separate dev Application Insights). Never on under tests.
- **Cost:** pay per GB ingested, 90-day retention; nothing is sent while the environment is paused.

## Python backend

The backend is `apps/api-py` (FastAPI, SQLAlchemy Core, Python 3.15, uv). It replaced the
TypeScript API (`apps/api`) route group by route group
([docs/python-backend-assessment.md](docs/python-backend-assessment.md)); the TypeScript code was
removed in phase 12 and its last version is at tag `typescript-api-final`
(`git show typescript-api-final:apps/api/...`). Old settings `TYPESCRIPT_API_URL`,
`TYPESCRIPT_ROUTE_GROUPS` and `TRUST_CLIENT_IP_HEADER` no longer exist, and deploy.sh refuses
`CANVAS_TYPESCRIPT_ROUTE_GROUPS`.

In Azure, the public `canvas-api` container app runs the `canvas-api-py` image. It serves the web
app (`WEB_DIST_DIR`, built into the image), the paused page (`CANVAS_PAUSED`, `PAUSED_PAGE_PATH`)
and every API route (`canvas_api/front_door/`), and allows credentialed cross-origin calls from
`WEB_ORIGINS` only (locally, the Vite dev server). It reads the client's address from the last
`X-Forwarded-For` entry. `pause.sh`/`resume.sh` set and clear `CANVAS_PAUSED` on canvas-api's
`api` container. Every Container Apps job runs the same image.

**diagram-core.** The server runs a Python port of diagram-core (`canvas_api/diagram_core/`):
parsing and serializing every family, validation, rendering, templates, the icon-library clean-up,
document embeds and the AI chat's tools. The browser still runs the TypeScript
`packages/diagram-core`, so the two must keep matching. The TypeScript **diagram-core bridge**
(`packages/diagram-bridge`) is a test-only reference: CI's Python tests start it
(`REQUIRE_BRIDGE=1`) and compare Python with it on the golden corpus and on random input; locally
those tests skip without Node and the built bundle. The app never calls it. A change to diagram-core
behaviour is made in both languages.

Tests and lint: see "Running tests locally" and [apps/api-py/README.md](apps/api-py/README.md).

## Known flakiness

- **E2E specs run with `workers: 1`** (`apps/web/playwright.config.ts`) because every spec shares
  one seeded project (`E2E_PROJECT_ID`) and several assert on its diagram count — parallel workers
  let one worker's diagram creation land between another worker's before/after count assertions.
  This was observed as a real CI failure (2-worker default on GitHub-hosted runners) even though
  it didn't reproduce locally with 4 workers. If you deliberately override `workers` to speed up a
  local run, expect the same class of flake to resurface.
- **Two Postgres pytest runs at once** break each other: each drops and recreates the `canvas_py`
  schema in `canvas_test`. Run one at a time, or use `TEST_DB_CLIENT=sqlite` for the second.
- **`@esbuild/linux-x64` optional dependency going missing** after `npm install` (breaks `tsx`):
  fix with `npm install esbuild --no-save`.

## CI (`.github/workflows/ci.yml`)

Three jobs, all required to pass before a PR can merge (branch protection on `main`):

| Job              | What it does                                                                                                                                                                                                                                                                                                 | Needs                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `lint-and-build` | `eslint .`, the licence check, and builds of `diagram-core`, `web` and `validator-cli`                                                                                                                                                                                                                       | —                                                                                               |
| `unit-tests`     | The Python suite (`uv run pytest`, `TEST_DB_CLIENT` from the matrix, `REQUIRE_BRIDGE=1`) as a `db-client: [postgres, sqlite]` matrix (`fail-fast: false`). The postgres leg also runs ruff, mypy and the `diagram-core`, `validator-cli` and `diagram-bridge` vitest suites, which have no database coupling | Postgres service container (`canvas_test` DB) — present for both legs, used by the postgres leg |
| `e2e-tests`      | Seeds with the `seed_demo` job, starts the fake GitHub and the Python API on port 3000 (`AI_PROVIDER=mock`), runs the full Playwright suite (which starts its own Vite dev server)                                                                                                                           | Postgres service container (`canvas` DB)                                                        |

The opt-in performance spec (`RUN_PERF_TESTS`) is intentionally **not** run in CI — shared-runner
timing variance makes it unreliable there; run it locally instead when performance work is in
scope.

On failure, the `e2e-tests` job uploads the Playwright HTML report as a build artifact
(`playwright-report`, 7-day retention) — download it from the failed run's Summary page for
screenshots/traces of the failing test.

### Pushing to `.github/workflows/*`

Pushing a change under `.github/workflows/` needs a token with the `workflow` scope, or `git push`
is rejected. The `gh` CLI's token on this machine has it since 2026-10-20 (`gh auth refresh -h
github.com -s workflow`); if a push is rejected again, re-run that, or use the GitHub MCP
`push_files` tool.

Every action in the workflows is pinned to a full commit SHA with its version as a trailing comment
(`uses: actions/checkout@<sha> # v7.0.1`, canvas-b4o). Pin new actions the same way;
`.github/dependabot.yml` opens a weekly grouped PR to move the pins forward, proposing only releases
at least 14 days old (`cooldown`).

## Branch protection

`main` (ruleset `main-protection`) requires these checks to pass: `lint-and-build`,
`unit-tests (postgres)`, `unit-tests (sqlite)`, `e2e-tests`, `secret-scan`, `sast-bearer` and
`sast-semgrep` — the last two added 2026-10-23, after #214–#216 merged with failing SAST jobs
(auto-merge only waits for _required_ checks). It also requires the PR branch to be up to date with
`main` ("strict" status checks), and blocks force-pushes/deletion. A SAST false positive therefore
has to be suppressed in the code with its reason (`// bearer:disable <rule>`, `// nosemgrep:
<rule>`); dismissing the GitHub alert alone doesn't make the job pass. No approving-review requirement is
configured (solo-maintainer setup) — see the repo's Rulesets settings to change this later if
collaborators join.

Branch protection/rulesets require the repo to be public on GitHub's free tier (Pro is required
to enable them on a private repo) — this repo is public for that reason.
