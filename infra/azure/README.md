# canvas on Azure — Bicep IaC deployment

Proper, reproducible Azure deployment (canvas-ycu) — replaces `docs/azure-deployment.md`'s
hand-run `az` CLI steps with version-controlled infrastructure-as-code, a private (no public
network access) Postgres server, secrets in Key Vault, and pause/resume/destroy lifecycle
scripts. `docs/azure-deployment.md` is kept as a quicker, throwaway-demo-only path — this is the
one to use for anything longer-lived.

Modeled closely on a proven, production-deployed sibling project's own Azure stack
(`/home/jmuir/projects/ADP/infra/azure/`, different application stack, same target platform) —
see each module's own comment for exactly what was mirrored and what was adapted.

## What this deploys

One resource group (`canvas-rg` by default), from `main.bicep`:

| Resource | Module | Notes |
|---|---|---|
| Container Registry | `modules/acr.bicep` | Admin user disabled — images pulled via managed identity. |
| VNet + 2 delegated subnets + private DNS zone | `modules/network.bicep` | Postgres has **no public endpoint at all**. |
| Postgres Flexible Server | `modules/postgres.bicep` | Private/VNet-integrated, Burstable B1ms, 32GB, `pgcrypto` allow-listed. |
| Key Vault + user-assigned managed identity | `modules/keyvault.bicep` | RBAC-authorized. Secret *values* are set by `deploy.sh`, never in the template. |
| Container Apps environment | `modules/containerappsenv.bicep` | VNet-integrated, Log Analytics-backed. |
| API container app | `modules/apiapp.bicep` | External ingress, scale-to-zero (`min=0/max=1`). |
| DB migration job | `modules/migrationjob.bicep` | Manual-trigger, one-shot, same image as the API app. |
| Dev/demo seed job | `modules/seedjob.bicep` | Manual-trigger, **not run automatically** — creates a demo admin login. |
| Keycloak container app | `modules/keycloak.bicep` | **Internal-ingress only** — never reachable from a browser directly. Backed by its own `keycloak` database on the shared Postgres server. |
| Keycloak user-provisioning job | `modules/usersjob.bicep` | Manual-trigger, runs `infra/keycloak/create-users.mjs` against the admin REST API. Real user data (`KC_USERS`) is supplied per-invocation, never baked into the template. |
| Storage account (frontend) | `modules/storage.bicep` | Static website hosting enabled by `deploy.sh` (no ARM resource for that setting). |

### Keycloak / SSO / MFA (canvas-ycu.1)

`canvas-mi9` shipped the *code* integration (SSO login flow, role mapping, MFA enforcement —
verified against a real local Keycloak instance, see `RUNBOOK.md`'s "Keycloak SSO" section);
`canvas-ycu.1` adds Keycloak itself as a real Azure resource, closing the gap:

- **`modules/keycloak.bicep`**: internal-ingress-only container app (`external: false`), so a real
  browser can never reach it directly — mirrors ADP's own `modules/keycloak.bicep`. Always-warm
  (`minReplicas: 1`), unlike the API app's scale-to-zero, since Keycloak's own JVM cold start is
  much heavier. Runs `start --import-realm` against `infra/keycloak/CanvasRealm-realm.json`,
  baked into a custom image (`infra/keycloak/Dockerfile`) built by `deploy.sh`.
- **`/idp` reverse proxy, not `/auth`**: unlike ADP (which has no server-side auth routes of its
  own and can give Keycloak the whole `/auth` prefix), canvas's own API already owns `/auth/*` for
  its session routes (`/auth/login`, `/auth/callback`, `/auth/me`, ...). `apps/api/src/auth/
  idp-proxy.routes.ts` transparently forwards `/idp/*` to Keycloak's internal FQDN (a raw-buffer
  passthrough, including Keycloak's own login-form POSTs) — the browser only ever talks to the one
  already-public `canvas-api` hostname, avoiding a browser-facing-vs-backend-facing issuer URL
  mismatch, a real class of bug independently reproduced during this bead's own investigation (a
  Container Apps environment's own containers cannot reliably route to each other's *public*
  ingress FQDN from inside the environment).
