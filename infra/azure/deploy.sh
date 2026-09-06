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
KC_ADMIN_PASSWORD_FILE="$SECRETS_DIR/keycloak-admin-password"
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
  # Keycloak's own KC_DB_PASSWORD (modules/keycloak.bicep) passes this same value as a separate,
  # non-URL-embedded env var, so it was never at risk from this specific bug.
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

# canvas-ycu.1: Keycloak's own master-realm admin password, and the canvas-api confidential
# client's OIDC secret -- generated and cached exactly like the two secrets above, NEVER the
# infra/keycloak/CanvasRealm-realm.json dev placeholder ("canvas-dev-client-secret-do-not-use-
# in-production", named that for exactly this reason). The realm import only bakes that
# placeholder in on first boot; this script's post-deploy step further down (Reconciling
# Keycloak's canvas-api client) overwrites it on the running server to match this real value.
if [[ ! -f "$KC_ADMIN_PASSWORD_FILE" ]]; then
  echo "Generating Keycloak admin password (first run) -> $KC_ADMIN_PASSWORD_FILE"
  openssl rand -base64 24 > "$KC_ADMIN_PASSWORD_FILE"
  chmod 600 "$KC_ADMIN_PASSWORD_FILE"
fi
KC_ADMIN_PASSWORD="$(cat "$KC_ADMIN_PASSWORD_FILE")"

if [[ ! -f "$OIDC_CLIENT_SECRET_FILE" ]]; then
  echo "Generating OIDC client secret (first run) -> $OIDC_CLIENT_SECRET_FILE"
  openssl rand -base64 32 > "$OIDC_CLIENT_SECRET_FILE"
  chmod 600 "$OIDC_CLIENT_SECRET_FILE"
fi
OIDC_CLIENT_SECRET="$(cat "$OIDC_CLIENT_SECRET_FILE")"

DEPLOYER_PRINCIPAL_ID="$(az ad signed-in-user show --query id -o tsv)"

API_IMAGE_TAG="$(cd "$REPO_ROOT" && git rev-parse --short HEAD)"
if ! git -C "$REPO_ROOT" diff --quiet 2>/dev/null || ! git -C "$REPO_ROOT" diff --cached --quiet 2>/dev/null; then
  API_IMAGE_TAG="${API_IMAGE_TAG}-dirty-$(date +%s)"
fi

EXISTING_KEY_VAULT="$(az keyvault list --resource-group "$RESOURCE_GROUP" --query "[0].name" -o tsv 2>/dev/null || true)"
EXISTING_ACR="$(az acr list --resource-group "$RESOURCE_GROUP" --query "[0].name" -o tsv 2>/dev/null || true)"

# canvas-vp1: modules/keycloak.bicep's acrPullAssignment was being re-declared (and therefore
# re-PUT by ARM) on literally every run, since main.bicep redeploys that module every time
# regardless of which image tag changed -- and a role-assignment PUT with unchanged properties is
# not reliably a safe no-op (reproduced live: "RoleAssignmentExists", 4 times in a row, including
# immediately after deleting and letting a redeploy recreate it fresh). Rather than trying to make
# a second PUT of an already-existing assignment land safely, skip it entirely once it's already
# there: look up the shared identity (canvas-identity, created by modules/keyvault.bicep) and check
# for an existing AcrPull grant AT THE RESOURCE GROUP -- keycloak.bicep's own acrPullAssignment
# declares `scope: resourceGroup()`, not the ACR resource itself (broader than strictly needed, but
# that's what's actually declared and re-PUT each run, so this must check the same scope or it will
# never find what it's looking for -- confirmed live: an early version of this check queried the
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
  az keyvault secret set --vault-name "$EXISTING_KEY_VAULT" --name "keycloak-admin-password" \
    --value "$KC_ADMIN_PASSWORD" --output none
  az keyvault secret set --vault-name "$EXISTING_KEY_VAULT" --name "oidc-client-secret" \
    --value "$OIDC_CLIENT_SECRET" --output none
  echo "  postgres-admin-password, session-secret, keycloak-admin-password, oidc-client-secret set."

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

