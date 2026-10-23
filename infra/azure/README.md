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
| API container app | `modules/apiapp.bicep` | External ingress **limited to the IP allow-list**, scale-to-zero (`min=0/max=1`). |
| DB migration job | `modules/migrationjob.bicep` | Manual-trigger, one-shot, same image as the API app. |
| Dev/demo seed job | `modules/seedjob.bicep` | Manual-trigger, **not run automatically** — creates a demo admin login. Not deployed in local mode (`AUTH_MODE=local`). |
| First-admin job (local mode only) | `modules/bootstrapadminjob.bicep` | `canvas-bootstrap-admin`: run by `deploy.sh` to create `CANVAS_ADMIN_EMAIL` with a one-time password from `.secrets/bootstrap-admin-password`; `reset-admin.sh` runs it in reset mode to recover a lone admin (RUNBOOK "Local accounts"). |
| Storage account (frontend) | `modules/storage.bicep` | Static website hosting enabled by `deploy.sh` (no ARM resource for that setting). **Storage firewall limited to the IP allow-list.** |

### Entra ID SSO / MFA (canvas-haz)

This environment authenticates via Microsoft Entra ID. It used to deploy a self-hosted Keycloak
Container App alongside the API instead (`canvas-ycu.1`) — removed by `canvas-haz`, which replaced
it entirely rather than running both. See `RUNBOOK.md`'s "Entra ID SSO" section for the full
one-time app-registration setup (this is a prerequisite for a working deployment, not something
this IaC provisions — see below for why) and `docs/solution-architecture-document.md`'s Decision
Log for the full rationale.

- **No in-environment IdP resource at all.** Entra's issuer (`login.microsoftonline.com`) is
  always public, unlike the self-hosted Keycloak this replaced (internal-ingress-only, needing its
  own Postgres database, a `canvas-api` `/idp/*` reverse proxy, and an internal/public issuer split
  in `apps/api/src/auth/oidc.ts` just to make a browser able to reach it at all). `apiapp.bicep`
  only needs a tenant ID and a client ID/secret to talk to Entra directly.
- **App registration setup is deliberately NOT part of this IaC.** Entra app registrations aren't
  Bicep/ARM resources this subscription's deployment identity should necessarily have permission to
  create or modify (Graph API write access for app registrations is a broader grant than this
  deployment otherwise needs) — the same "tenant/app-registration provisioning stays a manual,
  documented admin task" posture the project's own Entra requirements spec
  (`docs/Entra ID Auth & Authz Specification.md`) takes. Create the `canvas-azure` app registration
  once per environment (RUNBOOK.md), then pass its tenant ID/client ID/client secret to `deploy.sh`
  via `ENTRA_TENANT_ID`/`ENTRA_CLIENT_ID`/`ENTRA_CLIENT_SECRET`.
- **Redirect URIs are a manual post-deploy step, every time the environment's addresses change**
  (a from-scratch redeploy gets new addresses — the Container Apps environment's own default domain
  and the Storage static website's hostname are both assigned at creation time). `deploy.sh` prints
  the exact two URIs to register (the API's `/auth/callback` and the frontend's own origin, serving
  as both the sign-in redirect and the post-logout target — Entra has one Redirect URIs list per
  app registration, not separate lists the way Keycloak did) plus a ready-to-paste
  `az ad app update --web-redirect-uris` command, rather than attempting to automate it via Graph
  API (same reasoning as the app-registration-provisioning point above).
- **`allowLocalAuth` still defaults to `false`** (`apiapp.bicep`) — Entra ID sign-in (with whatever
  Conditional Access/MFA policy the tenant enforces for this app) is required by default. Kept as a
  param, not hardcoded, purely as an emergency break-glass switch (e.g. the tenant itself is
  unreachable); flipping it back to `true` should never be a standing configuration.
- **Real user/role provisioning** (which user gets which of `admin`/`architect`/`viewer`,
  `apps/api/src/auth/types.ts`'s `UserRole`, matched 1:1 by the app registration's own App Roles)
  happens entirely in the Entra portal — assigning a user or group an app role, and requiring
  "Assignment required = Yes" on the Enterprise Application for fail-closed authorization. No
  provisioning script or Container Apps Job exists for this (replacing the former
  `canvas-keycloak-users` job and `infra/keycloak/create-users.mjs`) — Entra's own admin surfaces
  already cover it, and scripting against Graph API's user/approleassignment endpoints would be
  real, unnecessary scope for what the portal already does in a few clicks per user.

## Architecture decisions (and why)

- **Split-origin frontend, not one container.** ADP builds its React frontend into the *same*
  container as its API and serves it via static-file mounting — a same-origin architecture with
  no CORS/cookie complexity. canvas keeps its **existing** split-origin topology instead
  (frontend on Storage static website, API on Container Apps, different hostnames) — the
  `COOKIE_SECURE`/`COOKIE_SAME_SITE=none` path `docs/azure-deployment.md` already implements and
  documents is proven and working; merging the two into one container would be a much larger,
  riskier change than this bead's own scope.
- **Container Apps, not App Service**, for the API — matches ADP's proven pattern exactly
  (`pause.sh`/`resume.sh` both operate on `az containerapp update --min-replicas`).
- **Single Postgres admin login** for both server administration and the app's own connection —
  matches ADP's own deliberate simplification (and canvas's `docker-compose.yml`, which already
  uses one `canvas` user for everything). Not a best practice to copy uncritically — revisit if
  this deployment ever needs finer-grained DB access control.