- **Internal/public issuer split**: `OIDC_ISSUER_URL` is Keycloak's *public* address
  (`https://<api-fqdn>/idp/realms/CanvasRealm` — matches what Keycloak's own `KC_HOSTNAME` reports
  as its issuer claim, and what the browser is redirected to). `OIDC_INTERNAL_ISSUER_URL` and
  `KEYCLOAK_INTERNAL_URL` point the API's own *server-side* discovery/token/userinfo calls
  straight at Keycloak's internal FQDN instead (`apps/api/src/auth/oidc.ts`'s `customFetch`
  override) — calling its own public FQDN for those doesn't reliably work from inside the same
  Container Apps environment (confirmed live: the request can fail before the API process has
  even started listening on its own port, an ordering problem, not just an Azure quirk).
- **Real user provisioning, decided**: `infra/keycloak/CanvasRealm-realm.json`'s two seeded users
  are for local iteration only. `infra/keycloak/create-users.mjs` (mirrors ADP's
  `keycloak_create_users.py`, adapted for canvas's realm-*role* — not group — based access model)
  idempotently creates/updates real users against the admin REST API, assigns one of
  `admin`/`architect`/`viewer` as a realm role, and — carrying over the exact gotcha ADP's own
  script found — sets `requiredActions: ["CONFIGURE_TOTP"]` explicitly per user, since a realm's
  `requiredActions[].defaultAction` only applies to users created through Keycloak's own
  self-registration/first-login flow, never to users created via this admin-API POST. Run via the
  `canvas-keycloak-users` Container Apps Job (`modules/usersjob.bicep`) — see "First deploy" below.
- **`allowLocalAuth` now defaults to `false`** (`apiapp.bicep`) — Keycloak is deployed alongside
  the API app, so SSO + MFA is required to sign in by default. Kept as a param, not hardcoded,
  purely as an emergency break-glass switch (e.g. Keycloak itself is unreachable); flipping it back
  to `true` should never be a standing configuration, or MFA becomes silently bypassable.
- **Client secret reconciliation**: `infra/keycloak/CanvasRealm-realm.json`'s baked-in
  `canvas-api` client uses a placeholder secret and localhost redirect URI, correct for local
  `docker-compose` only. Keycloak's `--import-realm` is skip-if-exists, so a realm already imported
  from a prior `deploy.sh` run is never re-imported even after rebuilding the image with different
  values — `deploy.sh` instead PATCHes the running realm's client (redirect URI, web origin,
  secret) via the admin REST API on every run, so it always matches the real, now-known API FQDN
  and the same generated secret already pushed to Key Vault.

## Architecture decisions (and why)

- **Split-origin frontend, not one container.** ADP builds its React frontend into the *same*
  container as its API and serves it via static-file mounting — a same-origin architecture with
  no CORS/cookie complexity. canvas keeps its **existing** split-origin topology instead
  (frontend on Storage static website, API on Container Apps, different hostnames) — the
  `COOKIE_SECURE`/`COOKIE_SAME_SITE=none` path `docs/azure-deployment.md` already implements and
  documents is proven and working; merging the two into one container would be a much larger,
  riskier change than this bead's own scope.
- **Container Apps, not App Service**, for the API — matches ADP's proven pattern exactly
  (`pause.sh`/`resume.sh` both operate on `az containerapp update --min-replicas`), and is the same
  shape Keycloak itself now uses (an internal-ingress container + reverse proxy).
- **Single Postgres admin login** for both server administration and the app's own connection —
  matches ADP's own deliberate simplification (and canvas's `docker-compose.yml`, which already
  uses one `canvas` user for everything). Not a best practice to copy uncritically — revisit if
  this deployment ever needs finer-grained DB access control. Keycloak connects to its own
  `keycloak` database on the same server with this same admin login, not a separate role.
