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
#   - Storage account (now only the old web address's redirect page, canvas-r3y) -- effectively
#     free at rest.
#   - Log Analytics workspace (pay-per-GB ingested; near-zero once apps are quiet).
#
# Usage: ./pause.sh [resource-group]

set -euo pipefail

RESOURCE_GROUP="${1:-canvas-rg}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# canvas-myh: retry + wait_for_postgres, so pausing right after resume.sh (resources still busy)
# or after Azure's 7-day auto-restart works instead of stopping half way.
source "$SCRIPT_DIR/lib.sh"

# canvas-vnh / canvas-r3y: with the database stopped the app can't sign anyone in, so canvas-api
# (which serves the web app) answers every request with the "Canvas is paused" page (browsers) or
# a 503 (API calls) while CANVAS_PAUSED=true. Set together with the scale settings below: one
# revision. resume.sh removes it once the database is back.
echo "== Making canvas-api eligible to scale to zero =="
retry "Updating canvas-api" az containerapp update --name canvas-api --resource-group "$RESOURCE_GROUP" \
  --min-replicas 0 --max-replicas 1 --set-env-vars CANVAS_PAUSED=true --output none
echo "  The site now shows 'Canvas is paused'."
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
