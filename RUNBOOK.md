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
| `MFA_REQUIRED` / `MFA_ENCRYPTION_KEY` | no | Two-step verification for Canvas-password accounts — see "Local accounts" below. |
| `LOGIN_RATE_LIMIT` | no | Password sign-in attempts per client IP per minute (default 20 in local mode, off otherwise). |
| `AUTH_MODE` | no (default `entra`) | `entra` or `local`. `local` serves only Canvas-managed email/password sign-in: local sign-in is forced on and the Entra routes are never registered, even if `OIDC_*` is set. See "Local accounts" below. |
| `ALLOW_LOCAL_AUTH` | no (default `false`) | Set `true` for local dev/demo — enables email/password login without OIDC. |
| `OIDC_ISSUER_URL` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` / `OIDC_REDIRECT_URI` | no | Leave blank locally; SSO routes are disabled when unset (logged at startup). See "Entra ID SSO" below to actually try it locally. |
| `WEB_ORIGINS` | no (default `http://localhost:5173`) | Comma-separated list of origins allowed to make credentialed CORS requests. |
| `COOKIE_SECURE` | no (default `false`) | Set `true` for a split-origin deployment (frontend and API on different hosts, e.g. Azure — see `docs/azure-deployment.md` for a quick demo, or `infra/azure/README.md` for a proper IaC deployment). Forced `true` automatically whenever `COOKIE_SAME_SITE=none`. |
| `COOKIE_SAME_SITE` | no (default `lax`) | `lax`/`none`/`strict`. Leave at the default for local dev and any same-origin deployment. `none` is required for a split-origin deployment — `lax` cookies are never attached to cross-site fetch/XHR calls. |
| `SESSION_IDLE_MINUTES` | no (default `480`) | A session unused for this long expires; the cookie's expiry is refreshed on every request. Sessions are stored in the database (`sessions` table), so they survive restarts. |
| `SESSION_MAX_HOURS` | no (default `12`) | A signed-in session ends this long after sign-in, however active. |
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

Running against SQLite with no Postgres/Docker at all (`better-sqlite3` won't create a missing
parent directory on its own, so create `data/` first if `DATABASE_URL` points inside it):

```bash
mkdir -p data
# apps/api/.env
DB_CLIENT=sqlite
DATABASE_URL=./data/canvas.db   # or :memory: for a throwaway database
SESSION_SECRET=...
ALLOW_LOCAL_AUTH=true

npm run migrate --workspace=@canvas/api
npm run seed --workspace=@canvas/api
npm run dev --workspace=@canvas/api
```

Every `apps/api` script above (`dev`/`migrate`/`seed`/`seed:catalog`/`purge`) loads
`apps/api/.env` itself via Node's native `--env-file-if-exists` flag — populating that file is
enough, no shell export step needed on any platform.

### Running on Windows without Docker

Enterprise laptops that don't support Docker (or WSL2) can still run Canvas — SQLite mode above
needs neither. The same steps, PowerShell-flavored:

```powershell
git clone <repo> ; cd canvas
npm install                                              # see note below
npm run build --workspace=@canvas/diagram-core           # must precede api/web build or run
Copy-Item apps/api/.env.example apps/api/.env
# edit apps/api/.env: DB_CLIENT=sqlite, DATABASE_URL=./data/canvas.db, ALLOW_LOCAL_AUTH=true,
# SESSION_SECRET=<any 32+ character string>
New-Item -ItemType Directory -Force data
npm run migrate --workspace=@canvas/api
npm run seed --workspace=@canvas/api                     # prints admin login + a demo project id
npm run dev --workspace=@canvas/api                      # separate terminal
npm run dev --workspace=@canvas/web                      # separate terminal
```

Sign in at `http://localhost:5173/?projectId=<seed-printed-id>` with `admin@example.com` /
`admin-dev-password` and create a diagram to confirm everything actually works end to end.

**The one real unknown on Windows: `npm install`'s handling of `better-sqlite3`.** Watch its
output closely the first time:
- No `gyp info`/`node-gyp rebuild` chatter for `better-sqlite3` → its bundled `prebuilds/win32-*`
  binary loaded cleanly, no compiler needed. Proceed as normal.