- **`ALLOW_LOCAL_AUTH=false` by default** (`apiapp.bicep`'s `allowLocalAuth` param) — Keycloak is
  deployed alongside the API app (`modules/keycloak.bicep`), so SSO + MFA is required to sign in.
  See the Keycloak section above for the break-glass caveat.

## First deploy

```bash
az login
cd infra/azure
./deploy.sh              # defaults to eastus2 -- see main.bicep's location param comment for
                          # why: this environment has hit real compute-quota restrictions in
                          # some regions before (docs/azure-deployment.md's own note).
```

This is a **two-pass bootstrap** on a genuine from-scratch environment, same shape ADP's own
`deploy.sh` documents: Key Vault doesn't exist yet on run 1, so secret *values* can't be
pre-seeded into it, so the API container app module (which references those secrets by name at
provisioning time) fails that first run. **This is expected** — re-run `./deploy.sh` once Key
Vault exists and it completes normally.

`deploy.sh`:
1. Generates + locally caches (`infra/azure/.secrets/`, gitignored, chmod 600) the Postgres admin
   password, `SESSION_SECRET`, the Keycloak admin password, and the OIDC client secret on first
   run, so re-running doesn't rotate credentials out from under an already-running server.
2. Pre-seeds Key Vault secret *values* (never in the Bicep template/deployment parameters).
3. Builds + pushes the API image **and** the Keycloak image to ACR, both tagged with the git short
   SHA — **not** a floating `:latest`, which Container Apps' revision diffing treats as a no-op
   even when the underlying digest changed (a real gotcha ADP hit).
4. Runs `az deployment sub what-if` (dry run) and asks for confirmation before applying.
5. Enables static website hosting on the Storage account (a data-plane setting with no ARM
   resource — see `modules/storage.bicep`'s own comment) and patches the API app's `WEB_ORIGINS`
   to the real URL as a second pass, since that URL isn't predictable ahead of the account
   actually existing.
6. Reconciles Keycloak's `canvas-api` client (redirect URI, web origin, secret) against the real,
   now-known API FQDN via the admin REST API — see the Keycloak section above for why this has to
   happen on every run, not just the first.
7. Builds and uploads the frontend (`apps/web/dist`) to the Storage static website.
8. Starts the migration job.

Seed dev/demo data (**not** run automatically — creates a demo admin account with a published
local password, appropriate for a throwaway environment, not something a real deployment should
run unprompted):

```bash
az containerapp job start --name canvas-seed --resource-group canvas-rg
```

Create real Keycloak users (**not** run automatically — real account data, so it's supplied
per-invocation, not baked into the template or state; see the Keycloak section above for what
`role` means and the MFA-enrollment caveat):

```bash
az containerapp job start --name canvas-keycloak-users --resource-group canvas-rg \
  --env-vars KC_USERS='[{"username":"jane","email":"jane@example.com","password":"...","role":"architect"}]'
```

## Pause / resume (cheaper idle, keeps data)

```bash
./pause.sh    # stops Postgres compute, drops canvas-api to scale-to-zero-eligible. Keeps all data.
./resume.sh   # starts Postgres, restores scale, polls until Postgres is actually Ready.
```

Azure auto-restarts a stopped Postgres Flexible Server after 7 days if not resumed manually —
`pause.sh` prints this reminder every time.

## Full teardown (destroys ALL data)

```bash
./destroy.sh
```

Requires typing the resource group name to confirm (not just y/N — this is full data loss).
Deletes the resource group, then separately **purges** the soft-deleted Key Vault — a plain
`az group delete` only soft-deletes it, and the name stays reserved (blocking the next deploy
with "vault already exists in deleted state") until purged. Local `.secrets/` is left intact so a
future rebuild reuses the same credentials.

## Verifying the templates without deploying

```bash
az bicep build --file main.bicep --stdout > /dev/null   # syntax check
az deployment sub what-if --name canvas-foundation-whatif --location eastus2 \
  --template-file main.bicep --parameters location=eastus2 \
  postgresAdminPassword="<any>" deployerPrincipalId="$(az ad signed-in-user show --query id -o tsv)" \
  apiImageTag="whatif-test" keycloakImageTag="whatif-test"
```

`what-if` is a free, read-only dry run against the real Azure API — it validates every resource
type/API version/role-definition ID and shows exactly what would be created, without creating
anything. Run this before trusting a change to any module.
