#!/usr/bin/env bash
# Deploy/update the canvas Azure environment (canvas-ycu, mirrors ADP's infra/azure/deploy.sh).
# Resource group, ACR, VNet, private Postgres, Key Vault + managed identity, Container Apps
# environment, API app, migration job, and a Storage static website for the frontend.
#
# Usage: ./deploy.sh [location]
#
# All secret VALUES (Postgres admin password, the assembled DATABASE_URL, SESSION_SECRET,
# ANTHROPIC_API_KEY/OPENAI_API_KEY) are written into Key Vault BEFORE the main deployment runs,
# not after -- the API container app deployed in the same template reads them via Key Vault
# secret references at provisioning time, so if they don't exist yet that deployment fails. This
# only works because Key Vault already exists from a prior run of this script; a genuine
# from-scratch rebuild needs two passes -- run once to create Key Vault (the API app module will
# fail that first time), then again once these secrets exist. Same two-pass shape ADP's own
# deploy.sh documents for the identical reason.
#
# Password-type secrets are cached locally in infra/azure/.secrets/ (gitignored, chmod 600) so
# re-running this script doesn't change them out from under an already-running server.
#
# The API image is tagged with the current git short SHA rather than a floating `:latest` --
# reusing the same tag string is a no-op in Container Apps' revision diffing (it won't re-pull
# even though the digest changed), a real gotcha ADP hit the hard way.

set -euo pipefail

LOCATION="${1:-eastus2}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SECRETS_DIR="$SCRIPT_DIR/.secrets"
PG_PASSWORD_FILE="$SECRETS_DIR/postgres-admin-password"
SESSION_SECRET_FILE="$SECRETS_DIR/session-secret"
RESOURCE_GROUP="canvas-rg"

mkdir -p "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR"

if [[ ! -f "$PG_PASSWORD_FILE" ]]; then
  echo "Generating Postgres admin password (first run) -> $PG_PASSWORD_FILE"
  openssl rand -base64 24 > "$PG_PASSWORD_FILE"
  chmod 600 "$PG_PASSWORD_FILE"
fi
PG_ADMIN_PASSWORD="$(cat "$PG_PASSWORD_FILE")"

if [[ ! -f "$SESSION_SECRET_FILE" ]]; then
  echo "Generating SESSION_SECRET (first run) -> $SESSION_SECRET_FILE"
  openssl rand -base64 32 > "$SESSION_SECRET_FILE"
  chmod 600 "$SESSION_SECRET_FILE"
fi
SESSION_SECRET="$(cat "$SESSION_SECRET_FILE")"

DEPLOYER_PRINCIPAL_ID="$(az ad signed-in-user show --query id -o tsv)"

API_IMAGE_TAG="$(cd "$REPO_ROOT" && git rev-parse --short HEAD)"
if ! git -C "$REPO_ROOT" diff --quiet 2>/dev/null || ! git -C "$REPO_ROOT" diff --cached --quiet 2>/dev/null; then
  API_IMAGE_TAG="${API_IMAGE_TAG}-dirty-$(date +%s)"
fi

EXISTING_KEY_VAULT="$(az keyvault list --resource-group "$RESOURCE_GROUP" --query "[0].name" -o tsv 2>/dev/null || true)"
EXISTING_ACR="$(az acr list --resource-group "$RESOURCE_GROUP" --query "[0].name" -o tsv 2>/dev/null || true)"
# Real frontend origin, once the storage account exists AND static website hosting has been
# enabled on it (see modules/storage.bicep's own comment for why this isn't predictable ahead of
# time the way ADP's Keycloak public URL is). Empty on a from-scratch first run; a subsequent run
# picks up the real value once step "Enabling static website hosting" below has run at least once.
EXISTING_STORAGE="$(az storage account list --resource-group "$RESOURCE_GROUP" --query "[0].name" -o tsv 2>/dev/null || true)"
WEB_ORIGIN=""
if [[ -n "$EXISTING_STORAGE" ]]; then
  WEB_ORIGIN="$(az storage account show --name "$EXISTING_STORAGE" --resource-group "$RESOURCE_GROUP" \
    --query "primaryEndpoints.web" -o tsv 2>/dev/null || true)"
  WEB_ORIGIN="${WEB_ORIGIN%/}"  # az returns a trailing slash; WEB_ORIGINS/CORS origin must not have one