- **`ALLOW_LOCAL_AUTH=false` by default** (`apiapp.bicep`'s `allowLocalAuth` param) — this
  deployment authenticates via Microsoft Entra ID, so SSO (+ whatever Conditional Access/MFA policy
  the tenant enforces) is required to sign in. See the Entra ID SSO section above for the
  break-glass caveat.

## First deploy

Prerequisite: the `canvas-azure` Entra app registration already exists (RUNBOOK.md's "Entra ID
SSO" section has the one-time setup steps) — its tenant ID/client ID/client secret are needed
below.

Prerequisite: **the IP allow-list** (canvas-cng). Create `infra/azure/.secrets/allowed-ips`
(gitignored) with one `CIDR description` per line — IPv4 only; write a single address as `/32`:

```
35.134.31.56/32   jmuir home
```

`deploy.sh` applies it to both the API's ingress and the web app's Storage account (the static
website), so the whole app is reachable only from those networks — Entra sign-in still applies on
top (`docs/ip-allowlist-security-plan.md`, option A). The machine running `deploy.sh` must be on the
list (it uploads the web app to Storage; the script checks). If the file is missing but `canvas-api`
exists, it's recreated from the live rules; with neither, the script refuses to deploy a public
environment unless `CANVAS_ALLOW_PUBLIC=1`.

```bash
az login
cd infra/azure
ENTRA_CLIENT_ID=<app registration's client ID> \
ENTRA_CLIENT_SECRET=<app registration's client secret, first run only -- cached afterward> \
./deploy.sh              # defaults to centralus -- eastus2 hit repeated Postgres
                          # SkuNotAvailable for Standard_B1ms (2026-10-08).
```

Without a terminal to answer the confirmation prompt (e.g. Claude Code driven from a phone,
canvas-7zw), split it into two explicit commands:

```bash
ENTRA_CLIENT_ID=<id> ./deploy.sh --what-if-only   # read-only: what-if, then exit (no Key Vault
                                                  # writes, no image build, no deployment)
ENTRA_CLIENT_ID=<id> ./deploy.sh --yes            # apply without prompting, once the what-if
                                                  # has been reviewed
```

**Canvas-managed accounts instead of Entra** (canvas-ez1, `AUTH_MODE=local`): no app registration
needed; the allow-list becomes mandatory (`CANVAS_ALLOW_PUBLIC=1` doesn't override it), and the
first admin is created for you with a one-time password in `.secrets/bootstrap-admin-password`:

```bash
CANVAS_AUTH_MODE=local CANVAS_ADMIN_EMAIL=<you> ./deploy.sh --what-if-only
CANVAS_AUTH_MODE=local CANVAS_ADMIN_EMAIL=<you> ./deploy.sh --yes
```

Both values are cached in `.secrets/`, so later runs are just `./deploy.sh` (no `ENTRA_CLIENT_ID`).
Setting it up, managing people, a locked-out lone admin (`./reset-admin.sh`), rotating the MFA key
and switching back: [RUNBOOK.md → Local accounts](../../RUNBOOK.md#local-accounts-canvas-ez1-option-b).

This is a **two-pass bootstrap** on a genuine from-scratch environment, same shape ADP's own
`deploy.sh` documents: Key Vault doesn't exist yet on run 1, so secret *values* can't be
pre-seeded into it, so the API container app module (which references those secrets by name at
provisioning time) fails that first run. **This is expected** — re-run `./deploy.sh` once Key
Vault exists and it completes normally.

`deploy.sh`:
1. Generates + locally caches (`infra/azure/.secrets/`, gitignored, chmod 600) the Postgres admin
   password and `SESSION_SECRET` on first run (the Entra client secret is cached the same way, but
   supplied by you via `ENTRA_CLIENT_SECRET`, not generated — Entra creates it, not this script),
   so re-running doesn't rotate credentials out from under an already-running server.
2. Pre-seeds Key Vault secret *values* (never in the Bicep template/deployment parameters).
3. Builds + pushes the API image to ACR, tagged with the git short SHA — **not** a floating
   `:latest`, which Container Apps' revision diffing treats as a no-op even when the underlying
   digest changed (a real gotcha ADP hit).
4. Runs `az deployment sub what-if` (dry run) and asks for confirmation before applying
   (`--what-if-only` stops here; `--yes` skips the prompt).
5. Enables static website hosting on the Storage account (a data-plane setting with no ARM
   resource — see `modules/storage.bicep`'s own comment) and patches the API app's `WEB_ORIGINS`
   to the real URL as a second pass, since that URL isn't predictable ahead of the account
   actually existing.
6. Builds and uploads the frontend (`apps/web/dist`) to the Storage static website.
7. Starts the migration job.
8. Prints the exact redirect URIs to register on the `canvas-azure` app registration (see the
   Entra ID SSO section above) — a manual step this script deliberately doesn't automate.

Seed dev/demo data (**not** run automatically — creates a demo admin account with a published
local password, appropriate for a throwaway environment, not something a real deployment should
run unprompted):

```bash
az containerapp job start --name canvas-seed --resource-group canvas-rg
```

## Pause / resume (cheaper idle, keeps data)

```bash
./pause.sh    # shows a "Canvas is paused" page, stops Postgres compute, drops canvas-api to
              # scale-to-zero-eligible. Keeps all data.
./resume.sh   # starts Postgres, restores scale, polls until Postgres is Ready, then puts the app back.
```

While paused, the web site serves `paused.html` instead of the app (canvas-vnh): `pause.sh` saves
the app's `index.html` in the `$web` container as `index.live.html` and uploads the paused page in
its place; `resume.sh` copies it back. Deep links show the paused page too (the site's 404 document
is `index.html`). Pausing twice keeps the saved app page, and `deploy.sh` (which can't run while
paused) removes any stale saved copy after publishing a new build.

Azure auto-restarts a stopped Postgres Flexible Server after 7 days if not resumed manually —
`pause.sh` prints this reminder every time.

## Driving it from Claude Code without a terminal (canvas-7zw)

Claude Code's auto mode blocks piping `y` into `deploy.sh`'s prompt, and Claude can't add its own
permission rules, so add these by hand once (`.claude/settings.local.json` at the repo root, or
`~/.claude/settings.json`), run from `infra/azure`:

```json
{
  "permissions": {
    "allow": [
      "Bash(./resume.sh*)",
      "Bash(./pause.sh*)",
      "Bash(ENTRA_CLIENT_ID=* ./deploy.sh --what-if-only*)",
      "Bash(ENTRA_CLIENT_ID=* ./deploy.sh --yes*)",
      "Bash(./deploy.sh --what-if-only*)",
      "Bash(./deploy.sh --yes*)"
    ]
  }
}
```

(The last two cover a local-mode environment, whose deploys need no `ENTRA_CLIENT_ID`.) Then a
deploy is: resume, `--what-if-only` (Claude shows you the plan), your approval in chat,
`--yes`, pause. `deploy.sh` runs `npm ci` locally, which stops a running local API dev server.

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
  apiImageTag="whatif-test" entraClientId="whatif-test"
```

`what-if` is a free, read-only dry run against the real Azure API — it validates every resource
type/API version/role-definition ID and shows exactly what would be created, without creating
anything. Run this before trusting a change to any module.
