#!/usr/bin/env bash
# Deploy/update the canvas Azure environment (canvas-ycu, mirrors ADP's infra/azure/deploy.sh).
# Resource group, ACR, VNet, private Postgres, Key Vault + managed identity, Container Apps
# environment, API app, migration job, and a Storage static website for the frontend.
#
# Usage: ENTRA_CLIENT_ID=<id> [ENTRA_TENANT_ID=<id>] [ENTRA_CLIENT_SECRET=<secret>] \
#        [AI_PROVIDER=mock|anthropic|openai] [ANTHROPIC_API_KEY=<key>] [OPENAI_API_KEY=<key>] \
#        ./deploy.sh [location]
#
# canvas-haz: ENTRA_CLIENT_ID (required) and ENTRA_CLIENT_SECRET (required on first run only --
# cached afterward in infra/azure/.secrets/oidc-client-secret) come from the "canvas-azure" Entra
# app registration -- see RUNBOOK.md's "Entra ID SSO" section for the one-time setup steps that
# produce them. ENTRA_TENANT_ID defaults to the deploying subscription's own tenant.
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

# centralus (2026-10-08): eastus2 hit repeated Postgres SkuNotAvailable for Standard_B1ms; moved
# here (matching ADP) rather than paying for a bigger SKU.
LOCATION="${1:-centralus}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SECRETS_DIR="$SCRIPT_DIR/.secrets"
PG_PASSWORD_FILE="$SECRETS_DIR/postgres-admin-password"
SESSION_SECRET_FILE="$SECRETS_DIR/session-secret"
OIDC_CLIENT_SECRET_FILE="$SECRETS_DIR/oidc-client-secret"
RESOURCE_GROUP="canvas-rg"

mkdir -p "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR"

if [[ ! -f "$PG_PASSWORD_FILE" ]]; then
  echo "Generating Postgres admin password (first run) -> $PG_PASSWORD_FILE"
  # Alphanumeric-only, not raw base64: this password gets embedded directly in the DATABASE_URL
  # connection string canvas-migrate/canvas-api build (postgres://user:PASSWORD@host/db) -- a
  # real deploy hit this the hard way: pg-connection-string's parser uses a strict WHATWG URL(),
  # and base64's own +/= (and occasionally /) characters are not valid unescaped there, so a
  # generated password containing one silently broke every DB connection with "TypeError: Invalid
  # URL" until this was diagnosed. Filtering to [A-Za-z0-9] avoids the whole class of "needs
  # percent-encoding" bugs rather than adding escaping logic; 24 alphanumeric characters is still
  # ~140 bits of entropy, comfortably above Azure Postgres Flexible Server's own complexity floor
  # (needs 3 of upper/lower/digit/special -- alphanumeric alone already covers upper+lower+digit).
  openssl rand -base64 32 | tr -dc 'A-Za-z0-9' | head -c 24 > "$PG_PASSWORD_FILE"
  chmod 600 "$PG_PASSWORD_FILE"
fi
PG_ADMIN_PASSWORD="$(cat "$PG_PASSWORD_FILE")"

if [[ ! -f "$SESSION_SECRET_FILE" ]]; then
  echo "Generating SESSION_SECRET (first run) -> $SESSION_SECRET_FILE"
  openssl rand -base64 32 > "$SESSION_SECRET_FILE"
  chmod 600 "$SESSION_SECRET_FILE"
fi
SESSION_SECRET="$(cat "$SESSION_SECRET_FILE")"

# canvas-haz: unlike the self-hosted Keycloak this replaced (whose client secret this script could
# freely generate itself, since it also owned reconciling that value into Keycloak's own running
# config), Entra ID generates the "canvas-azure" app registration's client secret itself -- there
# is no local-generate-and-push-to-the-IdP step possible here, only "the operator copies the real
# value out of the Entra portal/`az ad app credential reset` once" (RUNBOOK.md's "Entra ID SSO"
# section has the one-time setup steps). ENTRA_CLIENT_SECRET, if set, is cached to this same file
# exactly like the other secrets above so it only needs to be supplied once; if neither is present
# this is a hard error, not a silently-generated-and-therefore-useless placeholder.
if [[ -n "${ENTRA_CLIENT_SECRET:-}" ]]; then
  printf '%s' "$ENTRA_CLIENT_SECRET" > "$OIDC_CLIENT_SECRET_FILE"
  chmod 600 "$OIDC_CLIENT_SECRET_FILE"
