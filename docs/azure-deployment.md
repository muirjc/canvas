# Deploying to Azure (quick demo path)

> **For anything longer-lived than a quick demo, use `infra/azure/` instead** (canvas-ycu) — a
> version-controlled Bicep IaC deployment with a private (no public network access) Postgres
> server, secrets in Key Vault, and `deploy.sh`/`pause.sh`/`resume.sh`/`destroy.sh` lifecycle
> scripts. See `infra/azure/README.md`. This document is kept for a fast, disposable,
> no-tooling-required demo only — it opens Postgres to the entire internet
> (`--public-access 0.0.0.0-255.255.255.255`) and has no lifecycle management beyond a single
> `az group delete`.

A minimal, no-Dockerfile path to a working Canvas deployment on Azure: PostgreSQL Flexible
Server and one App Service (Linux, Python 3.13) that runs the API (`apps/api-py`) and serves the
built web app from the same address, as the `infra/azure/` deployment does. One origin means the
default cookie settings work; `COOKIE_SECURE`/`COOKIE_SAME_SITE` (see `RUNBOOK.md`) stay unset.

This is a demo/throwaway-friendly path, not a hardened production topology. It has no CI/CD
wiring, no custom domain/TLS cert, and uses the platform's built-in free HTTPS on
`*.azurewebsites.net`. It has not been run end to end since the backend became Python (phase 12 of
canvas-1bty); expect to adjust a step.

## Prerequisites

- `az` CLI installed and logged in (`az login`) with a subscription that has Contributor access.
- Node 22 and uv on the deploying machine, as in the repo's `README.md` "Getting started" section.
  Docker is not needed.

## 1. Resource group

```bash
az group create --name canvas-demo-rg --location eastus
```

If you hit `ERROR: The location is restricted from performing this operation` or a `0` VM quota
error on later steps, your subscription may have zero compute quota in that region — this is
common on subscriptions that have never requested a quota increase. Try `eastus2`, `westus2`,
`centralus`, or `westus3` for the compute-bearing resources (App Service Plan) specifically;
region choice for Postgres is unaffected by this and doesn't need to
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

Then run the migration and demo seed jobs against it from `apps/api-py` (`sslmode=require` is
mandatory — Azure Flexible Server rejects unencrypted connections):

```bash
cd apps/api-py && uv sync
export DATABASE_URL="postgres://canvasadmin:<password>@canvas-demo-pg-<unique-suffix>.postgres.database.azure.com:5432/canvas?sslmode=require"
export SESSION_SECRET="<any real secret, >=32 chars>"
uv run python -m canvas_api.jobs.migrate
uv run python -m canvas_api.jobs.seed_demo   # prints the seeded admin login + a project id
```

## 3. Build the package

The App Service runs the Python service from a zip: the service's source and migrations, a
`requirements.txt` exported from `uv.lock` (App Service installs from it during deployment), and
the built web app.

```bash
npm ci
npm run build --workspace=@canvas/diagram-core
VITE_API_BASE_URL= npm run build --workspace=@canvas/web   # relative API URLs: same origin

rm -rf deploy && mkdir deploy
cp -r apps/api-py/src apps/api-py/migrations deploy/
cp -r apps/web/dist deploy/web
(cd apps/api-py && uv export --frozen --no-dev --no-emit-project --no-hashes -o ../../deploy/requirements.txt)
(cd deploy && zip -r ../api-deploy.zip .)
```

## 4. App Service

```bash
az appservice plan create \
  --resource-group canvas-demo-rg \
  --name canvas-demo-plan \
  --location westus2 \
  --is-linux --sku B1   # or F1 (free) for a pure throwaway demo

az webapp create \
  --resource-group canvas-demo-rg \
  --plan canvas-demo-plan \
  --name canvas-demo-<unique-suffix> \
  --runtime "PYTHON:3.13"

az webapp config appsettings set \
  --resource-group canvas-demo-rg \
  --name canvas-demo-<unique-suffix> \
  --settings \
    DATABASE_URL="postgres://canvasadmin:<password>@canvas-demo-pg-<unique-suffix>.postgres.database.azure.com:5432/canvas?sslmode=require" \
    SESSION_SECRET="<the same secret used for migrate/seed>" \
    ALLOW_LOCAL_AUTH=true \
    WEB_ORIGINS="https://canvas-demo-<unique-suffix>.azurewebsites.net" \
    WEB_DIST_DIR=web \
    SCM_DO_BUILD_DURING_DEPLOYMENT=true

az webapp config set \
  --resource-group canvas-demo-rg \
  --name canvas-demo-<unique-suffix> \
  --startup-file "uvicorn --app-dir src canvas_api.main:app --host 0.0.0.0 --port 8000 --proxy-headers --forwarded-allow-ips '*'"

az webapp deploy \
  --resource-group canvas-demo-rg \
  --name canvas-demo-<unique-suffix> \
  --src-path api-deploy.zip --type zip
```

`WEB_DIST_DIR=web` and `--app-dir src` are relative to the folder the app runs from (the zip's
root). The service only serves web files that exist when it starts.

Verify: `curl https://canvas-demo-<unique-suffix>.azurewebsites.net/health` → `{"status":"ok"}`.

## 5. Verify end to end

Open `https://canvas-demo-<unique-suffix>.azurewebsites.net` in a browser and sign in with the
admin credentials the seed printed in step 2. If the page loads but API calls fail, check that the
web app was built with an empty `VITE_API_BASE_URL` (step 3), so it calls its own origin.

## Teardown

```bash
az group delete --name canvas-demo-rg --yes --no-wait
```

Deletes every resource created above (Postgres, App Service) in one shot.