fi

if [[ -n "$EXISTING_KEY_VAULT" ]]; then
  echo "== Pre-seeding secrets into existing Key Vault ($EXISTING_KEY_VAULT) =="
  az keyvault secret set --vault-name "$EXISTING_KEY_VAULT" --name "postgres-admin-password" \
    --value "$PG_ADMIN_PASSWORD" --output none
  az keyvault secret set --vault-name "$EXISTING_KEY_VAULT" --name "session-secret" \
    --value "$SESSION_SECRET" --output none
  echo "  postgres-admin-password, session-secret set."

  # The connection string needs the server's real FQDN/DB name; both are fixed/known after this
  # script's first-ever successful run, so a live lookup is safe even before this run's own
  # deployment happens.
  POSTGRES_FQDN="$(az postgres flexible-server show --resource-group "$RESOURCE_GROUP" \
    --name canvas-postgres --query "fullyQualifiedDomainName" -o tsv 2>/dev/null || true)"
  if [[ -n "$POSTGRES_FQDN" ]]; then
    DATABASE_URL="postgres://canvas_admin:${PG_ADMIN_PASSWORD}@${POSTGRES_FQDN}:5432/canvas?sslmode=require"
    az keyvault secret set --vault-name "$EXISTING_KEY_VAULT" --name "database-url" \
      --value "$DATABASE_URL" --output none
    echo "  database-url set."
  fi

  # AI provider keys are optional -- apiapp.bicep defaults AI_PROVIDER=mock (no real key needed)
  # until these are actually set to something real. Empty-string secrets are valid Key Vault
  # values and harmless as long as AI_PROVIDER stays "mock".
  if [[ -f "$REPO_ROOT/.env" ]]; then
    ANTHROPIC_KEY="$(grep -E '^ANTHROPIC_API_KEY=' "$REPO_ROOT/.env" 2>/dev/null | head -1 | cut -d= -f2-)"
    OPENAI_KEY="$(grep -E '^OPENAI_API_KEY=' "$REPO_ROOT/.env" 2>/dev/null | head -1 | cut -d= -f2-)"
  fi
  az keyvault secret set --vault-name "$EXISTING_KEY_VAULT" --name "anthropic-api-key" \
    --value "${ANTHROPIC_KEY:-unset}" --output none
  az keyvault secret set --vault-name "$EXISTING_KEY_VAULT" --name "openai-api-key" \
    --value "${OPENAI_KEY:-unset}" --output none
  echo "  anthropic-api-key, openai-api-key set (real values if found in .env, else a placeholder)."
else
  echo "== No existing Key Vault found -- skipping secret pre-seed (first-ever run) =="
fi

if [[ -n "$EXISTING_ACR" ]]; then
  echo "== Building API image (repo root Dockerfile) to $EXISTING_ACR, tag $API_IMAGE_TAG =="
  az acr build --registry "$EXISTING_ACR" --image "canvas-api:${API_IMAGE_TAG}" "$REPO_ROOT" --output none
else
  echo "== No existing ACR found -- skipping image build (first-ever run) =="
fi

echo "== What-if (dry run) =="
az deployment sub what-if \
  --name "canvas-foundation" \
  --location "$LOCATION" \
  --template-file "$SCRIPT_DIR/main.bicep" \
  --parameters location="$LOCATION" postgresAdminPassword="$PG_ADMIN_PASSWORD" \
    deployerPrincipalId="$DEPLOYER_PRINCIPAL_ID" apiImageTag="$API_IMAGE_TAG" webOrigin="$WEB_ORIGIN"

echo
read -r -p "Proceed with deployment? [y/N] " confirm
if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
  echo "Aborted."
  exit 1
fi

echo "== Deploying =="
az deployment sub create \
  --name "canvas-foundation" \
  --location "$LOCATION" \
  --template-file "$SCRIPT_DIR/main.bicep" \
  --parameters location="$LOCATION" postgresAdminPassword="$PG_ADMIN_PASSWORD" \
    deployerPrincipalId="$DEPLOYER_PRINCIPAL_ID" apiImageTag="$API_IMAGE_TAG" webOrigin="$WEB_ORIGIN" \
  --output table