elif [[ ! -f "$OIDC_CLIENT_SECRET_FILE" ]]; then
  echo "ERROR: no Entra client secret found." >&2
  echo "Set ENTRA_CLIENT_SECRET to the 'canvas-azure' app registration's client secret value" >&2
  echo "(generated once in the Entra portal or via 'az ad app credential reset' -- this script" >&2
  echo "cannot generate it the way it could for the self-hosted Keycloak this replaced), or place" >&2
  echo "it directly in $OIDC_CLIENT_SECRET_FILE." >&2
  exit 1
fi
OIDC_CLIENT_SECRET="$(cat "$OIDC_CLIENT_SECRET_FILE")"

# canvas-brq: AI provider + keys. Previously AI_PROVIDER was hardwired to mock (main.bicep never
# forwarded apiapp.bicep's aiProvider param) and the keys were read from a repo-root .env that
# doesn't exist in this repo (the real dev key lives in apps/api/.env), so Key Vault only ever got
# the "unset" placeholder. Same caching shape as ENTRA_CLIENT_SECRET above: an env var, if set, is
# written to .secrets/ so it only has to be supplied once; the provider choice is cached too, so a
# routine re-run without AI_PROVIDER doesn't silently flip a live environment back to mock.
AI_PROVIDER_FILE="$SECRETS_DIR/ai-provider"
ANTHROPIC_KEY_FILE="$SECRETS_DIR/anthropic-api-key"
OPENAI_KEY_FILE="$SECRETS_DIR/openai-api-key"
for pair in "AI_PROVIDER:$AI_PROVIDER_FILE" "ANTHROPIC_API_KEY:$ANTHROPIC_KEY_FILE" "OPENAI_API_KEY:$OPENAI_KEY_FILE"; do
  var="${pair%%:*}"; file="${pair#*:}"
  if [[ -n "${!var:-}" ]]; then
    printf '%s' "${!var}" > "$file"
    chmod 600 "$file"
  fi
done
AI_PROVIDER="$(cat "$AI_PROVIDER_FILE" 2>/dev/null || echo mock)"
ANTHROPIC_KEY="$(cat "$ANTHROPIC_KEY_FILE" 2>/dev/null || true)"
OPENAI_KEY="$(cat "$OPENAI_KEY_FILE" 2>/dev/null || true)"
case "$AI_PROVIDER" in
  mock) ;;
  anthropic)
    [[ -n "$ANTHROPIC_KEY" ]] || { echo "ERROR: AI_PROVIDER=anthropic but no Anthropic key -- set ANTHROPIC_API_KEY (cached to $ANTHROPIC_KEY_FILE)." >&2; exit 1; }
    # A placeholder (e.g. a dev .env's dummy value) deploys "successfully" and then fails every
    # chat with a 401 from Anthropic -- happened on canvas-brq's first deploy.
    [[ "$ANTHROPIC_KEY" == sk-ant-* ]] || echo "WARNING: the Anthropic key doesn't start with 'sk-ant-' -- likely a placeholder; AI chat will fail." >&2
    ;;
  openai) [[ -n "$OPENAI_KEY" ]] || { echo "ERROR: AI_PROVIDER=openai but no OpenAI key -- set OPENAI_API_KEY (cached to $OPENAI_KEY_FILE)." >&2; exit 1; } ;;
  *) echo "ERROR: AI_PROVIDER must be mock, anthropic or openai (got: $AI_PROVIDER)." >&2; exit 1 ;;
esac

# Defaults to the deploying subscription's own tenant, matching main.bicep's own entraTenantId
# default -- override only if the app registration lives in a different tenant.
ENTRA_TENANT_ID="${ENTRA_TENANT_ID:-$(az account show --query tenantId -o tsv)}"

if [[ -z "${ENTRA_CLIENT_ID:-}" ]]; then
  echo "ERROR: ENTRA_CLIENT_ID is required -- the 'canvas-azure' Entra app registration's" >&2
  echo "Application (client) ID. See RUNBOOK.md's 'Entra ID SSO' section for the one-time setup" >&2
  echo "steps that produce this value." >&2
  exit 1
fi

DEPLOYER_PRINCIPAL_ID="$(az ad signed-in-user show --query id -o tsv)"

API_IMAGE_TAG="$(cd "$REPO_ROOT" && git rev-parse --short HEAD)"
if ! git -C "$REPO_ROOT" diff --quiet 2>/dev/null || ! git -C "$REPO_ROOT" diff --cached --quiet 2>/dev/null; then
  API_IMAGE_TAG="${API_IMAGE_TAG}-dirty-$(date +%s)"
fi

EXISTING_KEY_VAULT="$(az keyvault list --resource-group "$RESOURCE_GROUP" --query "[0].name" -o tsv 2>/dev/null || true)"
EXISTING_ACR="$(az acr list --resource-group "$RESOURCE_GROUP" --query "[0].name" -o tsv 2>/dev/null || true)"