- If `node-gyp rebuild` runs and fails (missing Visual Studio Build Tools / Python) — this
  project's own `infra/azure/Dockerfile` independently hit exactly this on a clean Linux
  container build (see its header comment) — try `npm install --ignore-scripts` next: it skips
  npm's implicit native-rebuild attempt, and the actual `.node` file `better-sqlite3` needs is
  already bundled in the published package regardless of whether that rebuild step runs. Re-check
  with `node -e "require('better-sqlite3')"`.
- If that still fails, the remaining fallback (installing the VS Build Tools C++ workload +
  Python) likely needs admin rights not available on a locked-down machine — don't assume it's
  installable; this is the point to escalate rather than keep guessing.

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

## Real AWS icons (optional)

The AWS icon library ships as placeholder artwork. AWS's real icons aren't committed (public repo;
AWS's terms only explicitly cover using them to create diagrams), so each environment can generate
them from its own copy of AWS's icon package. The steps are in [`vendor-icons/README.md`](vendor-icons/README.md):
download the package, run `packages/diagram-core/scripts/generate-aws-icons.mjs`, then re-run the
catalog seed. For Azure, generate the file before running `infra/azure/deploy.sh`; the image copies
`vendor-icons/` and the catalog-seed job loads it. Diagrams keep working either way: both libraries
use the same `aws-icons@2024.1` version and icon ids.

## API documentation

Set `ENABLE_API_DOCS=true` in `apps/api/.env` and restart the API dev server to serve an
interactive OpenAPI/Swagger UI at `http://localhost:3000/docs` (raw spec at `/docs/json`). Lists
every registered route (47 as of this writing); request/response body schemas are not yet
annotated for most routes (tracked as `canvas-lfc`) — for the authoritative shape of any given
endpoint not yet schema-annotated, see its `apps/api/src/**/*.routes.ts` source or matching
`apps/api/tests/contract/*.test.ts`. Left `false` by default (same opt-in posture as
`ALLOW_LOCAL_AUTH`) so a real deployment doesn't expose its full route surface unintentionally —
deliberately turn it on for that environment if you want it there too.

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

| | `entra` (default) | `local` |
|---|---|---|
| Who keeps the accounts | Your Entra tenant (app roles admin/architect/viewer) | Canvas (Admin → Users) |
| Sign-in | Entra, with its own MFA/Conditional Access | Email + password, then an authenticator code |
| Needs | An app registration (`ENTRA_CLIENT_ID`/`SECRET`) | Nothing external; the IP allow-list is **mandatory** |
| First admin | Whoever has the admin app role | Created by `deploy.sh` from `CANVAS_ADMIN_EMAIL` |
| Use it when | You have an Entra tenant | You don't, or want Canvas self-contained |

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
BOOTSTRAP_ADMIN_PASSWORD=... npm run bootstrap-admin --workspace=@canvas/api`.

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

| Setting | Default | |
|---|---|---|
| `AUTH_MODE` | `entra` | `local` = Canvas accounts only; forces local sign-in on and ignores `OIDC_*`. |
| `MFA_REQUIRED` | on in local mode | Off elsewhere; dev accounts can opt in from the account screen. |
| `MFA_ENCRYPTION_KEY` | derived from `SESSION_SECRET` (dev) | Base64, 32 bytes; required in production local mode. |
| `LOGIN_RATE_LIMIT` | 20 in local mode, else off | Password sign-ins per client IP per minute; keyed on the last `X-Forwarded-For` entry (unspoofable behind Azure's ingress); in memory (single replica). |

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
`tests/contract/oidc-callback.test.ts`; not yet verified live (Azure runs `AUTH_MODE=local` today).
Back to a secret: `CANVAS_OIDC_CLIENT_AUTH=secret ENTRA_CLIENT_SECRET=... ./deploy.sh`.

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

## GitHub approval (canvas-3s5)

Setup for admins is in `docs/admin-guide/github.md`; the design is in `docs/github-approval-design.md`.

- **Local:** set `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` (the PEM, or base64 of it) in
  `apps/api/.env`. Use a test App installed on a sandbox repository only. Without them the feature is
  off and hidden.
- **Azure:** `CANVAS_GITHUB_APP_ID=<id> CANVAS_GITHUB_APP_PRIVATE_KEY_FILE=<pem> ./deploy.sh` once;
  both are cached in `infra/azure/.secrets/`. The key goes to Key Vault as `github-app-private-key`.
- **Rotating the key:** generate a new private key in the App's settings, re-run deploy.sh with
  `CANVAS_GITHUB_APP_PRIVATE_KEY_FILE` pointing at it (the secret-refresh step restarts canvas-api
  and updates the sync job), then delete the old key in GitHub.
- **Status sync:** the `canvas-github-sync` job runs `node apps/api/dist/github/sync-run.js` every
  15 minutes (only deployed when an App id is set). Run it now with
  `az containerapp job start --name canvas-github-sync --resource-group canvas-rg`; locally,
  `npm run github-sync --workspace=@canvas/api`. pause.sh moves its schedule to once a year and
  resume.sh restores it.
- **Troubleshooting:** a submission's `last_sync_error` and a link's `last_check_error`
  (`diagram_submissions`, `github_links`) hold GitHub's last error; "Needs attention" on the admin
  page means the App lost access (uninstalled, or the repository removed from the installation).
  Use the admin page's **Test** to see which permission or resource is missing.
- **Tests** run against `apps/api/tests/helpers/fake-github.ts`; no real GitHub is contacted.
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
     *Canvas diagrams* workflow passes (Validate + Architecture gate) with findings annotated.
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
  diagram-core's *source* modules (not the package entry) to keep the icon libraries out. The API
  finds it at `CANVAS_VALIDATOR_DIR` or `packages/validator-cli/dist/`; when it's missing,
  submissions skip the file and the admin page says so. The example workflow
  (`packages/validator-cli/examples/canvas-diagrams.yml`) is served at
  `GET /admin/github/workflow-example`. Bump `packages/validator-cli/package.json`'s version when the
  validator's behaviour changes.

## Resetting state

- **Wipe and reseed the dev database**: `docker compose down -v && docker compose up -d`, then
  re-run `migrate` and `seed`.
- **The e2e "Smoke Test" project** is cleared automatically before every local Playwright run
  (canvas-fbv): the global setup runs `npm run e2e:reset --workspace=@canvas/api`, which
  permanently deletes every diagram in that seeded project (live or soft-deleted, with their chats
  and share grants), then re-seeds. Don't keep diagrams you care about in "Smoke Test". Skip it
  with `E2E_KEEP_DATA=1` (e.g. to inspect what the previous run left); CI never runs it (fresh
  database). Projects created by specs elsewhere are not touched.
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

## Performance telemetry (canvas-6upe)

The API sends OpenTelemetry traces and metrics to Azure **Application Insights** (`canvas-insights`,
on the `canvas-logs` workspace) whenever `APPLICATIONINSIGHTS_CONNECTION_STRING` is set; `deploy.sh`
sets it from the Bicep output. Each request is a span named after its route template
(`GET /diagrams/:id`) with the user's opaque id and role; child spans time every SQL query (the
parameterised text only, never values), rendering (`render svg`, `rasterize png`), standards
validation, AI chat turns (with token counts) and outbound HTTP (AI providers, GitHub, Entra).
Diagram content, prompts, emails and tokens are never recorded. Log lines carry `trace_id`.

- **Where to look:** Azure portal -> Monitor -> Workbooks -> **Canvas performance** (per-route
  p50/p95/p99 and failures, key routes over 7 days, slowest SQL, outbound calls, requests over 3 s,
  i.e. cold starts), or Application Insights -> Performance / Transaction search for one request's
  timeline.
- **Alert:** `canvas-key-route-p95` runs hourly and emails the admin (`adminEmail`; local auth mode)
  when open diagram / save / export / project list p95 > 2 s, or AI chat > 30 s (at least 5 requests).
- **Locally:** off unless you set `APPLICATIONINSIGHTS_CONNECTION_STRING` in `apps/api/.env` (for
  example to a separate dev Application Insights). `TELEMETRY=off` forces it off;
  `TELEMETRY_SAMPLING_RATIO` (0-1, default 1) samples. Never on under tests.
- **Cost:** pay per GB ingested, 90-day retention; nothing is sent while the environment is paused.

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
(auto-merge only waits for *required* checks). It also requires the PR branch to be up to date with
`main` ("strict" status checks), and blocks force-pushes/deletion. A SAST false positive therefore
has to be suppressed in the code with its reason (`// bearer:disable <rule>`, `// nosemgrep:
<rule>`); dismissing the GitHub alert alone doesn't make the job pass. No approving-review requirement is
configured (solo-maintainer setup) — see the repo's Rulesets settings to change this later if
collaborators join.

Branch protection/rulesets require the repo to be public on GitHub's free tier (Pro is required
to enable them on a private repo) — this repo is public for that reason.
