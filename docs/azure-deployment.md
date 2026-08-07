# Deploying to Azure

A minimal, no-Dockerfile path to a working Canvas deployment on Azure: PostgreSQL Flexible
Server, an App Service (Linux, Node) for `apps/api`, and static-website hosting (Azure Storage)
for the built `apps/web` SPA. This is the split-origin topology — the frontend and API are on
different hostnames — which is why `COOKIE_SECURE`/`COOKIE_SAME_SITE` (see `RUNBOOK.md`) exist at
all; a same-origin deployment (both served from one host) doesn't need them.

This is a demo/throwaway-friendly path, not a hardened production topology. It has no CI/CD
wiring, no custom domain/TLS cert, and uses the platform's built-in free HTTPS on
`*.azurewebsites.net`.

## Prerequisites

- `az` CLI installed and logged in (`az login`) with a subscription that has Contributor access.
- Node 22 and Docker are not required on the deploying machine beyond what the repo's own
  `README.md` "Getting started" section already needs to build locally.

## 1. Resource group

```bash
az group create --name canvas-demo-rg --location eastus
```

If you hit `ERROR: The location is restricted from performing this operation` or a `0` VM quota
error on later steps, your subscription may have zero compute quota in that region — this is
common on subscriptions that have never requested a quota increase. Try `eastus2`, `westus2`,
`centralus`, or `westus3` for the compute-bearing resources (App Service Plan) specifically;
region choice for Postgres and the storage account is unaffected by this and doesn't need to
match.

## 2. PostgreSQL

```bash
az postgres flexible-server create \
  --resource-group canvas-demo-rg \
  --name canvas-demo-pg-<unique-suffix> \
  --location eastus2 \
  --admin-user canvasadmin \
  --admin-password '<generate one — do not reuse the local dev password>' \
  --sku-name Standard_B1ms \
  --tier Burstable \
  --storage-size 32 \
  --version 16 \
  --public-access 0.0.0.0-255.255.255.255 \
  --yes

az postgres flexible-server db create \
  --resource-group canvas-demo-rg \
  --server-name canvas-demo-pg-<unique-suffix> \
  --name canvas
```

**`--public-access 0.0.0.0-255.255.255.255` opens the server to the entire internet** (still
gated by the admin password) — acceptable for a throwaway demo, not for anything real. For a
longer-lived deployment, scope this to the App Service's actual outbound IPs instead
(`az webapp show --query outboundIpAddresses`) or put both behind a VNet.

Azure Database for PostgreSQL requires extensions to be explicitly allow-listed before a
migration can `CREATE EXTENSION` them — this repo's one migration-time extension is `pgcrypto`:

```bash
az postgres flexible-server parameter set \
  --resource-group canvas-demo-rg \
  --server-name canvas-demo-pg-<unique-suffix> \
  --name azure.extensions --value pgcrypto
```

Then run this repo's own migrate/seed scripts against it directly (`sslmode=require` is
mandatory — Azure Flexible Server rejects unencrypted connections):

```bash
DATABASE_URL="postgres://canvasadmin:<password>@canvas-demo-pg-<unique-suffix>.postgres.database.azure.com:5432/canvas?sslmode=require" \
SESSION_SECRET="<any real secret, >=32 chars>" \
npm run migrate --workspace=@canvas/api

DATABASE_URL="..." SESSION_SECRET="..." ALLOW_LOCAL_AUTH=true \
npm run seed --workspace=@canvas/api   # prints the seeded admin login + a project id
```

## 3. API — App Service

```bash
az appservice plan create \
  --resource-group canvas-demo-rg \
  --name canvas-demo-plan \
  --location westus2 \
  --is-linux --sku B1   # or F1 (free) for a pure throwaway demo

az webapp create \
  --resource-group canvas-demo-rg \
  --plan canvas-demo-plan \
  --name canvas-demo-api-<unique-suffix> \
  --runtime "NODE:22-lts"
```

App settings — **this is the split-origin cookie configuration** (see `RUNBOOK.md`):