# canvas-vp1: modules/keyvault.bicep's acrPullAssignment (originally declared in the now-deleted
# modules/keycloak.bicep, moved here by canvas-haz -- see that module's own header comment) was
# being re-declared (and therefore re-PUT by ARM) on literally every run, since main.bicep
# redeploys every module every time regardless of which image tag changed -- and a role-assignment
# PUT with unchanged properties is not reliably a safe no-op (reproduced live: "RoleAssignmentExists",
# 4 times in a row, including immediately after deleting and letting a redeploy recreate it fresh).
# Rather than trying to make a second PUT of an already-existing assignment land safely, skip it
# entirely once it's already there: look up the shared identity (canvas-identity, created by
# modules/keyvault.bicep) and check for an existing AcrPull grant AT THE RESOURCE GROUP --
# acrPullAssignment declares `scope: resourceGroup()`, not the ACR resource itself (broader than
# strictly needed, but that's what's actually declared and re-PUT each run, so this must check the
# same scope or it will never find what it's looking for -- confirmed live: an early version of
# this check queried the
# ACR's own resource ID and always came back empty even with the grant present one level up).
GRANT_ACR_PULL="true"
EXISTING_IDENTITY_PRINCIPAL_ID="$(az identity show --resource-group "$RESOURCE_GROUP" --name canvas-identity \
  --query principalId -o tsv 2>/dev/null || true)"
if [[ -n "$EXISTING_IDENTITY_PRINCIPAL_ID" ]]; then
  EXISTING_ACR_PULL_ASSIGNMENT="$(az role assignment list --assignee "$EXISTING_IDENTITY_PRINCIPAL_ID" \
    --resource-group "$RESOURCE_GROUP" --role AcrPull --query "[0].id" -o tsv 2>/dev/null || true)"
  if [[ -n "$EXISTING_ACR_PULL_ASSIGNMENT" ]]; then
    GRANT_ACR_PULL="false"
    echo "== Identity already holds AcrPull on $RESOURCE_GROUP -- skipping role assignment this run =="
  fi
fi
# Real frontend origin, once the storage account exists AND static website hosting has been
# enabled on it (see modules/storage.bicep's own comment for why this isn't predictable ahead of
# time the way canvas-api's own apiPublicBaseUrl is). Empty on a from-scratch first run; a
# subsequent run picks up the real value once step "Enabling static website hosting" below has run
# at least once.
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
  az keyvault secret set --vault-name "$EXISTING_KEY_VAULT" --name "oidc-client-secret" \
    --value "$OIDC_CLIENT_SECRET" --output none
  echo "  postgres-admin-password, session-secret, oidc-client-secret set."

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

  # A provider without a real key is rejected up front (canvas-brq, above), so "unset" only ever
  # lands here for a provider that isn't in use.
  az keyvault secret set --vault-name "$EXISTING_KEY_VAULT" --name "anthropic-api-key" \
    --value "${ANTHROPIC_KEY:-unset}" --output none
  az keyvault secret set --vault-name "$EXISTING_KEY_VAULT" --name "openai-api-key" \
    --value "${OPENAI_KEY:-unset}" --output none
  echo "  anthropic-api-key, openai-api-key set (AI_PROVIDER=$AI_PROVIDER)."
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
    deployerPrincipalId="$DEPLOYER_PRINCIPAL_ID" apiImageTag="$API_IMAGE_TAG" \
    webOrigin="$WEB_ORIGIN" grantAcrPull="$GRANT_ACR_PULL" \
    entraTenantId="$ENTRA_TENANT_ID" entraClientId="$ENTRA_CLIENT_ID" aiProvider="$AI_PROVIDER"

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
    deployerPrincipalId="$DEPLOYER_PRINCIPAL_ID" apiImageTag="$API_IMAGE_TAG" \
    webOrigin="$WEB_ORIGIN" grantAcrPull="$GRANT_ACR_PULL" \
    entraTenantId="$ENTRA_TENANT_ID" entraClientId="$ENTRA_CLIENT_ID" aiProvider="$AI_PROVIDER" \
  --output table

STORAGE_ACCOUNT="$(az deployment sub show --name "canvas-foundation" --query "properties.outputs.storageAccountName.value" -o tsv)"
KEY_VAULT_NAME="$(az deployment sub show --name "canvas-foundation" --query "properties.outputs.keyVaultName.value" -o tsv)"
API_FQDN="$(az deployment sub show --name "canvas-foundation" --query "properties.outputs.apiFqdn.value" -o tsv)"
MIGRATION_JOB="$(az deployment sub show --name "canvas-foundation" --query "properties.outputs.migrationJobName.value" -o tsv)"
OIDC_REDIRECT_URI="$(az deployment sub show --name "canvas-foundation" --query "properties.outputs.oidcRedirectUri.value" -o tsv)"

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
CATALOG_SEED_JOB="$(az deployment sub show --name "canvas-foundation" --query "properties.outputs.catalogSeedJobName.value" -o tsv)"