# Same commit -> same tag for both images (infra/keycloak/create-users.mjs now lives inside the
# API image too, and CanvasRealm-realm.json's own content is what the Keycloak image bakes in --
# both need a rebuild whenever either changes, and re-using API_IMAGE_TAG keeps that automatic
# rather than needing a second independent tag scheme).
KEYCLOAK_IMAGE_TAG="$API_IMAGE_TAG"

if [[ -n "$EXISTING_ACR" ]]; then
  echo "== Building API image (repo root Dockerfile) to $EXISTING_ACR, tag $API_IMAGE_TAG =="
  az acr build --registry "$EXISTING_ACR" --image "canvas-api:${API_IMAGE_TAG}" "$REPO_ROOT" --output none
  echo "== Building Keycloak image (infra/keycloak/) to $EXISTING_ACR, tag $KEYCLOAK_IMAGE_TAG =="
  az acr build --registry "$EXISTING_ACR" --image "canvas-keycloak:${KEYCLOAK_IMAGE_TAG}" \
    "$SCRIPT_DIR/../keycloak" --output none
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
    keycloakImageTag="$KEYCLOAK_IMAGE_TAG" webOrigin="$WEB_ORIGIN" grantAcrPull="$GRANT_ACR_PULL"

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
    keycloakImageTag="$KEYCLOAK_IMAGE_TAG" webOrigin="$WEB_ORIGIN" grantAcrPull="$GRANT_ACR_PULL" \
  --output table

STORAGE_ACCOUNT="$(az deployment sub show --name "canvas-foundation" --query "properties.outputs.storageAccountName.value" -o tsv)"
KEY_VAULT_NAME="$(az deployment sub show --name "canvas-foundation" --query "properties.outputs.keyVaultName.value" -o tsv)"
API_FQDN="$(az deployment sub show --name "canvas-foundation" --query "properties.outputs.apiFqdn.value" -o tsv)"
KEYCLOAK_FQDN="$(az deployment sub show --name "canvas-foundation" --query "properties.outputs.keycloakFqdn.value" -o tsv)"
KEYCLOAK_PUBLIC_BASE_URL="$(az deployment sub show --name "canvas-foundation" --query "properties.outputs.keycloakPublicBaseUrl.value" -o tsv)"
MIGRATION_JOB="$(az deployment sub show --name "canvas-foundation" --query "properties.outputs.migrationJobName.value" -o tsv)"
USERS_JOB="$(az deployment sub show --name "canvas-foundation" --query "properties.outputs.usersJobName.value" -o tsv)"

# canvas-ycu.1: reconcile the CanvasRealm-realm.json-imported canvas-api client's redirectUris/
# webOrigins/secret against reality. The image bakes in infra/keycloak/CanvasRealm-realm.json's
# own placeholder values (localhost redirect URI, the checked-in dev secret) -- correct for local
# docker-compose, but Keycloak's own default `start --import-realm` is IGNORE_EXISTING, so a
# realm that already exists from a prior run of this script is never re-imported even after
# rebuilding the image with different baked-in values. The only way to correct an already-running
# realm's client, on every run (not just the first), is this admin-API PATCH -- talked to over
# canvas-api's own /idp/* reverse proxy (apps/api/src/auth/idp-proxy.routes.ts), since Keycloak
# itself has internal-only ingress and this script runs from outside the VNet.
echo "== Reconciling Keycloak's canvas-api client (redirect URI, web origin, client secret) =="
KC_ADMIN_TOKEN=""
for attempt in 1 2 3 4 5 6; do
  KC_ADMIN_TOKEN="$(curl -s -f -X POST "https://${API_FQDN}/idp/realms/master/protocol/openid-connect/token" \
    -d grant_type=password -d client_id=admin-cli \
    -d username=admin -d password="$KC_ADMIN_PASSWORD" \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])" 2>/dev/null || true)"
  if [[ -n "$KC_ADMIN_TOKEN" ]]; then
    break
  fi
  if [[ "$attempt" == 6 ]]; then
    echo "  WARNING: could not reach Keycloak's admin token endpoint after 6 attempts -- skipping"
    echo "  client reconciliation. SSO login will use whatever redirectUris/secret are already"
    echo "  imported (likely wrong on a first deploy) until you re-run this script."
  else
    echo "  Attempt $attempt: Keycloak not reachable/ready yet -- retrying in 15s..."
    sleep 15
  fi