STORAGE_ACCOUNT="$(az deployment sub show --name "canvas-foundation" --query "properties.outputs.storageAccountName.value" -o tsv)"
KEY_VAULT_NAME="$(az deployment sub show --name "canvas-foundation" --query "properties.outputs.keyVaultName.value" -o tsv)"
API_FQDN="$(az deployment sub show --name "canvas-foundation" --query "properties.outputs.apiFqdn.value" -o tsv)"
MIGRATION_JOB="$(az deployment sub show --name "canvas-foundation" --query "properties.outputs.migrationJobName.value" -o tsv)"

echo "== Enabling static website hosting on $STORAGE_ACCOUNT (data-plane -- no Bicep resource for this, see modules/storage.bicep) =="
# storage.bicep's Storage Blob Data Contributor role assignment for the deployer may have been
# created moments ago in the deployment just above -- Azure RBAC propagation is eventually
# consistent, typically seconds but occasionally a couple of minutes, so a --auth-mode login call
# immediately after can genuinely fail with an authorization error even though the assignment is
# correct and will succeed on retry. Not an issue on a re-run of this script (the role already
# existed), only ever bites the very first deploy.
for attempt in 1 2 3 4 5; do
  if az storage blob service-properties update \
    --account-name "$STORAGE_ACCOUNT" --auth-mode login \
    --static-website --index-document index.html --404-document index.html --output none 2>/tmp/canvas-deploy-blob-err; then
    break
  fi
  if [[ "$attempt" == 5 ]]; then
    echo "  Failed after 5 attempts -- likely a real permissions problem, not just RBAC propagation delay:"
    cat /tmp/canvas-deploy-blob-err >&2
    exit 1
  fi
  echo "  Attempt $attempt failed (likely RBAC propagation delay) -- retrying in 20s..."
  sleep 20
done
rm -f /tmp/canvas-deploy-blob-err

REAL_WEB_ORIGIN="$(az storage account show --name "$STORAGE_ACCOUNT" --resource-group "$RESOURCE_GROUP" \
  --query "primaryEndpoints.web" -o tsv)"
REAL_WEB_ORIGIN="${REAL_WEB_ORIGIN%/}"
if [[ "$REAL_WEB_ORIGIN" != "$WEB_ORIGIN" ]]; then
  echo "== Patching canvas-api's WEB_ORIGINS to the real static website URL ($REAL_WEB_ORIGIN) =="
  az containerapp update --name canvas-api --resource-group "$RESOURCE_GROUP" \
    --set-env-vars "WEB_ORIGINS=${REAL_WEB_ORIGIN}" --output none
fi

echo "== Building and deploying the frontend to $STORAGE_ACCOUNT =="
( cd "$REPO_ROOT" && npm ci && npm run build --workspace=@canvas/diagram-core && \
  VITE_API_BASE_URL="https://${API_FQDN}" npm run build --workspace=@canvas/web )
az storage blob upload-batch \
  --account-name "$STORAGE_ACCOUNT" --destination '$web' --source "$REPO_ROOT/apps/web/dist" \
  --auth-mode login --overwrite --output none

SEED_JOB="$(az deployment sub show --name "canvas-foundation" --query "properties.outputs.seedJobName.value" -o tsv)"

echo
echo "== Running database migrations (canvas-migrate job) =="
az containerapp job start --name "$MIGRATION_JOB" --resource-group "$RESOURCE_GROUP" --output none
echo "  Migration job started -- check status with:"
echo "    az containerapp job execution list --name $MIGRATION_JOB --resource-group $RESOURCE_GROUP -o table"

echo
echo "== Done =="
echo "  API:      https://${API_FQDN}"
echo "  Frontend: ${REAL_WEB_ORIGIN}"
echo "  Key Vault: $KEY_VAULT_NAME"
echo
echo "Once the migration job above completes, seed dev/demo data (full DiagramType catalog,"
echo "bundled icon libraries, one default project, one admin login) with:"
echo "  az containerapp job start --name $SEED_JOB --resource-group $RESOURCE_GROUP"
echo "NOT run automatically -- it creates a demo admin account with a published local password"
echo "(apps/api/src/seed/run.ts), appropriate for a throwaway/demo environment, not unprompted"
echo "on every deploy of something meant to hold real data."
