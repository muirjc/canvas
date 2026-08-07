#!/usr/bin/env bash
# Resume the canvas Azure environment after pause.sh (canvas-ycu, mirrors ADP's infra/azure/
# resume.sh). Reverses exactly what pause.sh did: starts Postgres, then restores canvas-api's
# normal scale settings, then waits for Postgres to actually be Ready rather than assuming
# instant availability.
#
# Usage: ./resume.sh [resource-group]

set -euo pipefail

RESOURCE_GROUP="${1:-canvas-rg}"

echo "== Starting canvas-postgres =="
az postgres flexible-server start --resource-group "$RESOURCE_GROUP" --name canvas-postgres --output none
echo "  Postgres start requested (takes a minute or two to become Ready)."

echo "== Restoring canvas-api scale settings =="
# canvas-api: minReplicas=0/maxReplicas=1 -- its normal scale-to-zero-eligible config
# (apiapp.bicep); this is NOT "always on", it just allows the platform to scale it up again on
# the next request instead of being hard-capped the way pause.sh left it (pause.sh's own change
# here is a near-no-op today for exactly this reason -- see its own comment).
az containerapp update --name canvas-api --resource-group "$RESOURCE_GROUP" \
  --min-replicas 0 --max-replicas 1 --output none
echo "  canvas-api restored to 0/1 (scales up on next request)."

echo
echo "== Waiting for Postgres to be Ready =="
until [[ "$(az postgres flexible-server show --resource-group "$RESOURCE_GROUP" --name canvas-postgres --query state -o tsv 2>/dev/null)" == "Ready" ]]; do
  sleep 10
  echo "  ... still starting"
done
echo "  Postgres is Ready."

echo
echo "== Resumed. canvas-api will take a few seconds to warm up on its next request. =="