done

if [[ -n "$KC_ADMIN_TOKEN" ]]; then
  KC_CLIENT_ID="$(curl -s -f "https://${API_FQDN}/idp/admin/realms/CanvasRealm/clients?clientId=canvas-api" \
    -H "Authorization: Bearer $KC_ADMIN_TOKEN" | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['id'])")"
  python3 -c "
import json, urllib.request

api_fqdn = '$API_FQDN'
client_id = '$KC_CLIENT_ID'
token = '$KC_ADMIN_TOKEN'
secret = '''$OIDC_CLIENT_SECRET'''

url = f'https://{api_fqdn}/idp/admin/realms/CanvasRealm/clients/{client_id}'
req = urllib.request.Request(url, headers={'Authorization': f'Bearer {token}'})
with urllib.request.urlopen(req) as resp:
    client = json.load(resp)

client['redirectUris'] = [f'https://{api_fqdn}/auth/callback']
client['webOrigins'] = [f'https://{api_fqdn}']
client['secret'] = secret

body = json.dumps(client).encode()
req = urllib.request.Request(url, data=body, method='PUT', headers={
    'Authorization': f'Bearer {token}',
    'Content-Type': 'application/json',
})
with urllib.request.urlopen(req) as resp:
    pass
print('  canvas-api client redirectUris/webOrigins/secret updated.')
"
fi

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
echo "  Keycloak: ${KEYCLOAK_PUBLIC_BASE_URL} (internal-ingress -- only reachable through the"
echo "            above /idp reverse proxy, never directly; internal FQDN: ${KEYCLOAK_FQDN})"
echo "  Key Vault: $KEY_VAULT_NAME"
echo
echo "Once the migration job above completes, seed dev/demo data (full DiagramType catalog,"
echo "bundled icon libraries, one default project, one admin login) with:"
echo "  az containerapp job start --name $SEED_JOB --resource-group $RESOURCE_GROUP"
echo "NOT run automatically -- it creates a demo admin account with a published local password"
echo "(apps/api/src/seed/run.ts), appropriate for a throwaway/demo environment, not unprompted"
echo "on every deploy of something meant to hold real data."
echo
echo "ALLOW_LOCAL_AUTH defaults to false for this deployment (apiapp.bicep) -- create real"
echo "accounts in Keycloak (infra/keycloak/create-users.mjs, run as the canvas-keycloak-users"
echo "job) before anyone can sign in. KC_USERS is real user data, so it's supplied per-invocation,"
echo "never baked into this template or state:"
echo '  az containerapp job start --name '"$USERS_JOB"' --resource-group '"$RESOURCE_GROUP"' \'
echo '    --env-vars KC_USERS='"'"'[{"username":"jane","email":"jane@example.com","password":"...","role":"architect"}]'"'"''
echo "role is one of admin/architect/viewer (apps/api/src/auth/oidc.ts's mapRealmRolesToUserRole)."
echo "Each new user's first login is forced through Keycloak's own MFA (TOTP) enrollment --"
echo "requiredActions is set explicitly per user by the script itself (see its own header comment"
echo "for why the realm's defaultAction alone doesn't reach admin-API-created users)."