# Polls a Container Apps Job execution until it reaches a terminal state, failing the whole
# deploy (set -e) if the job itself fails -- a clean build with a failed migration or an empty
# DiagramType catalog is not actually a working environment, so this script shouldn't report
# success and hand that back to the caller silently.
wait_for_job_execution() {
  local job_name="$1" execution_name="$2" label="$3" status=""
  echo "  Waiting for $label (execution $execution_name)..."
  while true; do
    status="$(az containerapp job execution show --name "$job_name" --job-execution-name "$execution_name" \
      --resource-group "$RESOURCE_GROUP" --query "properties.status" -o tsv 2>/dev/null || true)"
    case "$status" in
      Succeeded)
        echo "  $label succeeded."
        return 0
        ;;
      Failed)
        echo "  $label FAILED -- inspect its logs, then re-run this script once fixed:" >&2
        echo "    az containerapp job execution list --name $job_name --resource-group $RESOURCE_GROUP -o table" >&2
        return 1
        ;;
      *)
        sleep 5
        ;;
    esac
  done
}

echo
echo "== Running database migrations (canvas-migrate job) =="
MIGRATION_EXECUTION="$(az containerapp job start --name "$MIGRATION_JOB" --resource-group "$RESOURCE_GROUP" --query name -o tsv)"
wait_for_job_execution "$MIGRATION_JOB" "$MIGRATION_EXECUTION" "Migration job"

echo
echo "== Seeding reference/lookup data (canvas-seed-catalog job: DiagramTypes, icon/shape" \
     "libraries, AiPersonas) =="
echo "  Runs unconditionally, unlike canvas-seed below -- this is idempotent catalog data a" \
     "fresh environment needs to be usable at all, not demo content."
CATALOG_SEED_EXECUTION="$(az containerapp job start --name "$CATALOG_SEED_JOB" --resource-group "$RESOURCE_GROUP" --query name -o tsv)"
wait_for_job_execution "$CATALOG_SEED_JOB" "$CATALOG_SEED_EXECUTION" "Catalog seed job"

echo
echo "== Done =="
echo "  API:      https://${API_FQDN}"
echo "  Frontend: ${REAL_WEB_ORIGIN}"
echo "  Key Vault: $KEY_VAULT_NAME"
echo
echo "The DiagramType catalog, bundled icon/shape libraries, and default AiPersonas are already"
echo "seeded (canvas-seed-catalog, above) -- the environment is usable as-is. To additionally seed"
echo "throwaway dev/demo content (one default project, one admin login) on top of that, run:"
echo "  az containerapp job start --name $SEED_JOB --resource-group $RESOURCE_GROUP"
echo "NOT run automatically -- it creates a demo admin account with a published local password"
echo "(apps/api/src/seed/run.ts), appropriate for a throwaway/demo environment, not unprompted"
echo "on every deploy of something meant to hold real data."
echo
echo "== Entra app registration -- action required =="
echo "ALLOW_LOCAL_AUTH defaults to false for this deployment (apiapp.bicep) -- Entra ID sign-in is"
echo "the only way in until you register this environment's real addresses on the 'canvas-azure'"
echo "app registration's Authentication blade (Web platform). Unlike the self-hosted Keycloak this"
echo "replaced, there is no admin REST API this script can PATCH on your behalf -- Graph API"
echo "write access for app registrations is a broader permission than this script should assume it"
echo "has, so this is a manual one-time step per environment (RUNBOOK.md's 'Entra ID SSO' section"
echo "has the full walkthrough). Entra has one Redirect URIs list per app registration serving"
echo "both sign-in and post-logout redirects -- add BOTH of these to it:"
echo "  Sign-in callback:   ${OIDC_REDIRECT_URI}"
echo "  Post-logout target: ${REAL_WEB_ORIGIN}"
echo
echo "Ready-to-paste (replaces the app registration's ENTIRE redirect URI list -- include any"
echo "other environments' URIs you still need, e.g. the 'canvas-dev' localhost ones, in the same"
echo "command if so):"
echo "  az ad app update --id \"$ENTRA_CLIENT_ID\" --web-redirect-uris \"${OIDC_REDIRECT_URI}\" \"${REAL_WEB_ORIGIN}\""
echo
echo "App roles (admin/architect/viewer -- apps/api/src/auth/types.ts's UserRole) and user/group"
echo "assignment are also managed entirely in the Entra portal; see RUNBOOK.md for the full"
echo "one-time app-registration setup this environment depends on."
