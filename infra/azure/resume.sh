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

# canvas-vnh / canvas-r3y: take canvas-api out of paused mode, last, so the site only comes back
# once the database it needs is up.
echo
echo "== Bringing the web site back =="
if [[ "$(az containerapp show --name canvas-api --resource-group "$RESOURCE_GROUP" \
  --query "properties.template.containers[0].env[?name=='CANVAS_PAUSED'] | length(@)" -o tsv)" != "0" ]]; then
  retry "Updating canvas-api" az containerapp update --name canvas-api --resource-group "$RESOURCE_GROUP" \
    --remove-env-vars CANVAS_PAUSED --output none
  echo "  The app is back."
else
  echo "  Not in paused mode -- nothing to restore."
fi

echo
# canvas-3s5.2: pause.sh moved the GitHub sync job's schedule to once a year.
if az containerapp job show --name canvas-github-sync --resource-group "$RESOURCE_GROUP" --output none 2>/dev/null; then
  echo "== Restoring the GitHub sync job's schedule (every 15 minutes) =="
  retry "Updating canvas-github-sync" az containerapp job update --name canvas-github-sync --resource-group "$RESOURCE_GROUP" \
    --cron-expression "*/15 * * * *" --output none
fi

# canvas-ne2y: and the nightly purge job's.
if az containerapp job show --name canvas-purge --resource-group "$RESOURCE_GROUP" --output none 2>/dev/null; then
  echo "== Restoring the nightly purge job's schedule (03:00 UTC) =="
  retry "Updating canvas-purge" az containerapp job update --name canvas-purge --resource-group "$RESOURCE_GROUP" \
    --cron-expression "0 3 * * *" --output none
fi

echo "== Resumed. canvas-api will take a few seconds to warm up on its next request. =="
