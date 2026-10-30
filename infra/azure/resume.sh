#!/usr/bin/env bash
# Resume the canvas Azure environment after pause.sh (canvas-ycu, mirrors ADP's infra/azure/
# resume.sh). Reverses exactly what pause.sh did: starts Postgres, then restores canvas-api's
# normal scale settings, then waits for Postgres to actually be Ready rather than assuming
# instant availability.
#
# Usage: ./resume.sh [resource-group]

set -euo pipefail

RESOURCE_GROUP="${1:-canvas-rg}"
# canvas-myh: retry + wait_for_postgres, so resuming an already-running server (e.g. after Azure's
# 7-day auto-restart) or one still stopping works instead of failing with ServerIsNotStopped.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

echo "== Starting canvas-postgres =="
POSTGRES_STATE="$(wait_for_postgres "$RESOURCE_GROUP" canvas-postgres)"
if [[ "$POSTGRES_STATE" == "Ready" ]]; then
  echo "  Already running -- nothing to start."
else
  retry "Starting canvas-postgres" az postgres flexible-server start --resource-group "$RESOURCE_GROUP" --name canvas-postgres --output none
  echo "  Postgres start requested (takes a minute or two to become Ready)."
fi

echo "== Restoring canvas-api scale settings =="
# canvas-api: minReplicas=0/maxReplicas=1 -- its normal scale-to-zero-eligible config
# (apiapp.bicep); this is NOT "always on", it just allows the platform to scale it up again on
# the next request instead of being hard-capped the way pause.sh left it (pause.sh's own change
# here is a near-no-op today for exactly this reason -- see its own comment).
retry "Updating canvas-api" az containerapp update --name canvas-api --resource-group "$RESOURCE_GROUP" \
  --min-replicas 0 --max-replicas 1 --output none
echo "  canvas-api restored to 0/1 (scales up on next request)."

echo
echo "== Waiting for Postgres to be Ready =="
if [[ "$(wait_for_postgres "$RESOURCE_GROUP" canvas-postgres)" != "Ready" ]]; then
  echo "  canvas-postgres settled as Stopped, not Ready -- run resume.sh again." >&2
  exit 1
fi
echo "  Postgres is Ready."

# canvas-vnh: put the app's page back (pause.sh saved it as index.live.html), last, so the site
# only comes back once the database it needs is up.
STORAGE_ACCOUNT="$(az storage account list --resource-group "$RESOURCE_GROUP" --query "[0].name" -o tsv)"
echo
echo "== Bringing the web site back =="
if [[ "$(az storage blob exists --account-name "$STORAGE_ACCOUNT" --container-name '$web' --name index.live.html \
  --auth-mode login --query exists -o tsv)" == "true" ]]; then
  live_copy="$(mktemp)"
  az storage blob download --account-name "$STORAGE_ACCOUNT" --container-name '$web' --name index.live.html \
    --file "$live_copy" --auth-mode login --no-progress --output none
  az storage blob upload --account-name "$STORAGE_ACCOUNT" --container-name '$web' --name index.html \
    --file "$live_copy" --content-type "text/html" --content-cache-control "no-cache" \
    --auth-mode login --overwrite --no-progress --output none
  rm -f "$live_copy"
  az storage blob delete --account-name "$STORAGE_ACCOUNT" --container-name '$web' --name index.live.html \
    --auth-mode login --output none
  echo "  The app is back (index.html restored from index.live.html)."
else
  echo "  No paused page in place -- nothing to restore."
fi

echo
# canvas-3s5.2: pause.sh moved the GitHub sync job's schedule to once a year.
if az containerapp job show --name canvas-github-sync --resource-group "$RESOURCE_GROUP" --output none 2>/dev/null; then
  echo "== Restoring the GitHub sync job's schedule (every 15 minutes) =="
  retry "Updating canvas-github-sync" az containerapp job update --name canvas-github-sync --resource-group "$RESOURCE_GROUP" \
    --cron-expression "*/15 * * * *" --output none
fi

echo "== Resumed. canvas-api will take a few seconds to warm up on its next request. =="
