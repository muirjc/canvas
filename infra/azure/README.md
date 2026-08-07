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
| Storage account (frontend) | `modules/storage.bicep` | Static website hosting enabled by `deploy.sh` (no ARM resource for that setting). |

**Not included**: Keycloak. That's `canvas-mi9` (Keycloak/MFA integration), separate follow-on
work. If/when it lands, it should add its own module here (mirroring ADP's own
`modules/keycloak.bicep` + `/auth` reverse-proxy pattern), not stand up a second, disconnected
resource group.

## Architecture decisions (and why)

- **Split-origin frontend, not one container.** ADP builds its React frontend into the *same*
  container as its API and serves it via static-file mounting — a same-origin architecture with
  no CORS/cookie complexity. canvas keeps its **existing** split-origin topology instead
  (frontend on Storage static website, API on Container Apps, different hostnames) — the
  `COOKIE_SECURE`/`COOKIE_SAME_SITE=none` path `docs/azure-deployment.md` already implements and
  documents is proven and working; merging the two into one container would be a much larger,
  riskier change than this bead's own scope.
- **Container Apps, not App Service**, for the API — matches ADP's proven pattern exactly
  (`pause.sh`/`resume.sh` both operate on `az containerapp update --min-replicas`), and is what
  `canvas-mi9`'s Keycloak integration will likely want too (an internal-ingress container +
  reverse proxy, the same shape ADP uses for Keycloac).
- **Single Postgres admin login** for both server administration and the app's own connection —
  matches ADP's own deliberate simplification (and canvas's `docker-compose.yml`, which already
  uses one `canvas` user for everything). Not a best practice to copy uncritically — revisit if
  this deployment ever needs finer-grained DB access control.
- **`ALLOW_LOCAL_AUTH=true` by default** (`apiapp.bicep`'s `allowLocalAuth` param) — with no OIDC
  provider configured yet (`canvas-mi9` hasn't landed), there is currently no other way to sign
  in at all. Revisit this default once Keycloak is the primary path.

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
   password and `SESSION_SECRET` on first run, so re-running doesn't rotate credentials out from
   under an already-running server.
2. Pre-seeds Key Vault secret *values* (never in the Bicep template/deployment parameters).
3. Builds + pushes the API image to ACR, tagged with the git short SHA — **not** a floating
   `:latest`, which Container Apps' revision diffing treats as a no-op even when the underlying
   digest changed (a real gotcha ADP hit).
4. Runs `az deployment sub what-if` (dry run) and asks for confirmation before applying.
5. Enables static website hosting on the Storage account (a data-plane setting with no ARM
   resource — see `modules/storage.bicep`'s own comment) and patches the API app's `WEB_ORIGINS`
   to the real URL as a second pass, since that URL isn't predictable ahead of the account
   actually existing.
6. Builds and uploads the frontend (`apps/web/dist`) to the Storage static website.
7. Starts the migration job.

Seed dev/demo data (**not** run automatically — creates a demo admin account with a published
local password, appropriate for a throwaway environment, not something a real deployment should
run unprompted):

```bash
az containerapp job start --name canvas-seed --resource-group canvas-rg
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
  apiImageTag="whatif-test"
```

`what-if` is a free, read-only dry run against the real Azure API — it validates every resource
type/API version/role-definition ID and shows exactly what would be created, without creating
anything. Run this before trusting a change to any module.