```bash
az webapp config appsettings set \
  --resource-group canvas-demo-rg \
  --name canvas-demo-api-<unique-suffix> \
  --settings \
    DATABASE_URL="postgres://canvasadmin:<password>@canvas-demo-pg-<unique-suffix>.postgres.database.azure.com:5432/canvas?sslmode=require" \
    SESSION_SECRET="<the same secret used for migrate/seed>" \
    ALLOW_LOCAL_AUTH=true \
    COOKIE_SECURE=true \
    COOKIE_SAME_SITE=none \
    WEB_ORIGINS="https://<your-static-site-hostname>" \
    SCM_DO_BUILD_DURING_DEPLOYMENT=false \
    PORT=3000
```

`WEB_ORIGINS` needs the real static-site URL from step 4 — App Service app settings can be
updated any time after creation, so it's fine to set a placeholder now and correct it once that
URL is known (`az webapp restart` afterward to pick up the change).

**Build and deploy** — this is an npm-workspaces monorepo where `diagram-core` must build before
`api`; App Service's default Node buildpack doesn't know that, so this deploys pre-built output
instead of relying on a remote build:

```bash
npm ci
npm run build --workspace=@canvas/diagram-core
npm run build --workspace=@canvas/api

# Zip the whole repo (minus .git and dev-only artifacts) — simplest way to get real,
# non-symlinked node_modules/@canvas/diagram-core content into the package without hand-pruning
# what an npm workspace needs. `zip -r -y` (dereferencing symlinks) or an equivalent archiver
# that resolves the workspace symlink to real files both work.
zip -r -y api-deploy.zip . -x ".git/*" -x "apps/web/test-results/*" -x "apps/web/playwright-report/*"

az webapp deploy \
  --resource-group canvas-demo-rg \
  --name canvas-demo-api-<unique-suffix> \
  --src-path api-deploy.zip --type zip

# The deployed zip is the whole repo, not just apps/api, so there's no root "start" script for
# App Service to find by default -- point it at the real entry point explicitly.
az webapp config set \
  --resource-group canvas-demo-rg \
  --name canvas-demo-api-<unique-suffix> \
  --startup-file "node apps/api/dist/server.js"

az webapp restart --resource-group canvas-demo-rg --name canvas-demo-api-<unique-suffix>
```

Verify: `curl https://canvas-demo-api-<unique-suffix>.azurewebsites.net/health` → `{"status":"ok"}`.
**Use `https://`, not `http://`, everywhere this URL is used** — App Service gives free HTTPS by
default, and the static-hosted frontend (step 4) will refuse to call a plain-HTTP API as mixed
content once it's loaded over HTTPS itself.

## 4. Frontend — Storage static website

```bash
az storage account create \
  --resource-group canvas-demo-rg \
  --name canvasdemoweb<uniquesuffix> \
  --location westus2 --sku Standard_LRS --kind StorageV2 --allow-blob-public-access true

az storage blob service-properties update \
  --account-name canvasdemoweb<uniquesuffix> \
  --static-website --index-document index.html --404-document index.html \
  --auth-mode login   # falls back to --auth-mode key below if you lack a data-plane RBAC role

VITE_API_BASE_URL="https://canvas-demo-api-<unique-suffix>.azurewebsites.net" \
npm run build --workspace=@canvas/web

az storage blob upload-batch \
  --account-name canvasdemoweb<uniquesuffix> \
  --destination '$web' --source apps/web/dist \
  --auth-mode key --overwrite

az storage account show \
  --resource-group canvas-demo-rg --name canvasdemoweb<uniquesuffix> \
  --query "primaryEndpoints.web" -o tsv
```

If `--auth-mode login` fails with a permissions error, your account lacks a "Storage Blob Data
Contributor"-equivalent RBAC role on the storage account — `--auth-mode key` (uses the account's
access key, available to anyone with Contributor on the resource) works around this without
needing that role assignment.

Update the API's `WEB_ORIGINS` app setting (step 3) to this real URL, then
`az webapp restart` the API once more.

## 5. Verify end to end

Open the static site URL from step 4 in a browser and sign in with the admin credentials `seed`
printed in step 2. If login appears to succeed but the app immediately reports "Authentication
required" on the next screen, the session cookie isn't making it back to the API — check that
`COOKIE_SAME_SITE=none` and `COOKIE_SECURE=true` are actually set (step 3) and that the API URL
used to build the frontend was `https://`, not `http://` (mixed content is silently blocked by
the browser with no error surfaced in the app itself — check the browser console).

## Teardown

```bash
az group delete --name canvas-demo-rg --yes --no-wait
```

Deletes every resource created above (Postgres, App Service, storage account) in one shot.
