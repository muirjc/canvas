#!/usr/bin/env bash
# Pause the canvas Azure environment (canvas-ycu, mirrors ADP's infra/azure/pause.sh) -- a
# cheaper middle ground between fully torn down (destroy.sh) and running 24/7: stops the compute
# you pay for while KEEPING all data/config, so a later resume.sh brings everything back exactly
# as it was (no rebuild, no re-migration).
#
# What this pauses (stops costing money):
#   - canvas-postgres compute (`az postgres flexible-server stop`) -- Azure auto-restarts a
#     stopped Flexible Server after 7 days if not resumed manually, so this is meant for short
#     gaps (overnight, a few days), not indefinite storage.
#   - canvas-api container app compute (min=0/max=1 -- Container Apps rejects max-replicas=0
#     outright, so "paused" means "eligible to scale to zero", not a hard-forced zero). It's
#     already min=0/max=1 normally (apiapp.bicep) and scales down on its own when idle, so this
#     script is mostly a no-op for it.
#
# What STILL costs money while paused (small, but non-zero):
#   - Postgres storage (the 32GB volume itself, ~$4/month) and backups.
#   - ACR image storage (Basic SKU, ~$5/month regardless of activity).
#   - Key Vault (~$0.03/10k operations -- negligible at rest).
#   - Storage account (the frontend static website) -- effectively free at rest, no compute to
#     pause; blob storage + bandwidth are the only costs and both are near-zero when idle. It
#     keeps serving, so canvas-vnh swaps in a "Canvas is paused" page (paused.html) -- see below.
#   - Log Analytics workspace (pay-per-GB ingested; near-zero once apps are quiet).
#
# Usage: ./pause.sh [resource-group]

set -euo pipefail

RESOURCE_GROUP="${1:-canvas-rg}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# canvas-myh: retry + wait_for_postgres, so pausing right after resume.sh (resources still busy)
# or after Azure's 7-day auto-restart works instead of stopping half way.
source "$SCRIPT_DIR/lib.sh"

# canvas-vnh: with the database stopped the app can't sign anyone in, so serve a "Canvas is paused"
# page instead of a login screen that silently fails. The site's 404 document is index.html too,
# so deep links (?projectId=...) show it as well. The live index.html is saved as index.live.html
# for resume.sh -- only if no saved copy exists yet, so pausing twice can't overwrite the real
# page with the paused one.
STORAGE_ACCOUNT="$(az storage account list --resource-group "$RESOURCE_GROUP" --query "[0].name" -o tsv)"
echo "== Taking the web site offline (paused page) =="
if [[ "$(az storage blob exists --account-name "$STORAGE_ACCOUNT" --container-name '$web' --name index.live.html \
  --auth-mode login --query exists -o tsv)" == "true" ]]; then
  echo "  Already showing the paused page (index.live.html is saved) -- leaving it."
else
  live_copy="$(mktemp)"
  az storage blob download --account-name "$STORAGE_ACCOUNT" --container-name '$web' --name index.html \
    --file "$live_copy" --auth-mode login --no-progress --output none
  az storage blob upload --account-name "$STORAGE_ACCOUNT" --container-name '$web' --name index.live.html \
    --file "$live_copy" --content-type "text/html" --content-cache-control "no-cache" \
    --auth-mode login --overwrite --no-progress --output none
  rm -f "$live_copy"
  az storage blob upload --account-name "$STORAGE_ACCOUNT" --container-name '$web' --name index.html \
    --file "$SCRIPT_DIR/paused.html" --content-type "text/html; charset=utf-8" --content-cache-control "no-cache" \
    --auth-mode login --overwrite --no-progress --output none
  echo "  The site now shows 'Canvas is paused'; the app's page is saved as index.live.html."
fi

echo "== Making canvas-api eligible to scale to zero =="
retry "Updating canvas-api" az containerapp update --name canvas-api --resource-group "$RESOURCE_GROUP" \
  --min-replicas 0 --max-replicas 1 --output none
echo "  Set to min=0/max=1. Actual replica count drops to 0 after the environment's cooldown"
echo "  period (~5 min) once traffic stops -- not instant. Confirm with:"
echo "    az containerapp replica list --name canvas-api --resource-group $RESOURCE_GROUP"

# canvas-3s5.2: the GitHub sync job would fail every 15 minutes against a stopped database. The CLI
# can't suspend a scheduled job, so move it to once a year; resume.sh (and deploy.sh) restore it.
if az containerapp job show --name canvas-github-sync --resource-group "$RESOURCE_GROUP" --output none 2>/dev/null; then
  echo "== Pausing the GitHub sync job (schedule moved to once a year) =="
  retry "Updating canvas-github-sync" az containerapp job update --name canvas-github-sync --resource-group "$RESOURCE_GROUP" \
    --cron-expression "0 0 1 1 *" --output none
fi

# canvas-ne2y: the same for the nightly purge job.
if az containerapp job show --name canvas-purge --resource-group "$RESOURCE_GROUP" --output none 2>/dev/null; then
  echo "== Pausing the nightly purge job (schedule moved to once a year) =="
  retry "Updating canvas-purge" az containerapp job update --name canvas-purge --resource-group "$RESOURCE_GROUP" \
    --cron-expression "0 0 1 1 *" --output none
fi

echo "== Stopping canvas-postgres (compute only -- storage/data retained) =="
POSTGRES_STATE="$(wait_for_postgres "$RESOURCE_GROUP" canvas-postgres)"
if [[ "$POSTGRES_STATE" == "Stopped" ]]; then
  echo "  Already stopped -- nothing to do."
else
  retry "Stopping canvas-postgres" az postgres flexible-server stop --resource-group "$RESOURCE_GROUP" --name canvas-postgres --output none
  echo "  Postgres stopped."
fi

echo
echo "== Paused. Run resume.sh to bring the environment back. =="
echo "Reminder: Azure auto-restarts a stopped Postgres Flexible Server after 7 days -- if you're"
echo "pausing longer than that, re-run pause.sh to stop it again."
