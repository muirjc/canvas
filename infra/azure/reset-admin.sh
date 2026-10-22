#!/usr/bin/env bash
# canvas-ez1.3: recovery for a local-mode environment (AUTH_MODE=local) whose only admin can't sign
# in -- forgotten password, deactivated, demoted, or locked out (canvas-ez1.4). Gives the
# account a new one-time password and makes it an active, unlocked admin again, signed out everywhere; the
# admin then signs in with it and chooses a new password. Nothing else in the database changes.
#
# Usage: ./reset-admin.sh [email] [resource-group]
#   email defaults to the first admin (infra/azure/.secrets/admin-email). The new one-time password
#   is written to infra/azure/.secrets/bootstrap-admin-password -- never printed.
#
# How: runs the canvas-bootstrap-admin job once with BOOTSTRAP_MODE=reset (it normally runs in
# 'create' mode, which leaves an existing account alone), then puts the job back. Needs the
# environment resumed (Postgres running).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SECRETS_DIR="$SCRIPT_DIR/.secrets"
ADMIN_EMAIL_FILE="$SECRETS_DIR/admin-email"
BOOTSTRAP_PASSWORD_FILE="$SECRETS_DIR/bootstrap-admin-password"
JOB=canvas-bootstrap-admin

DEFAULT_EMAIL="$(cat "$ADMIN_EMAIL_FILE" 2>/dev/null || true)"
EMAIL="${1:-$DEFAULT_EMAIL}"
RESOURCE_GROUP="${2:-canvas-rg}"
if [[ -z "$EMAIL" ]]; then
  echo "ERROR: no email given and no $ADMIN_EMAIL_FILE." >&2
  exit 1
fi

if ! az containerapp job show --name "$JOB" --resource-group "$RESOURCE_GROUP" --query name -o tsv >/dev/null 2>&1; then
  echo "ERROR: no $JOB job in $RESOURCE_GROUP -- this environment isn't in local mode (AUTH_MODE=local)." >&2
  exit 1
fi
if [[ "$(az postgres flexible-server show --resource-group "$RESOURCE_GROUP" --name canvas-postgres \
  --query state -o tsv 2>/dev/null)" != "Ready" ]]; then
  echo "ERROR: canvas-postgres isn't running -- run ./resume.sh first." >&2
  exit 1
fi

echo "== New one-time password for $EMAIL =="
openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 20 > "$BOOTSTRAP_PASSWORD_FILE"
chmod 600 "$BOOTSTRAP_PASSWORD_FILE"
KEY_VAULT_NAME="$(az keyvault list --resource-group "$RESOURCE_GROUP" --query "[0].name" -o tsv)"
az keyvault secret set --vault-name "$KEY_VAULT_NAME" --name bootstrap-admin-password \
  --file "$BOOTSTRAP_PASSWORD_FILE" --output none
# Container Apps caches a Key Vault reference's value (canvas-28j): make the job re-read it.
IDENTITY_ID="$(az identity show --resource-group "$RESOURCE_GROUP" --name canvas-identity --query id -o tsv)"
KV_URI="$(az keyvault show --name "$KEY_VAULT_NAME" --query properties.vaultUri -o tsv)"
az containerapp job secret set --name "$JOB" --resource-group "$RESOURCE_GROUP" --output none \
  --secrets "bootstrap-admin-password=keyvaultref:${KV_URI}secrets/bootstrap-admin-password,identityref:${IDENTITY_ID}"

# Always put the job back in create mode for the first admin, even if the reset fails.
restore_job() {
  az containerapp job update --name "$JOB" --resource-group "$RESOURCE_GROUP" --output none \
    --set-env-vars "BOOTSTRAP_MODE=create" "BOOTSTRAP_ADMIN_EMAIL=${DEFAULT_EMAIL:-$EMAIL}"
}
trap restore_job EXIT
az containerapp job update --name "$JOB" --resource-group "$RESOURCE_GROUP" --output none \
  --set-env-vars "BOOTSTRAP_MODE=reset" "BOOTSTRAP_ADMIN_EMAIL=$EMAIL"

EXECUTION="$(az containerapp job start --name "$JOB" --resource-group "$RESOURCE_GROUP" --query name -o tsv)"
echo "  Running $JOB in reset mode (execution $EXECUTION)..."
while true; do
  status="$(az containerapp job execution show --name "$JOB" --job-execution-name "$EXECUTION" \
    --resource-group "$RESOURCE_GROUP" --query properties.status -o tsv 2>/dev/null || true)"
  case "$status" in
    Succeeded) break ;;
    Failed)
      echo "  Reset FAILED -- see: az containerapp job execution list --name $JOB --resource-group $RESOURCE_GROUP -o table" >&2
      exit 1 ;;
    *) sleep 5 ;;
  esac
done

echo
echo "Done. $EMAIL is an active admin, signed out everywhere. Sign in with the one-time password in"
echo "  $BOOTSTRAP_PASSWORD_FILE"
echo "and choose a new one."
